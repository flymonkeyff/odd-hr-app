"""Mac용 카카오톡 읽기 (Windows의 kakao.py와 같은 함수 이름).

Mac 카카오톡은 Windows처럼 대화 창의 글을 바깥 프로그램에 내주지 않는다. 그래서 두 가지 길을 쓴다.

1. 내보내기 폴더 (기본, 확실함)
   카카오톡 대화방 → 오른쪽 위 메뉴(≡) → '대화 내용 내보내기' → '텍스트로 저장'으로 만든 .txt 파일을
   ~/Documents/ODD HR 카톡 폴더(설정에서 바꿈)에 넣어 두면, 점검할 때마다 새로 생긴 메시지를 읽는다.
   파일 이름이나 첫 줄의 대화방 이름이 감시할 대화방 이름과 같아야 한다.

2. 열린 창 직접 읽기 (실험)
   설정에서 켜면, 점검할 때 카카오톡을 잠깐 앞으로 가져와 대화 창을 전체 선택·복사해 읽고 클립보드를 되돌린다.
   ODD HR 앱에 '손쉬운 사용' 권한이 필요하다 (시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용).
   점검 순간 키보드 입력이 카카오톡으로 갈 수 있어, 쓰는 중이면 점검 간격을 길게 둔다.

카카오톡에는 아무것도 보내지 않는다.
"""
from __future__ import annotations

import re
import subprocess
import time
import unicodedata
from pathlib import Path

try:
    from .parse import parse_messages as _parse_pc  # 같은 꾸러미에 있으면 쓴다
except Exception:  # pragma: no cover
    _parse_pc = None

_cfg: dict = {}


def configure(cfg: dict) -> None:
    global _cfg
    _cfg = cfg or {}


def _export_dir() -> Path:
    return Path(_cfg.get("mac_export_dir") or (Path.home() / "Documents" / "ODD HR 카톡")).expanduser()


# ---------------------------------------------------------------- 내보내기 파일 읽기
PC_LINE = re.compile(r"^\[(?P<sender>[^\]]+)\] \[(?P<time>(?:오전|오후) \d{1,2}:\d{2})\] ?(?P<text>.*)$")
PC_DATE = re.compile(r"^-*\s*(?P<d>\d{4}년 \d{1,2}월 \d{1,2}일(?: [월화수목금토일]요일)?)\s*-*$")
# 모바일·Mac 내보내기: "2026년 11월 10일 오후 3:10, 홍길동 : 메시지"  또는  "2026. 11. 10. 오후 3:10, 홍길동 : 메시지"
MOB_LINE = re.compile(r"^(?P<y>\d{4})(?:년 |\. ?)(?P<m>\d{1,2})(?:월 |\. ?)(?P<d>\d{1,2})(?:일|\.)\s*(?P<ap>오전|오후) (?P<t>\d{1,2}:\d{2}),\s*(?P<sender>[^:]+?) : (?P<text>.*)$")
WD = "월화수목금토일"


def _norm(s: str) -> str:
    return unicodedata.normalize("NFC", s).strip()


def parse_export(raw: str) -> list[dict]:
    """내보낸 대화 텍스트 → [{"date","sender","time","text"}] (오래된 것부터). PC형과 모바일형을 모두 읽는다."""
    import datetime as dt
    out: list[dict] = []
    date = ""
    for line in raw.replace("\r\n", "\n").split("\n"):
        s = line.strip()
        m = PC_DATE.match(s)
        if m:
            date = m["d"]
            continue
        m = PC_LINE.match(line)
        if m:
            out.append({"date": date, "sender": m["sender"], "time": m["time"], "text": m["text"]})
            continue
        m = MOB_LINE.match(s)
        if m:
            d = dt.date(int(m["y"]), int(m["m"]), int(m["d"]))
            out.append({"date": f"{d.year}년 {d.month}월 {d.day}일 {WD[d.weekday()]}요일", "sender": m["sender"].strip(), "time": f"{m['ap']} {m['t']}", "text": m["text"]})
            continue
        if out and s and not re.match(r"^\d{4}년 \d{1,2}월 \d{1,2}일", s):
            out[-1]["text"] += "\n" + line
    for x in out:
        x["text"] = x["text"].rstrip("\n")
    return out


