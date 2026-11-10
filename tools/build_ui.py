"""Desk 화면(odd-hr-desk.html)을 ODD HR 앱 화면(app/index.html + app/desk.js)으로 바꾼다.

python tools/build_ui.py <odd-hr-desk.html 경로>

바꾸는 것
- 저장소: Claude 아티팩트 저장소 대신 앱 연결부(shim.js)의 팀 서버 저장소
- 프로젝트 목록과 마감: 고정 목록 대신 서버의 내 프로젝트
- 화면 설정: 라이트/다크, 키 컬러 (CSS 토큰)
- 새 화면: 팀원(PM 버전/팀원 버전), 설정
- Claude 전용 문구와 기능 정리 (AI 요약 버튼은 앱에서 나오지 않음)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "tools" / "desk-source.html").read_text(encoding="utf-8")


def rep(s: str, a: str, b: str, count: int = 1) -> str:
    n = s.count(a)
    if n != count:
        raise SystemExit(f"[build_ui] 찾는 문장이 {n}번 있음 (기대 {count}): {a[:90]!r}")
    return s.replace(a, b)


style = re.search(r"<style>(.*?)</style>", src, re.S).group(1)
body = src[src.index("</style>") + len("</style>"): src.index("<script>")]
script = re.search(r"<script>\n(.*)</script>", src, re.S).group(1)

# ---------------------------------------------------------------- CSS: 토큰, 다크, 키 컬러
style = rep(style, """/* 디자인 원칙(Apple HIG): 명료함 · 절제 · 깊이.
   콘텐츠가 주인공이고 크롬은 물러선다. 강조색은 시스템 블루 하나, 상태는 시스템 색(빨강·주황·노랑·초록)으로만 말한다.
   층위는 반투명 사이드바와 아주 옅은 그림자로, 위계는 굵기와 크기로 만든다. 흰색 단일 테마. */""",
            """/* 디자인 원칙(Apple HIG): 명료함 · 절제 · 깊이.
   콘텐츠가 주인공이고 크롬은 물러선다. 강조색(키 컬러)은 하나, 상태는 시스템 색(빨강·주황·노랑·초록)으로만 말한다.
   층위는 반투명 사이드바와 아주 옅은 그림자로, 위계는 굵기와 크기로 만든다. 라이트 기본, 다크 지원. */""")
style = rep(style, """  --blue: #007aff;
  --blue-press: #0062cc;
  --blue-soft: rgba(0, 122, 255, 0.1);
  --blue-text: #0066d6;""", """  --blue: #F15524;
  --on-accent: #ffffff;
  --blue-press: color-mix(in srgb, var(--blue) 84%, black);
  --blue-soft: color-mix(in srgb, var(--blue) 13%, transparent);
  --blue-text: color-mix(in srgb, var(--blue) 80%, black);
  --focus: color-mix(in srgb, var(--blue) 45%, transparent);
  --side: rgba(246, 246, 248, 0.82);
  --child-bar: color-mix(in srgb, var(--blue) 55%, white);
  --logo: #F15524;""")
dark = """  color-scheme: dark;
  --bg: #1c1c1e;
  --grouped: #2c2c2e;
  --fill: rgba(120, 120, 128, 0.32);
  --fill-2: rgba(120, 120, 128, 0.22);
  --ink: #f5f5f7;
  --muted: #a1a1a6;
  --faint: #7c7c80;
  --sep: rgba(84, 84, 88, 0.55);
  --sep-strong: rgba(84, 84, 88, 0.75);
  --blue-text: color-mix(in srgb, var(--blue) 72%, white);
  --blue-soft: color-mix(in srgb, var(--blue) 24%, transparent);
  --red: #ff453a;   --red-text: #ff6961;   --red-soft: rgba(255, 69, 58, 0.2);
  --orange: #ff9f0a; --orange-text: #ffb340; --orange-soft: rgba(255, 159, 10, 0.2);
  --yellow-text: #ffd60a; --yellow-soft: rgba(255, 214, 10, 0.18);
  --green: #30d158; --green-text: #4ade80; --green-soft: rgba(48, 209, 88, 0.2);
  --indigo-text: #a5a3ff; --indigo-soft: rgba(94, 92, 230, 0.26);
  --shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.08), 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 16px rgba(0, 0, 0, 0.25);
  --shadow-lift: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 2px 6px rgba(0, 0, 0, 0.35), 0 12px 32px rgba(0, 0, 0, 0.45);
  --side: rgba(36, 36, 38, 0.86);
  --child-bar: color-mix(in srgb, var(--blue) 60%, black);"""
