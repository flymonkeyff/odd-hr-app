"""ODD HR 할 일 추출 엔진 (규칙 기반, 외부 모델 호출 없음).

카카오톡 메시지 한 건을 받아 "할 일", "할 일 아님", "PM 확인 필요" 중 하나로 판정하고,
할 일이면 제목, 담당 역할, 마감, 확신도, 긴급도, 고위험 여부를 채운다.

설계 원칙
- 메시지는 데이터다. 메시지 속 명령문(규칙 무시, 상태 바꿔 등)은 따르지 않고 판정 재료로만 쓴다.
- 민감한 메시지(건강, 가족, 갈등, 성적 등)는 할 일로 만들지 않고 원문도 남기지 않는다.
- 애매하면 확신도를 낮추고 사람이 고르게 한다. 에이전트는 제안까지만 한다.

Windows 의존성이 없어서 어디서든 테스트할 수 있다.
"""
from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field, asdict

ROLES = ("PM", "기획", "디자인", "촬영", "편집")
WEEKDAYS = "월화수목금토일"

# ---------------------------------------------------------------- 한글 자모 도구
_BASE, _JUNG, _JONG = 0xAC00, 28, 21 * 28


def _is_hangul(ch: str) -> bool:
    return len(ch) == 1 and 0xAC00 <= ord(ch) <= 0xD7A3


def _split(ch: str) -> tuple[int, int, int]:
    code = ord(ch) - _BASE
    return code // _JONG, (code % _JONG) // _JUNG, code % _JUNG


def _join(cho: int, jung: int, jong: int) -> str:
    return chr(_BASE + cho * _JONG + jung * _JUNG + jong)


_J_RIEUL = 8  # 받침 ㄹ
# 아/어 활용형 모음 → 기본형 모음 (보내→보내, 올려→올리, 채워→채우, 해→하, 챙겨→챙기, 줘→주, 봐→보)
_VOWEL_BACK = {6: 20, 14: 13, 1: 0, 9: 8}  # ㅕ→ㅣ, ㅝ→ㅜ, ㅐ(해)→ㅏ, ㅘ→ㅗ


def _drop_rieul(ch: str) -> str:
    cho, jung, jong = _split(ch)
    return _join(cho, jung, 0) if jong == _J_RIEUL else ch


def _stem_from_eo(word: str) -> str:
    """'올려' → '올리', '해' → '하', '채워' → '채우', '보내' → '보내'."""
    if not word or not _is_hangul(word[-1]):
        return word
    cho, jung, jong = _split(word[-1])
    if jong:
        return word
    if word[-1] == "해":
        return word[:-1] + "하"
    if word[-1] in "아어" and len(word) > 1:
        return word[:-1]
    if jung in (6, 14, 9):
        return word[:-1] + _join(cho, _VOWEL_BACK[jung], 0)
    return word


# ---------------------------------------------------------------- 사전
SENSITIVE = [
    "집안일", "집안 사정", "가족", "부모님", "엄마가", "아빠가", "장례", "상을 당",
    "몸이 안", "몸이 좀", "아파서", "아파요", "아픈", "병원", "입원", "다쳐", "다쳤", "건강", "약 먹",
    "짜증", "화나", "열받", "빡치", "싫어요", "싫다", "불만", "서운", "싸웠", "다퉜", "솔직히",
    "성적", "학점", "장학금", "알바비", "돈이 없", "우울", "힘들어서", "그만두", "탈퇴", "휴학",
    "개인 사정", "개인사정", "사정이 있어", "피곤", "컨디션", "잠을 못", "밤새서", "시험", "중간고사", "기말고사", "과제가 많", "과제 계속", "멘탈", "스트레스", "집에 일", "집에 무슨", "개인적인", "번아웃",
]
INJECTION = [r"규칙.{0,4}무시", r"무시하고", r"(ODD ?HR|에이전트|봇).{0,8}(한테|에게|이|가).{0,30}(지우|삭제|바꾸|바꿔|완료)", r"ODD ?HR.{0,20}(바꿔|바꾸|지워|삭제|완료로)", r"모든 (태스크|작업|할 ?일).{0,10}(완료|삭제)"]