def _room_of_file(p: Path) -> str:
    try:
        head = p.read_text(encoding="utf-8-sig", errors="replace").split("\n", 2)[0]
    except OSError:
        head = ""
    m = re.match(r"^(.*?)\s*(?:님과)?\s*카카오톡 대화", _norm(head))
    if m and m.group(1):
        return m.group(1).strip()
    name = re.sub(r"^(KakaoTalk_|Talk_)", "", _norm(p.stem))
    return re.sub(r"[_ ]?\d{8}.*$|[_ ]?\d{4}\.\d{1,2}\.\d{1,2}.*$", "", name).strip() or _norm(p.stem)


def _export_files() -> dict[str, list[Path]]:
    d = _export_dir()
    found: dict[str, list[Path]] = {}
    if not d.is_dir():
        return found
    for p in sorted(d.rglob("*.txt"), key=lambda x: x.stat().st_mtime):
        found.setdefault(_room_of_file(p), []).append(p)
    return found


# ---------------------------------------------------------------- 열린 창 (실험)
def _osa(script: str, timeout: float = 15.0) -> str:
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "osascript 실패")
    return r.stdout.strip()


def _live_windows() -> list[str]:
    try:
        out = _osa('tell application "System Events" to if exists process "KakaoTalk" then get name of every window of process "KakaoTalk"')
    except Exception:
        return []
    return [_norm(x) for x in out.split(", ") if x.strip()]


def _live_read(room: str) -> list[dict]:
    esc = room.replace('"', '\\"')
    old = subprocess.run(["pbpaste"], capture_output=True).stdout
    try:
        _osa(f'''
tell application "KakaoTalk" to activate
delay 0.3
tell application "System Events" to tell process "KakaoTalk"
  perform action "AXRaise" of (first window whose name is "{esc}")
  delay 0.3
  keystroke "a" using command down
  delay 0.2
  keystroke "c" using command down
end tell''')
        time.sleep(0.4)
        raw = subprocess.run(["pbpaste"], capture_output=True).stdout.decode("utf-8", "replace")
    finally:
        subprocess.run(["pbcopy"], input=old)
    msgs = parse_export(raw)
    if not msgs and _parse_pc:
        msgs = _parse_pc(raw)
    return msgs


# ---------------------------------------------------------------- Windows 모듈과 같은 이름
def list_chat_windows() -> list[str]:
    rooms = set(_export_files().keys())
    if _cfg.get("mac_live"):
        rooms.update(_live_windows())
    return sorted(rooms)


def open_chat(room: str) -> str:
    d = _export_dir()
    if not d.is_dir():
        d.mkdir(parents=True, exist_ok=True)
    raise RuntimeError(f"'{room}' 대화 파일이 없습니다. 카카오톡에서 이 방을 '대화 내용 내보내기 → 텍스트로 저장'해 {d} 폴더에 넣으세요."
                       + (" 또는 카카오톡에서 이 대화방 창을 열어 두세요." if _cfg.get("mac_live") else ""))


def read_messages(room: str, last_n: int = 0) -> list[dict]:
    room_n = _norm(room)
    msgs: list[dict] = []
    for p in _export_files().get(room_n, []):
        msgs.extend(parse_export(p.read_text(encoding="utf-8-sig", errors="replace")))
    if _cfg.get("mac_live") and room_n in _live_windows():
        try:
            msgs.extend(_live_read(room_n))
        except Exception as e:
            if not msgs:
                raise RuntimeError(f"카카오톡 창을 읽지 못했습니다 ({e}). ODD HR에 '손쉬운 사용' 권한을 주세요.")
    # 같은 메시지가 여러 파일에 겹쳐도 한 번만 (에이전트가 이미 본 것은 또 거른다)
    seen, out = set(), []
    for m in msgs:
        k = (m["date"], m["sender"], m["time"], m["text"])
        if k not in seen:
            seen.add(k); out.append(m)
    return out[-last_n:] if last_n else out