style = rep(style, """* { box-sizing: border-box; }""", f"""@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
{dark}
}} }}
:root[data-theme="dark"] {{
{dark}
}}
* {{ box-sizing: border-box; }}""")
style = rep(style, ":focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.45) !important; }", ":focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus) !important; }")
style = rep(style, "background: rgba(246, 246, 248, 0.82); -webkit-backdrop-filter", "background: var(--side); -webkit-backdrop-filter")
style = rep(style, ".btn.primary, .btn.accent { background: var(--blue); color: #fff; }", ".btn.primary, .btn.accent { background: var(--blue); color: var(--on-accent); }")
style = rep(style, "border: solid #fff; border-width: 0 2px 2px 0;", "border: solid var(--on-accent); border-width: 0 2px 2px 0;")
style = rep(style, '.chip[aria-pressed="true"] { background: var(--ink); color: #fff; }', '.chip[aria-pressed="true"] { background: var(--ink); color: var(--bg); }')
style = rep(style, ".goal.child .progress span { background: #5ac8fa; }", ".goal.child .progress span { background: var(--child-bar); }")
style = style.replace("0 0 0 3px rgba(0, 122, 255, 0.25)", "0 0 0 3px var(--focus)")
style = rep(style, '.dp-quick .chip[aria-pressed="true"] { background: var(--blue); color: #fff; }', '.dp-quick .chip[aria-pressed="true"] { background: var(--blue); color: var(--on-accent); }')
style = rep(style, '.dp-day[aria-selected="true"] { background: var(--blue); color: #fff; font-weight: 600; }', '.dp-day[aria-selected="true"] { background: var(--blue); color: var(--on-accent); font-weight: 600; }')
style = rep(style, ".logo .mark { height: 22px; width: auto; fill: #F15524; flex: none; }", ".logo .mark { height: 22px; width: auto; fill: var(--logo); flex: none; }")
style = rep(style, "/* ---- 날짜 선택기 ---- */", """/* ---- 앱: 프로젝트 고르기, 팀원, 설정, 첫 화면 ---- */
.projsel { display: grid; gap: 4px; padding: 0 8px; }
.projsel label { font-size: 11.5px; font-weight: 600; color: var(--muted); }
.projsel select { border: 0; background: var(--fill-2); border-radius: 8px; padding: 6px 8px; font-size: 13.5px; font-weight: 500; width: 100%; }
.menu a[href="#team"]::before { -webkit-mask-image: var(--ic-team); mask-image: var(--ic-team); }
.menu a[href="#settings"]::before { -webkit-mask-image: var(--ic-settings); mask-image: var(--ic-settings); }
.team-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.mcard { border-radius: var(--r-lg); padding: 18px; display: grid; gap: 12px; align-content: start; background: var(--bg); box-shadow: var(--shadow); min-width: 0; }
.mcard.me { box-shadow: var(--shadow), inset 0 0 0 1.5px var(--blue); }
.mhead { display: flex; gap: 12px; align-items: center; }
.avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--blue-soft); color: var(--blue-text); display: grid; place-items: center; font-weight: 700; font-size: 16px; flex: none; }
.mhead .nm { font-weight: 600; font-size: 16px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mhead .sub2 { font-size: 12.5px; color: var(--muted); }
.steps { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.step { font-size: 12px; padding: 3px 8px; border-radius: 999px; background: var(--fill-2); color: var(--muted); white-space: nowrap; }
.step.done { color: var(--ink); }
.step.now { background: var(--blue); color: var(--on-accent); font-weight: 600; }
.step.blocked { background: var(--red-soft); color: var(--red-text); font-weight: 600; }
.mstats { display: flex; gap: 14px; font-size: 13px; color: var(--muted); flex-wrap: wrap; }
.mstats b { color: var(--ink); font-variant-numeric: tabular-nums; }
.mcard details { font-size: 13px; }
.mcard summary { cursor: pointer; color: var(--blue-text); font-weight: 500; list-style: none; }
.mcard summary::-webkit-details-marker { display: none; }
.mcard details ul { margin: 6px 0 0; padding-left: 18px; color: var(--ink); display: grid; gap: 2px; }
.checked { font-size: 12.5px; color: var(--green-text); font-weight: 600; }
.codebox { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.codebox .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 20px; font-weight: 700; letter-spacing: 0.06em; padding: 8px 14px; background: var(--grouped); border-radius: 10px; }
.swatches { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.swatch { width: 34px; height: 34px; border-radius: 50%; border: 0; padding: 0; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12); }
.swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--ink); }
.colorpick { width: 44px; height: 34px; border: 0; padding: 0; background: none; cursor: pointer; }
.hexin { width: 110px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.preview { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 14px; background: var(--grouped); border-radius: var(--r-md); }
.setrow { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 12px 20px; align-items: center; }
.setrow > .lab2 { font-size: 14px; color: var(--muted); }
@media (max-width: 860px) { .setrow { grid-template-columns: minmax(0, 1fr); } }
input.toggle { -webkit-appearance: none; appearance: none; width: 44px !important; min-width: 44px; height: 26px; border-radius: 13px; background: var(--fill) !important; box-shadow: none !important; padding: 0 !important; position: relative; cursor: pointer; flex: none; transition: background 0.2s var(--ease); }
input.toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 0.2s var(--ease); }
input.toggle:checked { background: var(--green) !important; }
input.toggle:checked::after { transform: translateX(18px); }
input.toggle:focus-visible { box-shadow: 0 0 0 3px var(--focus) !important; }
.gate { position: fixed; inset: 0; z-index: 100; background: var(--grouped); display: grid; place-items: center; padding: 24px; overflow: auto; }
.gate-card { width: min(440px, 100%); background: var(--bg); border-radius: 20px; padding: 32px; box-shadow: var(--shadow-lift); display: grid; gap: 14px; }
.gate-logo { display: flex; gap: 10px; align-items: center; }
.gate-logo svg { height: 34px; width: auto; fill: var(--logo); }
.gate-logo span { font-family: var(--font-display); font-weight: 700; font-size: 28px; letter-spacing: -0.01em; }
.gate h1 { margin: 6px 0 0; font-family: var(--font-display); font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
.gate-sub { margin: 0; color: var(--muted); font-size: 14.5px; }
.gate-form { display: grid; gap: 12px; }
.gate-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.gate-field { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
.gate-field input, .gate-field select { border: 0; box-shadow: inset 0 0 0 0.5px var(--sep-strong); border-radius: 10px; padding: 11px 13px; font-size: 16px; background: var(--bg); color: var(--ink); width: 100%; }
.gate-field input:focus, .gate-field select:focus { outline: none; box-shadow: inset 0 0 0 1px var(--blue), 0 0 0 3px var(--focus); }
#g-code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 20px; letter-spacing: 0.08em; text-transform: uppercase; }
.gate-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.gate-actions .btn { padding: 10px 18px; font-size: 15px; }
.gate-msg { margin: 0; min-height: 1.2em; font-size: 13.5px; color: var(--red-text); }
.gate-alt { display: flex; gap: 6px; align-items: center; font-size: 13.5px; color: var(--muted); border-top: 0.5px solid var(--sep); padding-top: 14px; }
.linkish { border: 0; background: none; color: var(--blue-text); font-weight: 600; padding: 0; }
.gate-code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 30px; font-weight: 700; letter-spacing: 0.08em; text-align: center; padding: 18px; background: var(--grouped); border-radius: 14px; user-select: all; }
/* ---- 날짜 선택기 ---- */""")

# 팀원, 설정 아이콘 (선 굵기 1.7)
from urllib.parse import quote
ic = {
    "team": '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.8" cy="9.3" r="2.6"/><path d="M15.6 14.6c2.6-.3 4.4 1.3 4.9 4.4"/>',
    "settings": '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/><circle cx="12" cy="12" r="6.6"/>',
}
vars_css = ":root { " + " ".join(
    f'--ic-{k}: url("data:image/svg+xml,{quote(chr(39).join(["<svg xmlns=", "http://www.w3.org/2000/svg", " viewBox=", "0 0 24 24", " fill=", "none", " stroke=", "black", " stroke-width=", "1.7", " stroke-linecap=", "round", " stroke-linejoin=", "round", ">" + v + "</svg>"]))}");' for k, v in ic.items()) + " }\n"
style = vars_css + style

# ---------------------------------------------------------------- HTML 골격
body = rep(body, '''    <div class="menu" id="menu"></div>''', '''    <div class="projsel" id="projsel"></div>
    <div class="menu" id="menu"></div>''')