ROLE_WORDS = {
    "편집": ["편집", "렌더", "컷 편집", "가편", "최종본", "편집본", "자막", "컬러", "색보정", "음악", "사운드", "믹싱", "프리미어"],
    "디자인": ["디자인", "시안", "썸네일", "포스터", "로고", "폰트", "타이포", "일러스트", "피그마", "모션"],
    "촬영": ["촬영", "카메라", "조명", "배터리", "삼각대", "장소 섭외", "로케", "짐벌", "렌즈"],
    "기획": ["기획", "시나리오", "콘티", "대본", "스토리보드", "기획안", "인터뷰 질문", "레퍼런스"],
    "PM": ["일정표", "예산", "결재", "학과 사무실", "공지"],
}
TEAM_CALL = re.compile(r"(PM|기획|디자인|촬영|편집)\s?(팀|담당|님|쪽)")
ALL_HANDS = re.compile(r"(다들|각자|전원|모두들?|여러분|팀원들?)")
EXTERNAL = re.compile(r"(담당자님|교수님께|경찰서|외부|클라이언트|주최측|학과 사무실에 (보내|제출)|공지)")
RISK_WORDS = ["보내", "발송", "제출", "전달", "미루", "미뤄", "연기", "취소", "변경", "축소", "삭제", "공지"]
PROJECT_WORDS = {
    "양천경찰서 영상": ["경찰서", "양천", "도박"],
    "장기실종아동 공모전": ["공모전", "실종", "아동"],
    "30km/h 표지판의 시선": ["30km", "스쿨존", "표지판"],
    "블렌더 AI VFX 스터디": ["블렌더", "VFX", "스터디"],
}

# ---------------------------------------------------------------- 문장 패턴
P_PROMISE = re.compile(r"(겠습니다|겠어요|할께요?|볼게요?|볼께요?|드릴게요?|해 ?놓을게|해 ?둘게)")
P_REQUEST = re.compile(r"(줄 ?수 ?있(어|나요|을까요|어요|으세요)|줄래|주실래|주시겠어요|좀 ?(봐|해|확인해) ?줘|(오|하|주|쓰|써오|해오|달)래요|라고 하셨|라고 하시네요|주세요|주실 ?수|줘요|줘\b|줘$|줘[.!~ ]|부탁(해요|드려요|드립니다|합니다|해)|바랍니다|하세요|해야 (합니다|해요|돼요|됩니다)|해 ?놔|해 ?두세요)")
P_NEED = re.compile(r"(필요할 ?것 ?같|필요해요|필요합니다|필요함|해야 ?할 ?듯|야 ?할 ?듯|야겠어요|야겠다|야 ?할 ?것 ?같|확인 필요)")
P_WHO = re.compile(r"(누가 ?(하나요|할까요|해요|하죠|맡|담당|받|할래|가능)|(주실|해 ?주실|하실|맡아 ?주실|가실) ?분\s*(\?|있나요|계신가요|계세요))")
P_CHANGE = re.compile(r"(미뤄요|미룹니다|미뤘|연기합니다|연기해요|변경합니다|바뀌었|로 옮겨요|로 바꿔요)")
P_EVENT = re.compile(r"(회의|미팅|촬영|마감|제출|반납|접수|시사|발표|리허설|답사|녹음|집합|모임|면담|상담|인터뷰|수업 후|약속)")
P_EVENT_ANNOUNCE = re.compile(r"(까지(입니다|예요|이에요)|(입니다|이에요|예요|있어요|있습니다|합니다)\s*[.!~]*$|잡혔|잡았|정했어요|확정입니다)")
P_MEET_ASK = re.compile(r"(볼 ?수 ?있을까요|만날 ?수 ?있을까요|가능할까요|될까요|괜찮을까요|어때요)\??\s*$")

