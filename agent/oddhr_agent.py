"""ODD HR PC 에이전트: 카톡 대화방 점검 → 할 일 제안 대기열.

Claude 모델을 부르지 않는다. 판정은 규칙 엔진(oddhr_extract)이 하고,
config에서 켜면 애매한 것만 이 PC의 로컬 모델(Ollama)이 다시 본다.

데이터 위치: %LOCALAPPDATA%\\ODD-HR
  config.json   감시할 대화방, 팀원 이름과 역할, 로컬 모델 설정
  agent.db      판정한 메시지(중복 방지), 올릴 제안 대기열, 실행 기록
  outbox\\       Desk에 파일로 가져올 때 쓰는 제안 파일 (최근 것만 보관)

실행:
  ... -m kakaotalk_mcp.oddhr_agent scan      한 번 점검
  ... -m kakaotalk_mcp.oddhr_agent watch     상주하며 interval_sec(기본 180초 = 3분)마다 점검
  ... -m kakaotalk_mcp.oddhr_agent status    상태 보기
  ... -m kakaotalk_mcp.oddhr_agent stop      상주 감시 끄기
설치 스크립트가 로그인할 때 watch를 창 없이(pythonw) 띄우도록 Windows 작업 스케줄러에 등록한다.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sqlite3
import sys
import time
from contextlib import contextmanager
from pathlib import Path

try:
    from .oddhr_extract import classify, dedupe_key, parse_kakao_date, project_for, urgency_for, find_due
    from .oddhr_llm import LocalModel
except ImportError:  # 개발용 단독 실행
    from oddhr_extract import classify, dedupe_key, parse_kakao_date, project_for, urgency_for, find_due  # type: ignore
    from oddhr_llm import LocalModel  # type: ignore

def _default_home() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "ODD-HR-agent"
    return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "ODD-HR"


HOME = Path(os.environ.get("ODD_HR_HOME") or _default_home())
CONFIG = HOME / "config.json"
DB = HOME / "agent.db"
OUTBOX = HOME / "outbox"
LOCK = HOME / "scan.lock"
WATCH_PID = HOME / "watch.pid"
STOP_FLAG = HOME / "watch.stop"
LOG = HOME / "agent.log"

DEFAULT_CONFIG = {
    "rooms": [],
    "members": {},
    "projects": {},
    "llm": {"enabled": False, "model": "exaone3.5:7.8b", "url": "http://127.0.0.1:11434"},
    "keep_outbox": 14,
    "interval_sec": 180,
    "room_projects": {},
    # Mac: 카톡 '대화 내보내기' 파일을 넣어 두면 자동으로 읽는 폴더, 열린 대화방 창을 직접 읽기(실험)
    "mac_export_dir": str(Path.home() / "Documents" / "ODD HR 카톡"),
    "mac_live": False,
}
AMBIGUOUS = {"할 일 신호 없음", "질문만 있음", "제안이지 확정 아님"}


# ---------------------------------------------------------------- 설정과 저장소
def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG.exists():
        try:
            cfg.update(json.loads(CONFIG.read_text(encoding="utf-8-sig")))
        except ValueError as e:
            raise SystemExit(f"config.json을 읽지 못했습니다: {e}")
    return cfg


def save_config(cfg: dict) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def connect() -> sqlite3.Connection:
    HOME.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.executescript("""
    CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, room TEXT, verdict TEXT, reason TEXT, at TEXT);
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, key TEXT UNIQUE, room TEXT, fields TEXT, created_at TEXT, synced_at TEXT);
    CREATE TABLE IF NOT EXISTS flags (id TEXT PRIMARY KEY, room TEXT, msg_date TEXT, msg_time TEXT, created_at TEXT, synced_at TEXT);
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, room TEXT, read_n INTEGER, new_n INTEGER,
                                     tasks_n INTEGER, flags_n INTEGER, engine TEXT, error TEXT);
    """)
    return con


def doc_id(prefix: str, key: str) -> str:
    return f"{prefix}-{hashlib.sha1(key.encode('utf-8')).hexdigest()[:20]}"


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


@contextmanager
def scan_lock(wait: float = 30.0):
    """여러 프로세스(상주 감시, Desk의 즉시 점검, 수동 실행)가 동시에 카톡 창과 클립보드를 쓰지 않게 한다."""
    HOME.mkdir(parents=True, exist_ok=True)
    fh = open(LOCK, "a+")
    got = False
    deadline = time.monotonic() + wait
    try:
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                got = True
                break
            except OSError:
                if time.monotonic() > deadline:
                    break
                time.sleep(0.5)
        yield got
    finally:
        if got:
            try:
                if os.name == "nt":
                    import msvcrt
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        fh.close()


def log(line: str) -> None:
    try:
        HOME.mkdir(parents=True, exist_ok=True)
        if LOG.exists() and LOG.stat().st_size > 512_000:
            LOG.replace(HOME / "agent.log.1")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{now_iso()} {line}\n")
    except OSError:
        pass


# ---------------------------------------------------------------- 판정 한 건
def judge(msg: dict, room: str, cfg: dict, llm: LocalModel | None) -> tuple[str, dict | None, str]:
    """→ (판정, Desk에 올릴 필드 또는 None, 이유)"""
    ref = parse_kakao_date(msg.get("date", "")) or dt.date.today()
    v = classify(msg, ref=ref, members=cfg.get("members") or {}, room=room, projects=cfg.get("projects") or None)
    engine = "규칙"
    if llm and (v.reason in AMBIGUOUS or v.confidence == "낮음"):
        got = llm.judge(msg.get("sender", ""), msg.get("text", ""))
        if got:
            engine = "규칙 + 로컬 모델"
            if got["verdict"] == "PM 확인 필요":
                return "PM 확인 필요", None, "로컬 모델: 민감한 내용"
            if got["verdict"] == "할 일" and v.verdict != "할 일":
                due = find_due(msg.get("text", ""), ref)
                v.verdict, v.reason, v.kind = "할 일", "로컬 모델 판정", "모델"
                v.title = got["title"] or v.title or msg.get("text", "")[:40]
                v.role = got["role"]
                v.due = due.isoformat() if due else None
                v.urgency = urgency_for(due, ref)
                v.confidence = "중간"
                v.project = project_for(msg.get("text", ""), room, cfg.get("projects") or None)
    if v.verdict != "할 일":
        return v.verdict, None, v.reason

    sender = msg.get("sender", "")
    fields = {
        "할 일": v.title,
        "상태": "제안",
        "프로젝트": (cfg.get("room_projects") or {}).get(room) or v.project,
        "담당 역할": v.role,
        "출처": "카카오톡",
        "대화방": room,
        "근거 메시지": f"{msg.get('date', '')} {msg.get('time', '')} {sender}: {msg.get('text', '')}".strip()[:600],
        "확신도": v.confidence,
        "중복 키": dedupe_key(msg),
        "작성": "ODD HR 작성",
        "판정": f"{engine} · {v.reason}",
        "생성": now_iso(),
    }
    if v.kind in ("약속", "필요") and sender and sender not in ("PM", "기획", "디자인", "촬영", "편집"):
        fields["담당자"] = sender
    if v.due:
        fields["마감"] = v.due
    if v.urgency:
        fields["긴급도"] = v.urgency
    return "할 일", fields, v.reason


# ---------------------------------------------------------------- 점검
def scan(rooms: list[str] | None = None, messages_by_room: dict[str, list[dict]] | None = None, trigger: str = "수동") -> dict:
    """대화방을 읽고 새 메시지를 판정해 대기열에 넣는다.
    messages_by_room을 주면 카카오톡 대신 그 메시지로 판정한다 (테스트용)."""
    with scan_lock() as got:
        if not got:
            return {"ok": False, "error": "다른 점검이 아직 돌고 있습니다. 잠시 뒤 다시 누르세요.", "rooms": []}
        rep = _scan(rooms, messages_by_room)
    rep["trigger"] = trigger
    log(f"[{trigger}] " + "; ".join(f"{r['room']} 새 {r['new']} 제안 {r['tasks']} 확인 {r['flags']}" + (f" 실패 {r['error']}" if r["error"] else "") for r in rep.get("rooms", [])) + (f" {rep['error']}" if rep.get("error") else ""))
    return rep


def _scan(rooms: list[str] | None, messages_by_room: dict[str, list[dict]] | None) -> dict:
    cfg = load_config()
    rooms = rooms or cfg.get("rooms") or list((messages_by_room or {}).keys())
    if not rooms:
        return {"ok": False, "error": "감시할 대화방이 없습니다. ODD HR 앱의 설정 → 카톡 에이전트에서 대화방 이름을 넣고 저장하세요."}
    llm = LocalModel(cfg.get("llm"))
    llm = llm if llm.available() else None
    con = connect()
    report = {"ok": True, "rooms": [], "engine": "규칙 + 로컬 모델" if llm else "규칙"}
    for room in rooms:
        r = {"room": room, "read": 0, "new": 0, "tasks": 0, "flags": 0, "due_soon": 0, "error": None}
        try:
            if messages_by_room is not None:
                msgs = messages_by_room.get(room, [])
            else:
                try:
                    from . import kakao  # Windows 전용
                except ImportError:
                    from kakaotalk_mcp import kakao  # type: ignore
                if hasattr(kakao, "configure"):
                    kakao.configure(cfg)          # Mac: 내보내기 폴더, 실시간 읽기 설정
                if room not in kakao.list_chat_windows():
                    kakao.open_chat(room)
                msgs = kakao.read_messages(room, 0)
            r["read"] = len(msgs)
            today = dt.date.today()
            for msg in msgs:
                key = dedupe_key(msg)
                if con.execute("SELECT 1 FROM seen WHERE key=?", (key,)).fetchone():
                    continue
                r["new"] += 1
                verdict, fields, reason = judge(msg, room, cfg, llm)
                con.execute("INSERT OR IGNORE INTO seen VALUES (?,?,?,?,?)", (key, room, verdict, reason, now_iso()))
                if fields:
                    con.execute("INSERT OR IGNORE INTO proposals VALUES (?,?,?,?,?,NULL)",
                                (doc_id("kakao", key), key, room, json.dumps(fields, ensure_ascii=False), now_iso()))
                    r["tasks"] += 1
                    if fields.get("마감") and (dt.date.fromisoformat(fields["마감"]) - today).days <= 3:
                        r["due_soon"] += 1
                elif verdict == "PM 확인 필요":
                    # 원문은 저장하지 않는다. 언제, 어느 방이었는지만 남긴다.
                    con.execute("INSERT OR IGNORE INTO flags VALUES (?,?,?,?,?,NULL)",
                                (doc_id("flag", key), room, msg.get("date", ""), msg.get("time", ""), now_iso()))
                    r["flags"] += 1
            con.commit()
        except Exception as e:  # 카톡이 꺼져 있거나 창을 못 찾음
            r["error"] = str(e) or e.__class__.__name__
        con.execute("INSERT INTO runs (at, room, read_n, new_n, tasks_n, flags_n, engine, error) VALUES (?,?,?,?,?,?,?,?)",
                    (now_iso(), room, r["read"], r["new"], r["tasks"], r["flags"], report["engine"], r["error"]))
        con.commit()
        report["rooms"].append(r)
    if llm is None and (cfg.get("llm") or {}).get("enabled"):
        report["llm_note"] = LocalModel(cfg.get("llm")).error or "로컬 모델을 쓸 수 없어 규칙만 썼습니다."
    report["outbox"] = write_outbox(con, cfg)
    con.close()
    return report


# ---------------------------------------------------------------- Desk로 넘기기
def pending(limit: int = 200) -> dict:
    con = connect()
    props = [{"id": row["id"], "fields": json.loads(row["fields"])}
             for row in con.execute("SELECT id, fields FROM proposals WHERE synced_at IS NULL ORDER BY created_at LIMIT ?", (limit,))]
    flags = [{"id": row["id"], "fields": {"대화방": row["room"], "날짜": row["msg_date"], "시각": row["msg_time"],
                                          "내용": "민감할 수 있는 메시지 1건 (원문은 옮기지 않음)", "상태": "확인 전", "생성": row["created_at"]}}
             for row in con.execute("SELECT * FROM flags WHERE synced_at IS NULL ORDER BY created_at LIMIT ?", (limit,))]
    con.close()
    return {"proposals": props, "flags": flags}


def mark_synced(ids: list[str]) -> dict:
    con = connect()
    at = now_iso()
    n = 0
    for i in ids:
        n += con.execute("UPDATE proposals SET synced_at=? WHERE id=? AND synced_at IS NULL", (at, i)).rowcount
        n += con.execute("UPDATE flags SET synced_at=? WHERE id=? AND synced_at IS NULL", (at, i)).rowcount
    con.commit()
    con.close()
    return {"marked": n}


def write_outbox(con: sqlite3.Connection, cfg: dict) -> str | None:
    """아직 Desk로 안 넘어간 제안 전체를 파일 하나로 쓴다. Desk의 '파일에서 가져오기'로 올린다."""
    data = pending()
    if not data["proposals"] and not data["flags"]:
        return None
    OUTBOX.mkdir(parents=True, exist_ok=True)
    path = OUTBOX / f"ODD-HR-제안-{dt.datetime.now():%Y%m%d-%H%M}.json"
    path.write_text(json.dumps({"format": "odd-hr-proposals", "version": 1, "created": now_iso(), **data},
                               ensure_ascii=False, indent=1), encoding="utf-8")
    files = sorted(OUTBOX.glob("ODD-HR-제안-*.json"))
    for old in files[: max(0, len(files) - int(cfg.get("keep_outbox", 14)))]:
        try:
            old.unlink()
        except OSError:
            pass
    return str(path)


def status() -> dict:
    cfg = load_config()
    con = connect()
    runs = [dict(r) for r in con.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 5")]
    waiting = con.execute("SELECT COUNT(*) FROM proposals WHERE synced_at IS NULL").fetchone()[0]
    flags = con.execute("SELECT COUNT(*) FROM flags WHERE synced_at IS NULL").fetchone()[0]
    seen = con.execute("SELECT COUNT(*) FROM seen").fetchone()[0]
    con.close()
    llm = LocalModel(cfg.get("llm"))
    return {
        "watch": watch_info(),
        "interval_sec": int(cfg.get("interval_sec") or 180),
        "rooms": cfg.get("rooms") or [],
        "engine": "규칙 + 로컬 모델" if llm.available() else "규칙",
        "llm": {"enabled": llm.enabled, "model": llm.model, "note": llm.error},
        "waiting": waiting, "flags_waiting": flags, "seen": seen, "recent_runs": runs,
        "home": str(HOME),
    }


# ---------------------------------------------------------------- 상주 감시
def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def watch_info() -> dict:
    try:
        data = json.loads(WATCH_PID.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"running": False}
    alive = _pid_alive(int(data.get("pid", 0)))
    return {"running": alive, "since": data.get("since"), "last": data.get("last"), "next": data.get("next") if alive else None}


def watch(interval: int | None = None, max_rounds: int | None = None) -> int:
    """interval초마다 점검한다. 이미 다른 감시가 돌고 있으면 바로 끝난다."""
    info = watch_info()
    if info.get("running"):
        print("이미 상주 감시가 돌고 있습니다.")
        return 0
    try:
        STOP_FLAG.unlink()
    except OSError:
        pass
    since = now_iso()
    rounds = 0
    log(f"상주 감시 시작 (pid {os.getpid()})")
    while True:
        cfg = load_config()
        every = max(60, int(interval or cfg.get("interval_sec") or 180))
        try:
            scan(trigger="자동")
        except Exception as e:  # 감시는 죽지 않는다
            log(f"[자동] 오류: {e}")
        rounds += 1
        nxt = dt.datetime.now().astimezone() + dt.timedelta(seconds=every)
        try:
            WATCH_PID.write_text(json.dumps({"pid": os.getpid(), "since": since, "last": now_iso(), "next": nxt.isoformat(timespec="seconds")}), encoding="utf-8")
        except OSError:
            pass
        if max_rounds and rounds >= max_rounds:
            break
        end = time.monotonic() + every
        while time.monotonic() < end:
            if STOP_FLAG.exists():
                log("상주 감시 종료 (stop)")
                try:
                    STOP_FLAG.unlink(); WATCH_PID.unlink()
                except OSError:
                    pass
                return 0
            time.sleep(2)
    return 0


CONFIG_KEYS = {"rooms", "members", "projects", "llm", "interval_sec", "room_projects", "keep_outbox", "mac_export_dir", "mac_live"}


def json_command(cmd: str, args: list[str]) -> dict:
    """ODD HR 앱이 부르는 명령. 결과를 JSON 하나로 돌려준다."""
    if cmd == "status":
        return status()
    if cmd == "pending":
        return pending(int(args[0]) if args and args[0].isdigit() else 200)
    if cmd == "mark-synced":
        return mark_synced([a for a in args if a])
    if cmd == "scan":
        return scan(trigger=args[0] if args else "앱")
    if cmd == "config-get":
        return {"config": load_config()}
    if cmd == "config-set":
        patch = json.loads(args[0]) if args else {}
        if not isinstance(patch, dict):
            raise ValueError("설정은 JSON 객체여야 합니다")
        cfg = load_config()
        for k, v in patch.items():
            if k in CONFIG_KEYS:
                cfg[k] = v
        cfg["interval_sec"] = max(60, int(cfg.get("interval_sec") or 180))
        save_config(cfg)
        return {"config": cfg}
    raise ValueError(f"모르는 명령: {cmd}")


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if argv and argv[0] == "--json":
        # 앱 전용: 결과를 표준 출력에 JSON 한 줄로
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        try:
            out = {"ok": True, "result": json_command(argv[1] if len(argv) > 1 else "status", argv[2:])}
        except Exception as e:
            out = {"ok": False, "error": str(e) or e.__class__.__name__}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        return 0 if out["ok"] else 1
    cmd = argv[0] if argv else "scan"
    if sys.stdout is None:  # pythonw: 창 없이 실행
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
        sys.stderr = sys.stdout
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if cmd == "scan":
        rep = scan(argv[1:] or None)
        for r in rep.get("rooms", []):
            if r["error"]:
                print(f"[{r['room']}] 실패: {r['error']}")
            else:
                print(f"[{r['room']}] 읽은 메시지 {r['read']}, 새 메시지 {r['new']}, 새 제안 {r['tasks']}, "
                      f"마감 3일 이내 {r['due_soon']}, PM 확인 필요 {r['flags']}")
        if rep.get("error"):
            print(rep["error"])
        if rep.get("llm_note"):
            print(rep["llm_note"])
        print(f"판정: {rep.get('engine')}. Claude 크레딧 사용 없음.")
        if rep.get("outbox"):
            print(f"Desk로 가져갈 파일: {rep['outbox']}")
        return 0 if rep.get("ok") else 1
    if cmd == "watch":
        return watch(int(argv[1]) if len(argv) > 1 and argv[1].isdigit() else None)
    if cmd == "stop":
        HOME.mkdir(parents=True, exist_ok=True)
        STOP_FLAG.write_text("stop", encoding="utf-8")
        print("상주 감시에 멈춤 신호를 보냈습니다. 몇 초 안에 멈춥니다.")
        return 0
    if cmd == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=2))
        return 0
    if cmd == "set-rooms":
        cfg = load_config()
        cfg["rooms"] = [r for r in argv[1:] if r.strip()]
        save_config(cfg)
        print("감시할 대화방:", ", ".join(cfg["rooms"]) or "(없음)")
        return 0
    if cmd == "set-members":
        # 예: set-members 홍길동=편집 김철수=촬영
        cfg = load_config()
        members = dict(cfg.get("members") or {})
        for pair in argv[1:]:
            if "=" in pair:
                name, role = pair.split("=", 1)
                if role.strip() in ("PM", "기획", "디자인", "촬영", "편집"):
                    members[name.strip()] = role.strip()
        cfg["members"] = members
        save_config(cfg)
        print("팀원 역할:", ", ".join(f"{k}={v}" for k, v in members.items()) or "(없음)")
        return 0
    if cmd == "set-llm":
        # 예: set-llm on exaone3.5:7.8b  /  set-llm off
        cfg = load_config()
        llm = dict(cfg.get("llm") or {})
        llm["enabled"] = len(argv) > 1 and argv[1] == "on"
        if len(argv) > 2:
            llm["model"] = argv[2]
        cfg["llm"] = llm
        save_config(cfg)
        m = LocalModel(llm)
        print("로컬 모델:", "켜짐" if m.enabled else "꺼짐", m.model, "" if not m.enabled or m.available() else f"(지금은 쓸 수 없음: {m.error})")
        return 0
    if cmd == "set-interval":
        cfg = load_config()
        cfg["interval_sec"] = max(60, int(argv[1])) if len(argv) > 1 and argv[1].isdigit() else 180
        save_config(cfg)
        print(f"점검 간격: {cfg['interval_sec']}초 (상주 감시는 다음 회차부터 적용)")
        return 0
    print("사용법: oddhr_agent [scan [대화방...] | watch [초] | stop | status | set-rooms 대화방... | set-members 이름=역할... | set-llm on|off [모델] | set-interval 초]")
    return 2


if __name__ == "__main__":
    sys.exit(main())