# ---------------------------------------------------------------- 스크립트
script = rep(script, '''  const PROJECTS = ["양천경찰서 영상", "장기실종아동 공모전", "30km/h 표지판의 시선", "블렌더 AI VFX 스터디", "미분류"];
  const PROJECT_DEADLINES = { "양천경찰서 영상": ["2026-11-27", "편집 완료"], "장기실종아동 공모전": ["2026-12-01", "접수 마감"] };''',
             '''  // 프로젝트와 마감은 서버의 내 프로젝트에서 온다 (앱 연결부가 알려 줄 때마다 다시 채운다)
  const APP = window.oddhrApp;
  const PROJECTS = [];
  const PROJECT_DEADLINES = {};
  function syncProjects() {
    PROJECTS.length = 0;
    Object.keys(PROJECT_DEADLINES).forEach((k) => delete PROJECT_DEADLINES[k]);
    (APP ? APP.projects : []).forEach((p) => { PROJECTS.push(p.name); if (p.deadline) PROJECT_DEADLINES[p.name] = [p.deadline, p.deadline_label || "마감"]; });
  }
  syncProjects();''')
script = rep(script, '''    ["home", "홈"], ["tasks", "작업"], ["todo", "할 일"], ["goals", "목표"], ["meetings", "미팅"], ["agents", "에이전트"]''',
             '''    ["home", "홈"], ["tasks", "작업"], ["todo", "할 일"], ["goals", "목표"], ["meetings", "미팅"], ["team", "팀원"], ["agents", "에이전트"], ["settings", "설정"]''')
script = rep(script, "    const v = { home: viewHome, tasks: viewTasks, todo: viewTodo, goals: viewGoals, meetings: viewMeetings, agents: viewAgents }[S.view] || viewHome;",
             "    const v = { home: viewHome, tasks: viewTasks, todo: viewTodo, goals: viewGoals, meetings: viewMeetings, team: viewTeam, agents: viewAgents, settings: viewSettings }[S.view] || viewHome;")
# 새로 만드는 폼은 지금 고른 프로젝트를 기본으로
script = script.replace('PROJECTS.map((p) => h("option", { value: p, text: p }))', 'projOptions()')
script = rep(script, '''  function renderMenu() {
    const m = $("menu"); m.textContent = "";''', '''  function projOptions(cur) {
    const want = cur || (APP && APP.projectName(APP.currentProject));
    return PROJECTS.map((p) => { const o = h("option", { value: p, text: p }); if (p === want) o.selected = true; return o; });
  }
  function renderMenu() {
    const ps = $("projsel");
    if (ps && APP) {
      ps.textContent = "";
      if (APP.projects.length > 1) ps.appendChild(h("label", { for: "curproj", text: "기본 프로젝트" }));
      if (APP.projects.length > 1) ps.appendChild(h("select", { id: "curproj", title: "새로 만드는 할 일, 목표, 미팅이 들어갈 프로젝트", onchange: (e) => APP.setCurrentProject(APP.projectId(e.target.value)) }, projOptions()));
      else if (APP.projects.length === 1) ps.appendChild(h("div", { class: "m", style: "font-size:12.5px;color:var(--muted);padding:0 2px", text: APP.projects[0].name }));
    }
    const m = $("menu"); m.textContent = "";''')
# Claude 전용 안내 정리
script = rep(script, '''    if (S.mode === "live" && S.canWrite === false) main.appendChild(h("div", { class: "notice" }, "보기 권한으로 열었습니다. 승인, 상태 변경, 새로 만들기를 하려면 PM에게 참여자(Contributor) 권한을 요청하세요."));\n''', "")
script = rep(script, '''    server_not_connected: "PC 에이전트에 닿지 않습니다. 설치하기.bat을 실행한 PC의 Claude 데스크톱 앱에서 Desk를 열어야 합니다. 브라우저에서는 '파일에서 가져오기'를 쓰세요.",''',
             '''    server_not_connected: "이 PC에는 카톡 에이전트가 없습니다. 카톡 점검은 PM의 Windows PC에 설치한 ODD HR 앱에서 돕니다.",''')
script = re.sub(r'h\("span", \{ class: "pill ok", text: "Claude 크레딧 0" \}\)', 'h("span", { class: "pill ok", text: "추가 비용 0" })', script)
script = script.replace('"이번 주 상태 변화로 초안을 만듭니다. 본인이 고쳐서 제출하세요. Claude 크레딧을 쓰지 않습니다."', '"이번 주 상태 변화로 초안을 만듭니다. 본인이 고쳐서 제출하세요."')
script = rep(script, '''        h("div", { class: "msg", style: "color:var(--muted)", text: "자동 정리는 무료입니다. AI 요약은 더 매끄럽지만 누른 사람의 Claude 사용량을 씁니다." }),''',
             '''        h("div", { class: "msg", style: "color:var(--muted)", text: "자동 정리는 노트 문장에서 결정 사항과 액션 아이템을 골라 줍니다. 고른 것은 작업 제안으로 올릴 수 있습니다." }),''')
script = rep(script, '''"Claude 크레딧을 쓰지 않습니다. 카톡 점검은 PM PC의 Windows 작업 스케줄러가 돌리고, 나머지는 Desk가 바로 계산합니다."''',
             '''"추가 비용이 들지 않습니다. 카톡 점검은 PM의 Windows PC에서 ODD HR 앱이 돌리고, 나머지는 앱이 바로 계산합니다."''')
script = rep(script, '''      S.isOwner ? null : h("div", { class: "notice", text: "PC 에이전트 직접 연결은 Desk 주인(PM)의 Claude 데스크톱 앱에서만 됩니다." }),''',
             '''      S.isOwner ? null : h("div", { class: "notice", text: "카톡 에이전트는 PM의 Windows PC에서 ODD HR 앱이 켜져 있을 때 돕니다. 대화방과 간격은 설정에서 바꿉니다." }),''')
script = rep(script, '''        h("span", { class: "msg", style: "color:var(--muted)", text: "Claude 앱 밖(브라우저)에서는 PC의 %LOCALAPPDATA%\\\\ODD-HR\\\\outbox 파일을 올리세요." })),''',
             '''        h("span", { class: "msg", style: "color:var(--muted)", text: "다른 PC의 카톡 에이전트가 만든 %LOCALAPPDATA%\\\\ODD-HR\\\\outbox 파일을 올려도 됩니다." })),''')
