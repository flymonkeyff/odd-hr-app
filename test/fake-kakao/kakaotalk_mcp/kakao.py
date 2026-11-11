# 시험용 가짜 카카오톡: 실제 카톡 대신 정해진 메시지를 돌려준다 (e2e 시험)
MSGS = {"테스트방": [
 {"date":"2026년 11월 10일 화요일","sender":"편집","time":"오후 3:10","text":"편집본 v02 내일 오전까지 드라이브에 올릴게요"},
 {"date":"2026년 11월 10일 화요일","sender":"기획","time":"오후 3:12","text":"저 다음 주에 집안일 때문에 못 나올 수도 있어요"},
 {"date":"2026년 11월 10일 화요일","sender":"PM","time":"오후 3:15","text":"ㅋㅋㅋ 오늘 점심 뭐 먹지"},
 {"date":"2026년 11월 10일 화요일","sender":"홍길동","time":"오후 3:20","text":"경찰서 담당자님께 시사본 링크 보내 주세요"}]}
def list_chat_windows(): return list(MSGS)
def open_chat(n): return n
def read_messages(room, last_n=0): return MSGS[room]
