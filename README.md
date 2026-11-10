# ODD HR 앱

팀 AX 데스크톱 앱 (Windows, Mac). 설치와 운영은 [설치-안내.md](설치-안내.md).

## 구성

| 경로 | 내용 |
| --- | --- |
| `main.js`, `preload.js` | Electron 메인 프로세스: 창, 트레이, 자동 시작, 카톡 에이전트 실행, 팀 서버 설정 |
| `app/index.html`, `app/desk.js` | 화면: 홈(아침상, 오늘 결정 바), 작업, 할 일, 목표, 미팅, 팀원, 에이전트, 설정. `tools/build_ui.py`가 Desk 화면에서 만든다 |
| `app/shim.js` | 연결부: 첫 화면(코드 입력, PM 로그인, 프로젝트 만들기), 팀 서버 저장소, 실시간 반영, 화면 설정(라이트/다크, 키 컬러) |
| `server/setup.sql` | 팀 서버(Supabase) 스키마, 행 단위 권한, 코드 입장, PM 전용 규칙 |
| `server/test/run.js` | 서버 권한 시험 46개 (PGlite) |
| `agent/` | 카톡 에이전트 (규칙 엔진, 대기열, 로컬 모델 선택). CI가 `odd-hr-agent.exe`로 묶는다 |
| `test/e2e.js` | 앱 전체 흐름 시험 21개: 화면 + 연결부 + 서버 권한 + 실제 에이전트(가짜 카톡) |
| `.github/workflows/build.yml` | Windows .exe(에이전트 포함), Mac .dmg 빌드 |
| `build/` | 아이콘 (ODD 로고) |

## 개발

```
npm install
npm start                    # 앱 실행 (서버 연결 화면부터)
ODDHR_AGENT_CMD="python -m kakaotalk_mcp.oddhr_agent" npm start   # 에이전트를 파이썬으로 붙여 실행
npm run test:server          # 서버 권한 시험 (NODE_PATH에 @electric-sql/pglite 필요)
npm run dist:win             # Windows 설치 파일 (Linux에서는 wine 필요)
```

화면을 고칠 때는 `odd-hr-desk.html`을 고친 뒤 `python3 tools/build_ui.py ../odd-hr-desk.html`로 다시 만든다.

## 보안 메모

- 앱에 들어가는 것은 Supabase의 **anon public** 키뿐이다. 권한은 전부 서버의 행 단위 규칙(RLS)과 트리거가 지킨다.
- 화면은 sandbox, contextIsolation으로 돌고, 앱 밖 페이지로 넘어가지 않는다. 바깥 링크는 기본 브라우저로 연다.
- 카톡 에이전트는 허용된 명령(status, pending, mark-synced, scan, config-get, config-set)만 받는다. 카톡에 보내는 기능은 없다.