script = rep(script, '''[["ODD HR 기획서", LINKS.plan, "원칙, 역할, 운영 규칙"], ["작업", "#tasks", "제안과 할 일 (이 화면의 저장소)"]''', '''[["작업", "#tasks", "제안과 할 일 (팀 서버)"]''')
script = script.replace('"목표와 진행률 (이 화면의 저장소)"', '"목표와 진행률 (팀 서버)"').replace('"미팅 노트와 요약 (이 화면의 저장소)"', '"미팅 노트와 요약 (팀 서버)"')
script = script.replace('"프로젝트 목표와 진행률 (이 화면의 저장소)"', '"프로젝트 목표와 진행률 (팀 서버)"')
script = rep(script, 'pageHead("에이전트", "ODD HR에서 일하는 에이전트와 각자 읽는 것, 하는 것, 하지 않는 것입니다. 기본 기능은 모두 Claude 크레딧 없이 돕니다.")',
             'pageHead("에이전트", "ODD HR에서 일하는 에이전트와 각자 읽는 것, 하는 것, 하지 않는 것입니다. 모든 기능이 추가 비용 없이 돕니다.")')
# 앱에서는 카톡 점검을 앱이 직접 돌린다 (가져오기만 하는 대신 점검 + 가져오기, 창을 내려 둬도 계속)
script = rep(script, '''    pullTimer = setInterval(() => { if (document.visibilityState !== "hidden" && S.pc.state !== "busy") pcSync(false, true); }, 180000);''',
             '''    const every = Math.max(60, Number((S.pc.status && S.pc.status.interval_sec) || 180)) * 1000;
    pullTimer = setInterval(() => { if (S.pc.state !== "busy" && lsGet("oddhr.autoscan") !== "0") pcSync(true, true); }, every);''')
script = rep(script, '''    if (autoTried || !S.db || !S.mcp || !S.isOwner || lsGet("oddhr.pc") !== "1") return;
    autoTried = true;
    pcSync(false, true);''', '''    if (autoTried || !S.db || !S.mcp || !S.isOwner) return;
    autoTried = true;
    pcSync(false, true).then(() => startAutoPull());''')
# 앱 연결부가 바뀌면(프로젝트, 멤버, 화면 설정) 다시 그린다
script = rep(script, '''  S.view = (VIEWS.find(([v]) => v === location.hash.replace("#", "")) || ["home"])[0];
  render();''', '''  S.view = (VIEWS.find(([v]) => v === location.hash.replace("#", "")) || ["home"])[0];
  render();
  if (APP) APP.onChange(() => { syncProjects(); paint(); });
  if (window.oddhr && window.oddhr.onCheckNow) window.oddhr.onCheckNow(() => { go("agents"); pcSync(true, false); });''')

script = rep(script, '''      if (!quiet || r.added || r.flagged) S.flash.pc = { ok: true, text: scanNote + importText(r) };''',
             '''      if (!quiet || r.added || r.flagged) S.flash.pc = { ok: true, text: scanNote + importText(r) };
      if (quiet && (r.added || r.flagged) && window.oddhr && window.oddhr.notify) window.oddhr.notify("ODD HR 카톡 점검", importText(r));''')

# 에이전트 화면: 앱 기준 문구
script = script.replace('["아침상", "Desk",', '["아침상", "앱",').replace('["미팅 정리", "Desk",', '["미팅 정리", "앱",').replace('["주간 업데이트", "Desk",', '["주간 업데이트", "앱",')
script = rep(script, '"결정 사항과 액션 아이템 고르기", "AI 요약은 선택 (누른 사람의 Claude 사용)"', '"결정 사항과 액션 아이템 고르기", "고른 것을 작업 제안으로 올리기"')
script = rep(script, '"PM PC에서 돌아가는 ODD HR 자체 에이전트입니다. 3분마다 카톡 대화방을 읽고 규칙으로 할 일 후보를 골라 둡니다. Desk를 열어 두면 3분마다 가져오고, 바로 보고 싶으면 \'지금 카톡 점검하기\'를 누르세요."',
             '"PM의 Windows PC에서 ODD HR 앱 안에 들어 있는 에이전트입니다. 앱이 켜져 있으면(창을 닫아 트레이에 있어도) 정한 간격마다 카톡 대화방을 읽고, 할 일 후보를 바로 팀 서버에 제안으로 올립니다. 바로 보고 싶으면 \'지금 카톡 점검하기\'를 누르세요."')
script = re.sub(r'h\("dt", \{ text: "자동 점검" \}\), h\("dd", \{ text: st\.watch && st\.watch\.running \? .*?\}\),\n',
                'h("dt", { text: "자동 점검" }), h("dd", { text: lsGet("oddhr.autoscan") !== "0" ? `${Math.round((st.interval_sec || 180) / 60)}분마다 (앱이 켜져 있을 때)` : "꺼짐 (설정에서 켜기)" }),\n', script, count=1, flags=re.S)