P_DONE = re.compile(r"(완료|끝났|끝냈|마쳤|올렸어요|올렸습니다|올렸음|보냈어요|보냈습니다|했어요|했습니다|했음|됐어요|됐습니다|되었습니다|반영했|수정했|공유드렸|드렸어요)")
P_CANCEL = re.compile(r"(취소합니다|취소예요|취소입니다|취소됐|없습니다|안 해요|안 합니다)")
P_GREETING = re.compile(r"^(다들 )?(수고|고생|감사|고마|좋아요|넵|네|ㅇㅋ|오케이|굿|화이팅|파이팅)")
P_LAUGH = re.compile(r"(ㅋ{2,}|ㅎ{2,}|ㅠ{2,})")
P_SHARE = re.compile(r"(공유합니다|공유해요|공유드려요|참고하세요|https?://)")
P_STATUS = re.compile(r"(걸어 ?두고|하는 ?중|중이에요|중입니다|잡니다|자러|퇴근|출발했|도착했)")
P_DECIDED = re.compile(r"(확정했|확정됐|하기로 했|으로 정했|로 정했|결정했)")
P_SUGGEST = re.compile(r"(볼까요|할까요|어때요|어떨까요|어떠세요)\?*$")
P_SUGGEST_ONLY = re.compile(r"(바꿔 ?볼까요|키워 ?볼까요|해 ?볼까요|어때요)\??\s*$")
P_QUESTION = re.compile(r"(\?|죠|나요|까요|어요\?)\s*$")


@dataclass
class Verdict:
    verdict: str                       # "할 일" | "할 일 아님" | "PM 확인 필요"
    reason: str = ""
    title: str = ""
    role: str = "미정"
    due: str | None = None             # YYYY-MM-DD
    confidence: str = "중간"           # 높음 | 중간 | 낮음
    urgency: str | None = None         # 긴급 | 높음 | 보통 | 낮음
    risky: bool = False
    project: str = "미분류"
    kind: str = ""                     # 요청 | 약속 | 필요 | 일정 | 변경 | 담당 미정
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------- 날짜
def parse_kakao_date(s: str) -> dt.date | None:
    m = re.search(r"(\d{4})년 (\d{1,2})월 (\d{1,2})일", s or "")
    return dt.date(int(m[1]), int(m[2]), int(m[3])) if m else None


def _weekday_date(ref: dt.date, wd: int, next_week: bool) -> dt.date:
    monday = ref - dt.timedelta(days=ref.weekday())
    if next_week:
        return monday + dt.timedelta(days=7 + wd)
    d = monday + dt.timedelta(days=wd)
    return d if d >= ref else d + dt.timedelta(days=7)


def find_due(text: str, ref: dt.date) -> dt.date | None:
    t = text
    m = re.search(r"(\d{1,2})월 ?(\d{1,2})일", t)
    if m:
        y = ref.year
        try:
            d = dt.date(y, int(m[1]), int(m[2]))
        except ValueError:
            d = None
        if d and (ref - d).days > 60:
            d = dt.date(y + 1, d.month, d.day)
        # "12월 1일 마감이니까 11월 28일까지" → '까지'가 붙은 날짜를 우선한다
        mk = re.search(r"(\d{1,2})월 ?(\d{1,2})일\s*까지", t)
        if mk:
            try:
                d2 = dt.date(y, int(mk[1]), int(mk[2]))
                return d2 if (ref - d2).days <= 60 else dt.date(y + 1, d2.month, d2.day)
            except ValueError:
                pass
        return d
    m = re.search(r"(\d{1,2})/(\d{1,2})", t)
    if m and not re.search(r"\d/\d{3,}", t):
        try:
            return dt.date(ref.year, int(m[1]), int(m[2]))
        except ValueError:
            pass
    m = re.search(r"(다음 ?주|담주|이번 ?주|금주)?\s*([월화수목금토일])요일", t)
    if m:
        return _weekday_date(ref, WEEKDAYS.index(m[2]), bool(m[1] and m[1].replace(" ", "") in ("다음주", "담주")))
    if re.search(r"(모레|내일모레)", t):
        return ref + dt.timedelta(days=2)
    if re.search(r"내일", t):
        return ref + dt.timedelta(days=1)
    if re.search(r"(이번 ?주 ?(안에|내|중|까지)|주말|금주 ?(안|내|중))", t):
        return ref + dt.timedelta(days=6 - ref.weekday())
    if re.search(r"다음 ?주 ?(안에|내|중|까지|에)", t):
        return ref + dt.timedelta(days=13 - ref.weekday())
    if re.search(r"오늘", t) and re.search(r"(까지|중으로|안에)", t):
        return ref
    return None


def urgency_for(due: dt.date | None, ref: dt.date) -> str | None:
    if not due:
        return None
    n = (due - ref).days
    return "긴급" if n <= 0 else "높음" if n <= 2 else "보통" if n <= 7 else "낮음"


# ---------------------------------------------------------------- 제목 만들기
_DATE_PHRASE = re.compile(
    r"((다음 ?주|담주|이번 ?주|금주)\s*)?(다음 ?주에|(이번 ?)?주말|[월화수목금토일]요일|내일모레|모레|내일|오늘|주말|이번 ?주|\d{1,2}월 ?\d{1,2}일|\d{1,2}/\d{1,2})"
    r"(\s*(오전|오후|아침|저녁|밤)?\s*(\d{1,2}시(\s*\d{1,2}분)?)?)?\s*(까지|안에|내로|중으로|중에|에)?\s*"
)
_LEAD = re.compile(r"^((넵|네|넹|ㅇㅋ|오키|알겠습니다|알겠어요|좋아요)[!.,~]*\s+|(PM|기획|디자인|촬영|편집)\s?(팀|담당|님|쪽)(은|는|이|가|에서)?\s+|(PM|기획|디자인|촬영|편집)(은|는|이|가|에서)\s+|다들\s+|각자\s+|모두\s+|여러분\s+|저는?\s+|제가\s+|혹시\s+)+")


def make_title(text: str, kind: str) -> str:
    t = re.sub(r"https?://\S+", "", text).strip()
    t = re.sub(r"[ㅋㅎㅠㅜ]{2,}", "", t)
    t = t.split("\n")[0].strip()
    if kind not in ("일정", "변경"):
        # "공모전 접수 12월 1일 마감이니까 11월 28일까지 최종본 주세요" → 마지막 절만 쓴다
        parts = re.split(r"(?:니까|으니|는데|인데)\s+", t)
        if len(parts) > 1 and len(parts[-1]) >= 4:
            t = parts[-1]
        t = _DATE_PHRASE.sub(" ", t)
    t = _LEAD.sub("", t.strip())
    t = re.sub(r"\s+", " ", t).strip(" .,!~")

    rules: list[tuple[str, callable]] = [
        (r"(\S+?)은?는? ?누가 ?(하나요|할까요|해요|하죠|맡.*|담당.*)\??$", lambda m: f"{m[1].rstrip('은는')} 담당 정하기"),
        (r"(\S+)\s?(해 ?주세요|해 ?줘요?|해 ?주실 ?수.*|해야 ?(합니다|해요|돼요|됩니다)|해 ?놔.*|해 ?두세요|하세요)$", lambda m: f"{m[1]}하기"),
        (r"(\S+?) ?주세요$", lambda m: _give(m[1])),
        (r"(\S+) ?줘요?$", lambda m: _give(m[1])),
        (r"(\S+?) ?줄 ?수 ?있(어요|어|나요|을까요|으세요)\??$", lambda m: _give(m[1])),
        (r"(\S+) 부탁(해요|드려요|드립니다|합니다|해)$", lambda m: f"{m[1]}하기" if m[1] in VERBAL_NOUNS else f"{m[1]} 준비하기"),
        (r"(\S+) 주세요$", lambda m: f"{m[1]}"),
        (r"\s?(필요할 ?것 ?같아요|필요해요|필요합니다|필요함|필요)$", lambda m: "하기"),
        (r"(\S+)야 ?(할 ?듯|겠어요|겠다|할 ?것 ?같아요|합니다|해요)$", lambda m: f"{_stem_from_eo(m[1])}기"),
        (r"(\S+) 볼게요$", lambda m: f"{_stem_from_eo(m[1])}기"),
        (r"(\S+)겠습니다$", lambda m: f"{m[1]}기"),
        (r"(\S+)을게요?$", lambda m: f"{m[1]}기"),
        (r"(\S+)게요?$", lambda m: f"{m[1][:-1]}{_drop_rieul(m[1][-1])}기" if m[1] and _is_hangul(m[1][-1]) and _split(m[1][-1])[2] == _J_RIEUL else f"{m[1]}기"),
        (r"(\S+)(뤄요|룹니다)$", lambda m: f"{m[1]}루기"),
        (r"(입니다|이에요|예요)$", lambda m: ""),
        (r"(\S+)합니다$", lambda m: f"{m[1]}하기"),
    ]
    for pat, fn in rules:
        m = re.search(pat, t)
        if m:
            t = (t[: m.start()] + fn(m)).strip()
            break
    t = re.sub(r"(\S+?)[은는] 하기$", r"\1하기", t)
    t = re.sub(r"(\S{2,}?)[은는] (?=\S+기$)", r"\1 ", t)
    t = re.sub(r" (제가|저는|저도) ", " ", t)
    t = re.sub(r"\s+하기$", "하기", t) if re.search(r"(확인|정리|공유|투표|신청|제출|수정|준비|검토)\s+하기$", t) else t
    t = re.sub(r"\s+", " ", t).strip(" .,!~?")
    return t[:60] if t else text.strip()[:60]