script = script.replace("Claude 크레딧을 쓰지 않습니다.", "추가 비용이 들지 않습니다.")
# ---------------------------------------------------------------- 새 화면: 팀원, 설정
NEW_VIEWS = r'''
  // ---------- 팀원 (PM 버전 / 팀원 버전) ----------
  const STAGES = {
    "기획": ["리서치", "기획안", "시나리오·대본", "콘티", "섭외"],
    "디자인": ["레퍼런스", "시안", "수정", "최종 파일"],
    "촬영": ["준비", "장비 확보", "촬영", "백업"],
    "편집": ["가편집", "수정", "컬러·사운드", "자막", "최종 렌더"],
    "PM": ["기획 조율", "제작 관리", "검수", "납품"]
  };
  const STAGE_EXTRA = ["대기", "막힘", "완료"];
  const CAN_PM = ["프로젝트 만들기와 입장 코드 발급", "멤버 역할 바꾸기, PM 권한 주기, 내보내기", "할 일 완료 처리·승인·삭제", "미팅 정보 고치기", "PM 확인 필요 보기", "팀원 단계 확인 체크", "카톡 에이전트 (Windows)"];
  const CAN_MEMBER = ["할 일 만들기, 검토 요청까지 올리기", "막힘 표시", "제안 승인·넘기기", "미팅 노트와 자동 정리", "내 지금 단계 바꾸기", "오늘 결정 바 (나만 보기)"];
  const ago = (iso) => { if (!iso) return ""; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };
  const appAct = (key, fn, ok) => act(key, fn, ok);

  function viewTeam() {
    if (!APP || !APP.projects.length) return [pageHead("팀원", "들어간 프로젝트가 없습니다. 설정에서 프로젝트 코드를 넣으세요.")];
    const pid = APP.projects.some((p) => p.id === S.teamProject) ? S.teamProject : APP.currentProject;
    const proj = APP.projects.find((p) => p.id === pid) || APP.projects[0];
    const pm = APP.isPM(proj.id);
    const order = ["PM", "기획", "디자인", "촬영", "편집"];
    const members = APP.members.filter((m) => m.project_id === proj.id).sort((a, b) => (b.is_pm - a.is_pm) || (order.indexOf(a.role) - order.indexOf(b.role)) || a.name.localeCompare(b.name, "ko"));
    const tasks = S.data.tasks.filter((r) => r["프로젝트"] === proj.name);
    const n = proj.deadline ? dday(proj.deadline) : null;

    const tabs = APP.projects.length > 1 ? h("div", { class: "tabs", role: "tablist", "aria-label": "프로젝트" }, APP.projects.map((p) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(p.id === proj.id), text: p.name, onclick: () => { S.teamProject = p.id; S.teamEdit = null; render(); } }))) : null;

    const code = APP.codes[proj.id];
    const head = h("section", { class: "box" },
      h("h2", {}, proj.name, h("span", { class: "n", text: `${members.length}명` }), n !== null ? h("span", { class: "dday" + (n <= 3 ? " hot" : ""), style: "margin-left:auto", text: `${proj.deadline_label || "마감"} ${ddayText(n)}` }) : null),
      pm ? h("div", { class: "setrow" },
        h("div", { class: "lab2", text: "입장 코드" }),
        h("div", { class: "codebox" },
          code ? h("span", { class: "code", text: code }) : h("span", { class: "msg", style: "color:var(--muted)", text: "지금은 코드가 막혀 있습니다. 새 사람은 못 들어옵니다." }),
          code ? h("button", { class: "btn small", type: "button", text: "복사", onclick: async (e) => { try { await navigator.clipboard.writeText(code); e.target.textContent = "복사했습니다"; } catch (err) { e.target.textContent = "코드를 길게 눌러 선택하세요"; } } }) : null,
          h("button", { class: "btn small", type: "button", disabled: S.busy, text: code ? "새 코드 발급" : "코드 열기", title: "이전 코드는 막히고, 이미 들어온 사람은 그대로입니다", onclick: () => appAct("team", () => APP.newCode(proj.id), "새 코드를 발급했습니다. 이전 코드는 이제 안 됩니다.") }),
          code ? h("button", { class: "btn small danger", type: "button", disabled: S.busy, text: "코드 막기", onclick: () => appAct("team", () => APP.closeCode(proj.id), "코드를 막았습니다. 새 사람은 못 들어옵니다.") }) : null),
        h("div", { class: "lab2", text: "프로젝트 정보" }),
        S.teamEdit === "proj" ? h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); const f = e.target; appAct("team", async () => { await APP.updateProject(proj.id, { name: f.pname.value.trim() || proj.name, deadline: f.pdue.value || null, deadline_label: f.plabel.value.trim() || null }); S.teamEdit = null; }, "프로젝트 정보를 고쳤습니다."); } },
          h("label", { class: "field" }, "이름", h("input", { id: "pname", name: "pname", value: proj.name })),
          dateField("pdue", "마감일", { value: proj.deadline || "", placeholder: "마감 없음" }),
          h("label", { class: "field" }, "마감 이름", h("input", { id: "plabel", name: "plabel", value: proj.deadline_label || "", placeholder: "예: 편집 완료" })),
          h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit", text: "저장" }), h("button", { class: "btn", type: "button", text: "취소", onclick: () => { S.teamEdit = null; S.clearDrafts = true; render(); } })))
          : h("div", { class: "actions" }, h("span", { class: "msg", style: "color:var(--muted)", text: proj.deadline ? `${proj.deadline_label || "마감"} ${proj.deadline.slice(5).replace("-", "/")}` : "마감 없음" }), h("button", { class: "btn small", type: "button", text: "고치기", onclick: () => { S.teamEdit = "proj"; render(); } }))) : null,
      flashEl("team"));

    const cards = h("div", { class: "team-grid" }, members.map((m) => memberCard(m, proj, pm, tasks, members)));
    return [pageHead("팀원", pm ? "누가 무슨 단계에 있는지 보고, 단계를 확인하고, 역할과 코드를 관리합니다. 관리 기능은 PM에게만 보입니다." : "팀원이 지금 무슨 단계에 있는지 봅니다. 내 카드에서 내 단계를 바꾸면 PM이 확인합니다."), tabs, head, cards];
  }

  function memberCard(m, proj, pm, tasks, members) {
    const me = m.user_id === APP.uid;
    const mine = tasks.filter((r) => (r["담당자"] || "") === m.name);
    const shared = tasks.filter((r) => !r["담당자"] && r["담당 역할"] === m.role && !["완료", "기각", "제안"].includes(statusOf(r)));
    const cnt = (s) => mine.filter((r) => statusOf(r) === s).length;
    const current = mine.filter((r) => ["진행", "검토 요청", "막힘"].includes(statusOf(r))).slice(0, 3);
    const steps = STAGES[m.role] || [];
    const idx = steps.indexOf(m.stage);
    const checked = m.stage_checked_at && (!m.stage_updated_at || Date.parse(m.stage_checked_at) >= Date.parse(m.stage_updated_at) - 1000);
    const k = `${proj.id}:${m.user_id}`;
    const editing = S.teamEdit === k;

    const stepRow = h("div", { class: "steps", "aria-label": `지금 단계: ${m.stage || "정하지 않음"}` },
      steps.map((st, i) => h("span", { class: "step" + (st === m.stage ? " now" : idx > i ? " done" : ""), text: (idx > i ? "✓ " : "") + st })),
      m.stage && !steps.includes(m.stage) ? h("span", { class: "step " + (m.stage === "막힘" ? "blocked" : "now"), text: m.stage }) : null);

    const stageForm = h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); const f = e.target; appAct("team", async () => { await APP.updateMember(proj.id, m.user_id, { stage: f[`st-${m.user_id}`].value || null, stage_note: f[`sn-${m.user_id}`].value.trim() || null }); S.teamEdit = null; }, "단계를 바꿨습니다."); } },
      h("label", { class: "field" }, "지금 단계", h("select", { id: `st-${m.user_id}`, name: `st-${m.user_id}` }, h("option", { value: "", text: "정하지 않음" }), [...steps, ...STAGE_EXTRA].map((st) => { const o = h("option", { value: st, text: st }); if (st === m.stage) o.selected = true; return o; }))),
      h("label", { class: "field" }, "한 줄 메모", h("input", { id: `sn-${m.user_id}`, name: `sn-${m.user_id}`, value: m.stage_note || "", placeholder: "예: v03 수정 중, 목요일 공유", maxlength: "200" })),
      h("div", { class: "actions" }, h("button", { class: "btn primary small", type: "submit", text: "저장" }), h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.teamEdit = null; S.clearDrafts = true; render(); } })));

    const adminBox = pm && !me ? h("details", {},
      h("summary", { text: "관리" }),
      h("div", { class: "form", style: "margin-top:8px" },
        h("label", { class: "field" }, "역할", h("select", { onchange: (e) => appAct("team", () => APP.updateMember(proj.id, m.user_id, { role: e.target.value }), "역할을 바꿨습니다.") }, ["PM", "기획", "디자인", "촬영", "편집"].map((r) => { const o = h("option", { value: r, text: r }); if (r === m.role) o.selected = true; return o; }))),
        h("label", { class: "field" }, "PM 권한", h("select", { onchange: (e) => appAct("team", () => APP.updateMember(proj.id, m.user_id, { is_pm: e.target.value === "1" }), e.target.value === "1" ? "PM 권한을 줬습니다." : "PM 권한을 거뒀습니다.") }, [["0", "없음"], ["1", "있음 (관리자)"]].map(([v, l]) => { const o = h("option", { value: v, text: l }); if ((m.is_pm ? "1" : "0") === v) o.selected = true; return o; }))),
        members.length > 2 ? h("label", { class: "field" }, "기록 옮기기", h("select", { onchange: (e) => { const to = e.target.value; if (!to) return; S.teamConfirm = { kind: "transfer", k, to }; render(); } }, h("option", { value: "", text: "앱을 다시 깐 사람에게…" }), members.filter((x) => x.user_id !== m.user_id).map((x) => h("option", { value: x.user_id, text: `${x.name} (${x.role})` })))) : null,
        h("div", { class: "actions" }, h("button", { class: "btn small danger", type: "button", text: "내보내기", onclick: () => { S.teamConfirm = { kind: "remove", k }; render(); } }))),
      S.teamConfirm && S.teamConfirm.k === k ? h("div", { class: "notice", style: "margin-top:8px" },
        S.teamConfirm.kind === "remove" ? `${m.name}님을 이 프로젝트에서 내보냅니다. 만든 기록은 남습니다. ` : `${m.name}님의 역할, 단계, 만든 기록을 ${(members.find((x) => x.user_id === S.teamConfirm.to) || {}).name}님에게 옮기고 ${m.name}님 자리는 지웁니다. `,
        h("div", { class: "actions", style: "margin-top:8px" },
          h("button", { class: "btn small danger", type: "button", text: S.teamConfirm.kind === "remove" ? "내보내기" : "옮기기", onclick: () => { const c = S.teamConfirm; S.teamConfirm = null; appAct("team", () => c.kind === "remove" ? APP.removeMember(proj.id, m.user_id) : APP.transferMember(proj.id, m.user_id, c.to), c.kind === "remove" ? "내보냈습니다." : "기록을 옮겼습니다."); } }),
          h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.teamConfirm = null; render(); } }))) : null) : null;

    return h("article", { class: "mcard" + (me ? " me" : ""), "aria-label": `${m.name} ${m.role}` },
      h("div", { class: "mhead" },
        h("div", { class: "avatar", "aria-hidden": "true", text: (m.name || "?").slice(0, 1) }),
        h("div", { style: "min-width:0" },
          h("div", { class: "nm" }, m.name, me ? h("span", { class: "pill info", text: "나" }) : null, m.is_pm ? h("span", { class: "pill ai", text: "PM" }) : null),
          h("div", { class: "sub2", text: `${m.role}${m.stage_updated_at ? ` · 단계 바꾼 지 ${ago(m.stage_updated_at)}` : ""}` }))),
      editing ? stageForm : [stepRow,
        m.stage_note ? h("div", { class: "quote", style: "padding:8px 12px", text: m.stage_note }) : null,
        h("div", { class: "actions" },
          checked ? h("span", { class: "checked", text: `✓ PM 확인 ${String(m.stage_checked_at).slice(5, 10).replace("-", "/")}` }) : m.stage ? h("span", { class: "pill", text: "PM 확인 전" }) : null,
          pm && m.stage && !checked ? h("button", { class: "btn small primary", type: "button", disabled: S.busy, text: "단계 확인", onclick: () => appAct("team", () => APP.updateMember(proj.id, m.user_id, { stage_checked_at: new Date().toISOString(), stage_checked_by: APP.uid }), `${m.name}님 단계를 확인했습니다.`) }) : null,
          me || pm ? h("button", { class: "btn small", type: "button", text: me ? "내 단계 바꾸기" : "단계 바꾸기", onclick: () => { S.teamEdit = k; render(); } }) : null)],
      h("div", { class: "mstats" }, h("span", {}, "진행 ", h("b", { text: String(cnt("진행")) })), h("span", {}, "검토 요청 ", h("b", { text: String(cnt("검토 요청")) })), h("span", {}, "막힘 ", h("b", { text: String(cnt("막힘")) })), shared.length ? h("span", {}, `${m.role} 공용 `, h("b", { text: String(shared.length) })) : null),
      current.length ? h("div", { class: "rows" }, current.map((r) => h("div", { class: "row", style: "padding:7px 6px" }, h("span", { class: "check " + (CHECK[statusOf(r)] || "") , "aria-hidden": "true" }), h("div", {}, h("div", { class: "t", style: "font-size:14px", text: r["할 일"] }), h("div", { class: "m", text: `${statusOf(r)}${r["마감"] ? " · " + ddayText(dday(r["마감"])) : ""}` })), h("span")))) : h("div", { class: "msg", style: "color:var(--muted)", text: "맡은 할 일 중 진행 중인 것이 없습니다." }),
      h("details", {}, h("summary", { text: "할 수 있는 일" }), h("ul", {}, (m.is_pm ? CAN_PM : CAN_MEMBER).map((x) => h("li", { text: x })))),
      adminBox);
  }

  // ---------- 설정 ----------
  function viewSettings() {
    const P = APP ? APP.prefs : { theme: "system", accent: "#F15524" };
    const themeTabs = h("div", { class: "tabs", role: "radiogroup", "aria-label": "화면 모드" }, [["system", "시스템"], ["light", "라이트"], ["dark", "다크"]].map(([v, l]) =>
      h("button", { type: "button", role: "radio", "aria-checked": String(P.theme === v), "aria-selected": String(P.theme === v), text: l, onclick: () => APP.setPrefs({ theme: v }) })));
    const hex = h("input", { class: "hexin", id: "hexin", value: P.accent, maxlength: "7", "aria-label": "키 컬러 HEX", onchange: (e) => { const v = e.target.value.trim(); if (/^#[0-9a-fA-F]{6}$/.test(v)) APP.setPrefs({ accent: v.toUpperCase() }); else e.target.value = APP.prefs.accent; } });
    const looks = h("section", { class: "box" }, h("h2", {}, "화면"),
      h("div", { class: "setrow" },
        h("div", { class: "lab2", text: "모드" }), themeTabs,
        h("div", { class: "lab2", text: "키 컬러" }),
        h("div", { class: "swatches" },
          (APP ? APP.presets : []).map(([n, c]) => h("button", { class: "swatch", type: "button", title: n, "aria-label": n, "aria-pressed": String(P.accent.toUpperCase() === c.toUpperCase()), style: `background:${c}`, onclick: () => APP.setPrefs({ accent: c }) })),
          h("input", { class: "colorpick", type: "color", value: P.accent, "aria-label": "키 컬러 직접 고르기", oninput: (e) => { $("hexin").value = e.target.value.toUpperCase(); document.documentElement.style.setProperty("--blue", e.target.value); }, onchange: (e) => APP.setPrefs({ accent: e.target.value.toUpperCase() }) }),
          hex),
        h("div", { class: "lab2", text: "미리 보기" }),
        h("div", { class: "preview" }, h("button", { class: "btn primary", type: "button", text: "주 버튼" }), h("button", { class: "btn", type: "button", text: "보조 버튼" }), h("span", { class: "check 완료", "aria-hidden": "true" }), h("span", { class: "step now", text: "지금 단계" }), h("a", { href: "#settings", text: "링크" }), h("span", { class: "pill info", text: "태그" }))));

    if (!APP) return [pageHead("설정", ""), looks];
    const myRows = APP.projects.map((p) => ({ p, m: APP.myMember(p.id) })).filter((x) => x.m);
    const profile = h("section", { class: "box" }, h("h2", {}, "내 정보"),
      h("p", { class: "sub", text: APP.isAnon ? "코드로 들어온 계정입니다. 이름은 프로젝트마다 따로 정할 수 있습니다." : `PM 계정 · ${APP.email || ""}` }),
      h("div", { class: "rows" }, myRows.map(({ p, m }) => h("form", { class: "row", style: "grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) auto", onsubmit: (e) => { e.preventDefault(); const v = e.target.querySelector("input").value.trim(); if (!v) return; appAct("settings", () => APP.updateMember(p.id, m.user_id, { name: v }), "이름을 바꿨습니다."); } },
        h("div", {}, h("div", { class: "t", text: p.name }), h("div", { class: "m" }, h("span", { class: "pill", text: m.role }), m.is_pm ? h("span", { class: "pill ai", text: "PM" }) : null, p.id === APP.currentProject ? h("span", { class: "pill info", text: "기본" }) : null)),
        h("label", { class: "field" }, h("span", { class: "sr-only", text: "이 프로젝트에서 쓸 이름" }), h("input", { id: `myname-${p.id}`, value: m.name, maxlength: "40", "aria-label": `${p.name}에서 쓸 이름` })),
        h("button", { class: "btn small", type: "submit", text: "저장" })))),
      flashEl("settings"));

    const joinCode = h("input", { id: "joincode", placeholder: "ODD-XXXX-XXXX", maxlength: "20", style: "font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase" });
    const cur = APP.myMember(APP.currentProject) || myRows[0] && myRows[0].m || {};
    const projects = h("section", { class: "box" }, h("h2", {}, "프로젝트"),
      h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); const c = joinCode.value.trim(); if (!c) return; appAct("settings", async () => { await APP.joinProject({ code: c, name: cur.name || "팀원", role: cur.role || "기획" }); joinCode.value = ""; }, "새 프로젝트에 들어왔습니다. 팀원 탭에서 내 역할을 확인하세요."); } },
        h("label", { class: "field" }, "다른 프로젝트 코드 넣기", joinCode),
        h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit", text: "들어가기" }))),
      !APP.isAnon ? h("div", { class: "actions" }, h("button", { class: "btn", type: "button", text: "새 프로젝트 만들기", onclick: () => APP.showCreateProject() }), h("span", { class: "msg", style: "color:var(--muted)", text: "만들면 입장 코드가 바로 나옵니다. 코드는 팀원 탭에서도 봅니다." })) : null);

    const agentBox = APP.agentAvailable && APP.isPMAny() ? agentSettings() : null;

    const account = h("section", { class: "box" }, h("h2", {}, "계정과 서버"),
      h("dl", { class: "kv" },
        h("dt", { text: "계정" }), h("dd", { text: APP.isAnon ? "코드로 들어온 계정 (이 PC에만 저장)" : APP.email || "" }),
        h("dt", { text: "서버" }), h("dd", { text: (APP.serverUrl || "").replace(/^https:\/\//, "") }),
        h("dt", { text: "실시간" }), h("dd", { text: APP.live ? "연결됨" : "다시 연결하는 중" }),
        h("dt", { text: "앱 버전" }), h("dd", { text: APP.version || "-" })),
      APP.isPMAny() && APP.connectionString() ? h("div", { class: "actions" }, h("button", { class: "btn small", type: "button", text: "서버 연결 문자열 복사", title: "설치 파일에 서버가 안 들어 있을 때, 팀원이 첫 화면에 붙여 넣습니다", onclick: async (e) => { try { await navigator.clipboard.writeText(APP.connectionString()); e.target.textContent = "복사했습니다. 팀원에게 코드와 함께 주세요"; } catch (err) { e.target.textContent = "복사하지 못했습니다"; } } })) : null,
      S.confirmLogout ? h("div", { class: "notice" }, APP.isAnon ? "코드로 들어온 계정은 로그아웃하면 다시 들어올 수 없습니다. 코드를 다시 넣으면 새 사람으로 들어가고, PM이 팀원 탭의 '기록 옮기기'로 이전 기록을 옮겨 줘야 합니다." : "로그아웃합니다. 이메일과 비밀번호로 다시 들어올 수 있습니다.",
        h("div", { class: "actions", style: "margin-top:8px" }, h("button", { class: "btn small danger", type: "button", text: "로그아웃", onclick: () => APP.signOut() }), h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.confirmLogout = false; render(); } })))
        : h("div", { class: "actions" }, h("button", { class: "btn", type: "button", text: "로그아웃", onclick: () => { S.confirmLogout = true; render(); } })));
    return [pageHead("설정", "화면 모드와 키 컬러는 이 PC에만 저장됩니다."), looks, profile, projects, agentBox, account];
  }

  function agentSettings() {
    if (!S.agentCfg && !S.agentCfgLoading) {
      S.agentCfgLoading = true;
      APP.agent(["config-get"]).then((r) => { S.agentCfg = r.config; }).catch((e) => { S.agentCfg = { error: e.message }; }).finally(() => { S.agentCfgLoading = false; paint(); });
    }
    const c = S.agentCfg;
    if (!c) return h("section", { class: "box" }, h("h2", {}, "카톡 에이전트"), h("div", { class: "msg", text: "설정을 읽는 중입니다." }));
    if (c.error) return h("section", { class: "box" }, h("h2", {}, "카톡 에이전트"), h("div", { class: "msg err", text: c.error }));
    const rooms = c.rooms || [];
    const membersText = Object.entries(c.members || {}).map(([n, r]) => `${n}=${r}`).join(", ");
    const pmProjects = APP.projects.filter((p) => APP.isPM(p.id));
    return h("section", { class: "box" }, h("h2", {}, "카톡 에이전트", h("span", { class: "pill ok", text: "이 PC" })),
      h("p", { class: "sub", text: "이 PC의 카카오톡 대화방을 읽고 할 일 후보를 골라 팀 서버에 제안으로 올립니다. 카톡에는 아무것도 보내지 않습니다." }),
      h("form", { class: "form", onsubmit: (e) => {
        e.preventDefault();
        const f = e.target;
        const rs = f.rooms.value.split(",").map((x) => x.trim()).filter(Boolean);
        const rp = {}; rs.forEach((r, i) => { const sel = f[`rp-${i}`]; const v = sel ? sel.value : (pmProjects[0] || {}).name; if (v) rp[r] = v; });
        const mem = {}; f.members.value.split(/[,\n]/).forEach((pair) => { const [n, r] = pair.split("=").map((x) => (x || "").trim()); if (n && ["PM", "기획", "디자인", "촬영", "편집"].includes(r)) mem[n] = r; });
        const projectsKw = {}; APP.projects.forEach((p) => { projectsKw[p.name] = [p.name, ...p.name.split(/\s+/).filter((w) => w.length >= 2)]; });
        const patch = { rooms: rs, room_projects: rp, members: mem, interval_sec: Number(f.interval.value), projects: projectsKw, llm: { ...(c.llm || {}), enabled: f.llm.checked } };
        lsSet("oddhr.autoscan", f.auto.checked ? "1" : "0");
        appAct("settings", async () => { const r = await APP.agent(["config-set", JSON.stringify(patch)]); S.agentCfg = r.config; if (S.pc.status) S.pc.status.interval_sec = r.config.interval_sec; if (pullTimer) { clearInterval(pullTimer); pullTimer = null; } startAutoPull(); }, "카톡 에이전트 설정을 저장했습니다.");
      } },
        h("label", { class: "field wide" }, "감시할 대화방 (쉼표로 구분, 카톡 창 제목 그대로)", h("input", { id: "rooms", name: "rooms", value: rooms.join(", "), placeholder: "예: 양천경찰서 영상팀, 공모전 팀방" })),
        rooms.map((r, i) => h("label", { class: "field" }, `'${r}' 방의 프로젝트`, h("select", { id: `rp-${i}`, name: `rp-${i}` }, pmProjects.map((p) => { const o = h("option", { value: p.name, text: p.name }); if ((c.room_projects || {})[r] === p.name) o.selected = true; return o; })))),
        h("label", { class: "field" }, "점검 간격", h("select", { id: "interval", name: "interval" }, [[60, "1분"], [180, "3분"], [300, "5분"], [600, "10분"], [1800, "30분"]].map(([v, l]) => { const o = h("option", { value: String(v), text: l }); if (Number(c.interval_sec || 180) === v) o.selected = true; return o; }))),
        h("label", { class: "field" }, h("span", { text: "자동 점검" }), h("span", { style: "display:flex;gap:8px;align-items:center;color:var(--ink);font-size:14px" }, h("input", { class: "toggle", type: "checkbox", id: "auto", name: "auto", checked: lsGet("oddhr.autoscan") !== "0" }), "앱이 켜져 있으면 간격마다 점검")),
        h("label", { class: "field wide" }, "팀원 카톡 이름=역할 (담당 역할을 맞히는 데 씀)", h("textarea", { id: "members", name: "members", style: "min-height:60px", value: membersText, placeholder: "홍길동=편집, 김철수=촬영" })),
        h("label", { class: "field wide" }, h("span", { text: "로컬 모델 (선택)" }), h("span", { style: "display:flex;gap:8px;align-items:center;color:var(--ink);font-size:14px" }, h("input", { class: "toggle", type: "checkbox", id: "llm", name: "llm", checked: !!(c.llm && c.llm.enabled) }), `애매한 메시지만 이 PC의 Ollama(${(c.llm && c.llm.model) || "exaone3.5:7.8b"})로 다시 판정`)),
        h("label", { class: "field wide" }, h("span", { text: "컴퓨터를 켤 때" }), h("span", { style: "display:flex;gap:8px;align-items:center;color:var(--ink);font-size:14px" }, h("input", { class: "toggle", type: "checkbox", id: "atlogin", checked: !!APP.openAtLogin, onchange: async (e) => { if (APP.setLoginItem) APP.openAtLogin = await APP.setLoginItem(e.target.checked); } }), "ODD HR을 창 없이 자동으로 켜서 카톡 점검 시작")),
        h("div", { class: "actions wide" }, h("button", { class: "btn primary", type: "submit", text: "저장" }), checkNowBtn())));
  }
'''
script = rep(script, "  // ---------- 렌더 ----------", NEW_VIEWS + "\n  // ---------- 렌더 ----------")

# checkbox checked 속성은 h()가 setAttribute로 넣으므로 값이 false면 빠진다 (그대로 둠)

out_dir = ROOT / "app"
out_dir.mkdir(exist_ok=True)
html = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.supabase.in wss://*.supabase.in;">
<title>ODD HR</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap">
<style>
{style.strip()}
.sr-only {{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }}
</style>
</head>
<body>
{body.strip()}
<script src="vendor/supabase.js"></script>
<script src="shim.js"></script>
<script src="desk.js"></script>
</body>
</html>
"""
(out_dir / "index.html").write_text(html, encoding="utf-8")
(out_dir / "desk.js").write_text(script, encoding="utf-8")
print("app/index.html, app/desk.js 만듦")