VERBAL_NOUNS = {"투표", "확인", "정리", "공유", "검토", "작성", "제출", "수정", "준비", "연락", "섭외", "예약", "신청", "체크", "답변", "회신", "피드백", "업로드", "백업", "출력", "인쇄", "보고"}


def _give(word: str) -> str:
    """'보내 주세요' → '보내기', '최종본 주세요' → '최종본 전달하기'."""
    if word.endswith("서") and len(word) > 1:
        return f"{_stem_from_eo(word[:-1])}기"
    if word and _is_hangul(word[-1]) and _split(word[-1])[2] == 0 and (word[-1] in "해내래새재채매배세게아어" or _split(word[-1])[1] in (6, 14, 9, 4)):
        return f"{_stem_from_eo(word)}기"
    return f"{word} 전달하기"


# ---------------------------------------------------------------- 역할·프로젝트
def _role_of_sender(sender: str, members: dict[str, str]) -> str:
    if sender in members:
        return members[sender]
    for r in ROLES:
        if sender.strip() == r or sender.startswith(r + " ") or sender.endswith(" " + r):
            return r
    return "미정"


def _role_from_words(text: str) -> str | None:
    best, score = None, 0
    for role, words in ROLE_WORDS.items():
        s = sum(1 for w in words if w in text)
        if s > score:
            best, score = role, s
    return best


def project_for(text: str, room: str = "", projects: dict[str, list[str]] | None = None) -> str:
    table = projects or PROJECT_WORDS
    hay = f"{room} {text}"
    for name, words in table.items():
        if any(w in hay for w in words):
            return name
    return "미분류"


# ---------------------------------------------------------------- 판정
def classify(msg: dict, ref: dt.date | None = None, members: dict[str, str] | None = None,
             room: str = "", projects: dict[str, list[str]] | None = None) -> Verdict:
    """msg = {"date": "2026년 11월 10일 화요일", "sender": "편집", "time": "오후 3:10", "text": "..."}"""
    members = members or {}
    text = (msg.get("text") or "").strip()
    ref = ref or parse_kakao_date(msg.get("date", "")) or dt.date.today()
    sender_role = _role_of_sender(msg.get("sender", ""), members)
    flat = re.sub(r"\s+", " ", text)

    if not flat:
        return Verdict("할 일 아님", "빈 메시지")
    if any(w in flat for w in SENSITIVE):
        return Verdict("PM 확인 필요", "민감한 내용 (원문을 옮기지 않음)")
    if any(re.search(p, flat) for p in INJECTION):
        return Verdict("할 일 아님", "에이전트에게 내리는 지시라 따르지 않음")

    is_request = bool(P_REQUEST.search(flat))
    is_promise = bool(P_PROMISE.search(flat)) or _rieul_ge_yo(flat)
    is_need = bool(P_NEED.search(flat))
    is_who = bool(P_WHO.search(flat))
    is_change = bool(P_CHANGE.search(flat))
    due = find_due(flat, ref)
    is_event = bool(P_EVENT.search(flat)) and (due is not None or re.search(r"\d{1,2}시", flat)) and bool(P_EVENT_ANNOUNCE.search(flat))

    is_meet_ask = due is not None and bool(P_MEET_ASK.search(flat)) and not P_SUGGEST_ONLY.search(flat)
    if is_meet_ask and not (is_request or is_promise or is_need or is_who or is_change):
        role = sender_role if sender_role != "미정" else "미정"
        return Verdict("할 일", "일정 제안 + 날짜", title=make_title(text, "일정"), role=role, due=due.isoformat(),
                       confidence="중간", urgency=urgency_for(due, ref), risky=False,
                       project=project_for(flat, room, projects), kind="일정")
    if not (is_request or is_promise or is_need or is_who or is_change):
        if P_DECIDED.search(flat):
            return Verdict("할 일 아님", "결정 기록 (결정 로그 대상)")
        if P_CANCEL.search(flat):
            return Verdict("할 일 아님", "취소 공지")
        if P_DONE.search(flat):
            return Verdict("할 일 아님", "이미 끝난 일")
        if P_GREETING.search(flat) or (P_LAUGH.search(flat) and len(flat) < 30):
            return Verdict("할 일 아님", "인사나 잡담")
        if P_SHARE.search(flat):
            return Verdict("할 일 아님", "자료 공유")
        if P_STATUS.search(flat):
            return Verdict("할 일 아님", "상태 공유")
        if P_SUGGEST.search(flat):
            return Verdict("할 일 아님", "제안이지 확정 아님", confidence="낮음")
        if not is_event:
            if P_QUESTION.search(flat):
                return Verdict("할 일 아님", "질문만 있음")
            return Verdict("할 일 아님", "할 일 신호 없음", confidence="낮음")

    # ---- 할 일
    if is_who:
        kind, conf = "담당 미정", "중간"
    elif is_change:
        kind, conf = "변경", "높음"
    elif is_request:
        kind, conf = "요청", "높음"
    elif is_promise:
        kind, conf = "약속", "높음"
    elif is_need:
        kind, conf = "필요", "중간"
    else:
        kind, conf = "일정", "높음"

    role = _assign_role(flat, kind, sender_role)
    risky = any(w in flat for w in RISK_WORDS)
    title = make_title(text, kind)
    v = Verdict(
        "할 일", f"{kind}{' + 날짜' if due else ''}", title=title, role=role,
        due=due.isoformat() if due else None, confidence=conf,
        urgency=urgency_for(due, ref), risky=risky, project=project_for(flat, room, projects), kind=kind,
    )
    if kind == "필요" and not due:
        v.confidence = "중간"
    if len(v.title.replace("하기", "").strip()) < 2:
        v.title = "앞 대화에서 맡은 일 확인하기"
        v.confidence = "중간"
    return v


def _rieul_ge_yo(text: str) -> bool:
    """'올릴게요', '갈게요', '줄일게요'처럼 ㄹ받침 + 게요 = 본인 약속."""
    for m in re.finditer(r"(\S)게(?:요)?(?=$|[\s.!~,?ㅎㅋ])", text):
        ch = m[1]
        if _is_hangul(ch) and _split(ch)[2] == _J_RIEUL:
            return True
    return False


def _assign_role(text: str, kind: str, sender_role: str) -> str:
    if kind in ("약속", "필요", "일정", "변경"):
        return sender_role if sender_role != "미정" else (_role_from_words(text) or "미정")
    if kind == "담당 미정":
        return "미정"
    m = TEAM_CALL.search(text)
    if m:
        return m[1]
    if EXTERNAL.search(text):
        return "PM"
    if ALL_HANDS.search(text):
        return "미정"
    return _role_from_words(text) or "미정"


def dedupe_key(msg: dict) -> str:
    return f"{msg.get('date', '')}|{msg.get('time', '')}|{msg.get('sender', '')}|{(msg.get('text') or '')[:30]}"
