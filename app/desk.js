(() => {
  // ---------- 설정 ----------
  const APP = window.oddhrApp || null;   // 앱(데스크톱, 웹)에서만 있다. 팀 서버, 멤버, 파일 저장소
  const KEYS = ["tasks", "goals", "meetings"];
  const LINKS = { plan: "https://claude.ai/artifact/FXvnXtdmjQ1XKd1XSzbReR" };
  // 프로젝트와 마감은 서버의 내 프로젝트에서 온다 (앱 연결부가 알려 줄 때마다 다시 채운다)
  const PROJECTS = [];
  const PROJECT_DEADLINES = {};
  function syncProjects() {
    PROJECTS.length = 0;
    Object.keys(PROJECT_DEADLINES).forEach((k) => delete PROJECT_DEADLINES[k]);
    (APP ? APP.projects : []).forEach((p) => { PROJECTS.push(p.name); if (p.deadline) PROJECT_DEADLINES[p.name] = [p.deadline, p.deadline_label || "마감"]; });
  }
  syncProjects();
  const ROLES = ["PM", "기획", "디자인", "촬영", "편집", "미정"];
  const LEVELS = ["긴급", "높음", "보통", "낮음"];
  const RISK_WORDS = ["보내", "발송", "제출", "전달", "미루", "연기", "취소", "변경", "축소", "삭제"];
  const VIEWS = [
    ["home", "홈"], ["tasks", "작업"], ["todo", "할 일"], ["messages", "메시지"], ["drive", "드라이브"], ["meetings", "미팅"], ["goals", "목표"], ["forms", "양식"], ["team", "팀원"], ["agents", "에이전트"], ["settings", "설정"]
  ];

  // ---------- 상태 ----------
  const S = {
    view: "home", mode: "pending", note: "", db: null, user: null, canWrite: null, sample: null, me: null, mcp: null, isOwner: false, isPM: false, confirmDel: null, editMeeting: null, quick: [], quickReady: false, flags: [], pc: { state: null, status: null }, weekly: null,
    data: { tasks: [], goals: [], meetings: [] },
    sel: { task: null, meeting: null }, flash: {},
    filter: { role: "전체", project: "전체", showDone: false, mine: null, toMe: false },
    msgs: [], files: [], weeklies: [], chat: { ch: null }, drive: { folder: "전체", q: "", proj: null, busy: "" }, editTask: null, minutes: null, prefill: null, newProj: null, notifOpen: false,
    meetTab: "upcoming", busy: false, aiState: null, ai: null, risk: null, dismiss: null
  };
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
    }
    return e;
  }

  // ---------- 날짜 ----------
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  function dday(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    const now = new Date();
    return Math.round((new Date(y, m - 1, d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  }
  const ddayText = (n) => n === null ? "" : n === 0 ? "D-DAY" : n > 0 ? `D-${n}` : `D+${-n}`;
  const ddayEl = (iso) => { const n = dday(iso); return n === null ? null : h("span", { class: "dday" + (n <= 3 ? " hot" : ""), text: ddayText(n) }); };
  function whenText(iso) {
    if (!iso) return "일정 미정";
    const s = String(iso); const d = s.slice(5, 10).replace("-", "/");
    const t = s.length > 10 ? s.slice(11, 16) : "";
    return t ? `${d} ${t}` : d;
  }

  // ---------- 규칙 ----------
  function level(r) {
    if (LEVELS.includes(r["긴급도"])) return r["긴급도"];
    const n = dday(r["마감"]);
    if (n !== null && n <= 0) return "긴급";
    if (n !== null && n <= 2) return "높음";
    if (n !== null && n <= 7) return "보통";
    return "낮음";
  }
  const levelRank = (r) => LEVELS.indexOf(level(r));
  const risky = (r) => RISK_WORDS.some((w) => String(r["할 일"] || "").includes(w));
  const statusOf = (r) => r["상태"] || "제안";
  const roleOk = (r) => S.filter.role === "전체" || r["담당 역할"] === S.filter.role;
  const projOk = (r) => S.filter.project === "전체" || (r["프로젝트"] || "미분류") === S.filter.project;
  const proposals = () => S.data.tasks.filter((r) => statusOf(r) === "제안").sort((a, b) => levelRank(a) - levelRank(b) || (dday(a["마감"]) ?? 999) - (dday(b["마감"]) ?? 999));
  const openTodos = () => S.data.tasks.filter((r) => ["대기", "진행", "검토 요청", "막힘"].includes(statusOf(r)));

  // ---------- 사람 (프로젝트 멤버) ----------
  const pidOf = (pname) => (APP ? APP.projectId(pname) : null);
  const membersOf = (pname) => (APP ? APP.members.filter((m) => m.project_id === pidOf(pname)) : []);
  const meIn = (pname) => (APP ? APP.myMember(pidOf(pname)) || APP.myMember(APP.currentProject) || null : null);
  const myNameFor = (pname) => (meIn(pname) || {}).name || "";
  const isPMof = (pname) => (APP ? APP.isPM(pidOf(pname)) : S.isPM);
  const isMine = (r) => { const m = APP ? APP.myMember(pidOf(r["프로젝트"])) : null; if (!m) return false; return r["담당자"] ? r["담당자"] === m.name : r["담당 역할"] === m.role; };
  const curProjName = () => (APP ? APP.projectName(APP.currentProject) : "") || PROJECTS[0] || "미분류";
  const projSel = (cur) => PROJECTS.map((p) => { const o = h("option", { value: p, text: p }); if (p === (cur || curProjName())) o.selected = true; return o; });
  const T = (iso) => { const t = Date.parse(iso || ""); return isNaN(t) ? 0 : t; };
  const hm = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const mondayOf = (d) => { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); m.setHours(0, 0, 0, 0); return m; };
  const sizeText = (n) => { n = Number(n) || 0; return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`; };

  // ---------- 날짜 선택기 (브라우저 기본 달력에 기대지 않음) ----------
  const WD_KO = ["월", "화", "수", "목", "금", "토", "일"];
  const pad2 = (n) => String(n).padStart(2, "0");
  const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fromIso = (v) => { const [y, m, d] = String(v).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
  const prettyDate = (v) => { const d = fromIso(v); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD_KO[(d.getDay() + 6) % 7]})`; };
  let openPop = null;
  document.addEventListener("pointerdown", (e) => { if (openPop && !openPop.wrap.contains(e.target)) openPop.close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openPop) { const b = openPop.btn; openPop.close(); b.focus(); } });

  // name: 폼이 읽는 이름 (숨은 input). opts.quick: [[라벨, ISO]] 추가 빠른 선택. opts.time: 시간도 고름. opts.onchange(v)
  function dateField(name, label, opts = {}) {
    const hidden = h("input", { type: "hidden", name, id: name });
    const btn = h("button", { type: "button", class: "dp-btn", "aria-haspopup": "dialog", "aria-expanded": "false" });
    const clear = h("button", { type: "button", class: "dp-clear", "aria-label": `${label} 지우기`, text: "×" });
    const pop = h("div", { class: "dp-pop", hidden: true, role: "dialog", "aria-label": `${label} 고르기` });
    const wrap = h("div", { class: "dp" }, h("div", { class: "dp-row" }, btn, clear), pop);
    let val = "", time = "", view = new Date();
    const out = () => opts.time ? (val ? (time ? `${val}T${time}` : val) : "") : val;
    const paintBtn = () => {
      btn.textContent = val ? `${prettyDate(val)}${opts.time && time ? ` ${time}` : ""}` : (opts.placeholder || "날짜 고르기");
      btn.classList.toggle("empty", !val);
      clear.hidden = !val;
      hidden.value = out();
    };
    const set = (v, keepOpen) => { val = v || ""; if (val) view = fromIso(val); paintBtn(); if (opts.onchange) opts.onchange(out()); if (!keepOpen) { close(); btn.focus(); } else drawPop(); };
    function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); if (openPop && openPop.wrap === wrap) openPop = null; }
    function open() {
      if (openPop) openPop.close();
      view = val ? fromIso(val) : new Date();
      drawPop(); pop.hidden = false; btn.setAttribute("aria-expanded", "true");
      openPop = { wrap, btn, close };
      pop.style.left = "0"; pop.style.right = "auto";
      const r = pop.getBoundingClientRect();
      if (r.right > window.innerWidth - 12) { pop.style.left = "auto"; pop.style.right = "0"; }
      const first = pop.querySelector(".dp-day[aria-selected='true'], .dp-day.today, .dp-day"); if (first) first.focus();
    }
    function drawPop() {
      pop.textContent = "";
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const add = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return isoOf(d); };
      const wd = (today.getDay() + 6) % 7;
      const quick = [["오늘", add(0)], ["내일", add(1)], ["이번 주 금요일", add(wd <= 4 ? 4 - wd : 11 - wd)], ["다음 주 월요일", add(7 - wd)], ["1주 뒤", add(7)]].concat(opts.quick || []);
      pop.appendChild(h("div", { class: "dp-quick" }, quick.map(([l, v]) => h("button", { type: "button", class: "chip", "aria-pressed": String(val === v), text: l, onclick: () => set(v, !!opts.time) }))));
      const y = view.getFullYear(), m = view.getMonth();
      const nav = (n) => { view = new Date(y, m + n, 1); drawPop(); const f = pop.querySelector(".dp-nav button"); if (f) f.focus(); };
      pop.appendChild(h("div", { class: "dp-nav" },
        h("button", { type: "button", class: "dp-arrow", "aria-label": "이전 달", text: "‹", onclick: () => nav(-1) }),
        h("strong", { text: `${y}년 ${m + 1}월` }),
        h("button", { type: "button", class: "dp-arrow", "aria-label": "다음 달", text: "›", onclick: () => nav(1) })));
      const grid = h("div", { class: "dp-grid", role: "grid" });
      WD_KO.forEach((w, i) => grid.appendChild(h("span", { class: "dp-wd" + (i >= 5 ? " we" : ""), text: w })));
      const lead = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
      for (let i = 0; i < lead; i++) grid.appendChild(h("span"));
      for (let d = 1; d <= days; d++) {
        const iso = `${y}-${pad2(m + 1)}-${pad2(d)}`, dt = new Date(y, m, d), col = (lead + d - 1) % 7;
        grid.appendChild(h("button", { type: "button", class: "dp-day" + (dt.getTime() === today.getTime() ? " today" : "") + (col >= 5 ? " we" : "") + (dt < today ? " past" : ""),
          "aria-selected": String(iso === val), "aria-label": prettyDate(iso), text: String(d),
          onclick: () => set(iso, !!opts.time),
          onkeydown: (e) => {
            const mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
            if (!mv) return; e.preventDefault();
            const nd = new Date(y, m, d + mv); const niso = isoOf(nd);
            if (nd.getMonth() !== m) { view = nd; drawPop(); }
            const t = [...pop.querySelectorAll(".dp-day")].find((b) => b.getAttribute("aria-label") === prettyDate(niso)); if (t) t.focus();
          } }));
      }
      pop.appendChild(grid);
      if (opts.time) {
        const slots = []; for (let hh = 8; hh <= 22; hh++) { slots.push(`${pad2(hh)}:00`); if (hh < 22) slots.push(`${pad2(hh)}:30`); }
        const sel = h("select", { class: "dp-time", "aria-label": "시간", onchange: (e) => { time = e.target.value; paintBtn(); } }, h("option", { value: "", text: "시간 미정" }), slots.map((t) => { const o = h("option", { value: t, text: t }); if (t === time) o.selected = true; return o; }));
        pop.appendChild(h("div", { class: "dp-foot" }, h("span", { text: "시간" }), sel, h("button", { type: "button", class: "btn small primary", text: "완료", onclick: () => { close(); btn.focus(); } })));
      }
    }
    btn.addEventListener("click", () => (pop.hidden ? open() : close()));
    clear.addEventListener("click", () => { time = ""; set(""); btn.focus(); });
    if (opts.value) { const v = String(opts.value); val = v.slice(0, 10); time = v.length > 10 ? v.slice(11, 16) : ""; }
    hidden.__dpSet = (v) => { v = String(v || ""); val = v.slice(0, 10); time = v.length > 10 ? v.slice(11, 16) : ""; paintBtn(); };
    paintBtn();
    return h("div", { class: "field" + (opts.wide ? " wide" : "") }, h("span", { text: label }), wrap, hidden);
  }

  // ---------- 규칙 정리 엔진 (Claude를 부르지 않음) ----------
  const ROLE_WORDS = {
    "편집": ["편집", "렌더", "컷", "가편", "최종본", "편집본", "자막", "컬러", "색보정", "음악", "사운드", "믹싱", "엔딩", "오프닝", "길이"],
    "디자인": ["디자인", "시안", "썸네일", "포스터", "로고", "폰트", "타이포", "일러스트", "피그마", "모션", "굿즈"],
    "촬영": ["촬영", "카메라", "조명", "배터리", "삼각대", "장소 섭외", "로케", "짐벌", "렌즈", "장비"],
    "기획": ["기획", "시나리오", "콘티", "대본", "스토리보드", "기획안", "인터뷰", "레퍼런스", "원고", "내레이션"],
    "PM": ["일정표", "예산", "결재", "학과 사무실", "공지", "교수님", "제출", "경찰서"]
  };
  const SENS = /(가족|집안|부모님|병원|아파|건강|짜증|화나|불만|서운|갈등|싸웠|성적|학점|시험|스트레스|개인 ?사정|피곤|우울|컨디션)/;
  const H0 = 0xAC00;
  const jong = (ch) => { const c = ch.charCodeAt(0) - H0; return c >= 0 && c < 11172 ? c % 28 : -1; };
  const dropJong = (ch) => String.fromCharCode(ch.charCodeAt(0) - jong(ch));
  function roleOfText(t) {
    const m = t.match(/(PM|기획|디자인|촬영|편집)\s?(팀|담당|님|쪽)?\s*[:)\]]|[(\[](PM|기획|디자인|촬영|편집)[)\]]|(PM|기획|디자인|촬영|편집)\s?(팀|담당)/);
    if (m) return m[1] || m[3] || m[4];
    let best = null, score = 0;
    for (const [r, ws] of Object.entries(ROLE_WORDS)) { const n = ws.filter((w) => t.includes(w)).length; if (n > score) { best = r; score = n; } }
    return best || "미정";
  }
  function dueOf(t, refIso) {
    const ref = refIso ? new Date(refIso.slice(0, 10) + "T00:00:00") : new Date();
    const add = (n) => { const d = new Date(ref); d.setDate(d.getDate() + n); return ymd(d); };
    const wd = (ref.getDay() + 6) % 7;
    let m = t.match(/(\d{1,2})월\s?(\d{1,2})일/) || t.match(/(\d{1,2})\/(\d{1,2})(?!\d)/);
    if (m) return `${ref.getFullYear()}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
    m = t.match(/(다음\s?주|담주|이번\s?주)?\s*([월화수목금토일])요일/);
    if (m) { const tgt = "월화수목금토일".indexOf(m[2]); let off = tgt - wd; if (m[1] && /다음|담/.test(m[1])) off += 7; else if (off < 0) off += 7; return add(off); }
    if (/모레/.test(t)) return add(2);
    if (/내일/.test(t)) return add(1);
    if (/(이번\s?주\s?(안|내|중|까지)|주말)/.test(t)) return add(6 - wd);
    if (/다음\s?주/.test(t)) return add(13 - wd);
    return null;
  }
  function titleOf(line) {
    let t = line.replace(/^\s*(?:[-*•·▶]|\d{1,2}[.)])\s+/, "").replace(/^(PM|기획|디자인|촬영|편집)\s?(팀|담당)?\s*[:)\]]\s*/, "").replace(/[(\[](PM|기획|디자인|촬영|편집)[)\]]/g, "").trim();
    t = t.replace(/((다음\s?주|담주|이번\s?주)\s*)?((이번\s?)?주말|[월화수목금토일]요일|모레|내일|오늘|\d{1,2}월\s?\d{1,2}일|\d{1,2}\/\d{1,2})\s*(까지|안에|중으로|에)?\s*/g, " ").replace(/\s+/g, " ").trim();
    const rules = [
      [/(\S+?)\s?기로\s?(함|했다|했음|했어요|합의|결정)?[.!]?$/, (m) => `${m[1]}기`],
      [/(\S+)\s?(해\s?주세요|해\s?줘요?|해야\s?(함|한다|합니다|해요)|하세요)$/, (m) => `${m[1]}하기`],
      [/\s?(확인|검토|정리|수정|준비|공유|제출|섭외|예약)\s?(필요|요망|부탁)[.!]?$/, (m) => ` ${m[1]}하기`],
      [/\s?(필요할\s?듯|필요함|필요해요|필요)[.!]?$/, () => " 준비하기"],
      [/(\S+)겠습니다$/, (m) => `${m[1]}기`],
      [/(\S+)을게요?$/, (m) => `${m[1]}기`],
      [/(\S+)게요?$/, (m) => { const w = m[1], c = w.slice(-1); return jong(c) === 8 ? `${w.slice(0, -1)}${dropJong(c)}기` : `${w}기`; }]
    ];
    for (const [re, fn] of rules) { const m = t.match(re); if (m) { t = (t.slice(0, m.index) + fn(m)).trim(); break; } }
    return t.replace(/\s+/g, " ").replace(/[.,!~]+$/, "").slice(0, 80);
  }
  const DECIDE = /(하기로|기로\s?(함|했|합의|결정)|확정|결정|으로 가기로|로 가기로|정했|정함|채택|합의)/;
  const ACTION = /(할게|할께|겠습니다|해\s?주세요|부탁|필요|해야|확인|챙기|까지|담당|기로|섭외|수정|준비|제출|공유|올리|보내|정리)/;
  // 회의록 양식. [대괄호] 제목이 칸을 나눈다. 자동 정리는 [결정]과 [액션 아이템] 칸을 그대로 믿는다.
  const ACT_HEAD = "[액션 아이템] 할 일 · 담당 · 기한";
  const TEMPLATES = {
    "정기 회의": `[안건]\n- \n\n[논의]\n- \n\n[결정]\n- \n\n${ACT_HEAD}\n- \n\n[다음 회의]\n- `,
    "원온원": `[요즘 작업량]\n- \n\n[잘 되고 있는 것]\n- \n\n[막힌 것, 필요한 도움]\n- \n\n[결정]\n- \n\n${ACT_HEAD}\n- `,
    "킥오프": `[프로젝트 목표와 마감]\n- \n\n[역할 분담]\n- 기획: \n- 디자인: \n- 촬영: \n- 편집: \n\n[일정]\n- \n\n[결정]\n- \n\n${ACT_HEAD}\n- `,
    "촬영 전 점검": `[촬영 일시와 장소]\n- \n\n[장비]\n- \n\n[출연, 섭외]\n- \n\n[콘티 확인]\n- \n\n[결정]\n- \n\n${ACT_HEAD}\n- `,
    "피드백 리뷰": `[본 것] 버전, 길이\n- \n\n[좋았던 점]\n- \n\n[고칠 점]\n- \n\n[결정]\n- \n\n${ACT_HEAD}\n- `
  };
  const templateFor = (kind) => (kind === "원온원" ? "원온원" : "정기 회의");
  function autoSummarize(m, note) {
    const ref = String(m["일시"] || "").slice(0, 10) || ymd(new Date());
    const names = membersOf(m["프로젝트"]).map((x) => x.name);
    const lines = String(note || "").split(/\n+|(?<=[.!?。])\s+/).map((l) => l.trim()).filter((l) => l.replace(/[-*•·\s]/g, "").length > 1);
    const unmark = (l) => l.replace(/^\s*(?:[-*•·▶]|\d{1,2}[.)])\s+/, "").replace(/[.]+$/, "");
    const decisions = [], actions = [], rest = [];
    let sec = "", dropped = 0;
    const addAction = (a) => { if (a.title.length >= 3 && !actions.some((x) => x.title === a.title)) actions.push(a); };
    lines.forEach((l) => {
      const head = l.match(/^\[(.+?)\]/);
      if (head) { sec = /결정/.test(head[1]) ? "결정" : /액션|할 일/.test(head[1]) ? "액션" : /안건|아젠다|다음 회의|역할 분담/.test(head[1]) ? "건너뜀" : "기타"; return; }
      if (/^(기획|디자인|촬영|편집|PM)\s*:\s*$/.test(unmark(l))) return;
      if (SENS.test(l)) { dropped++; return; }
      if (sec === "건너뜀") return;
      if (sec === "결정") { decisions.push(unmark(l)); return; }
      if (sec === "액션") {
        const parts = unmark(l).split(/\s*[·|]\s*/);
        const tail = parts.slice(1).join(" ");
        const role = ROLES.find((r) => r !== "미정" && parts.slice(1).some((x) => x.trim() === r || x.includes(r))) || roleOfText(l);
        addAction({ title: titleOf(parts[0]), role, due: dueOf(tail || l, ref), who: names.find((n) => tail.includes(n)) || "" });
        return;
      }
      if (DECIDE.test(l)) decisions.push(unmark(l));
      if (ACTION.test(l) && !(/(했어요|했습니다|완료|끝났)/.test(l) && !/기로/.test(l))) addAction({ title: titleOf(l), role: roleOfText(l), due: dueOf(l, ref), who: names.find((n) => l.includes(n)) || "" });
      else rest.push(l);
    });
    const lead = rest.slice(0, 2).join(" ");
    const summary = `${lead ? lead + " " : ""}결정 ${decisions.length}건, 액션 아이템 ${actions.length}건.${dropped ? " 민감할 수 있는 문장은 정리에서 뺐습니다." : ""}`;
    return { url: m.url, note, summary: summary.slice(0, 1500), decisions: decisions.slice(0, 20), actions: actions.slice(0, 30), engine: "자동 정리" };
  }
  function minutesText(m, note) {
    const sect = (t, v) => [`■ ${t}`, String(v || "").trim() || "(없음)", ""];
    return [`회의록: ${m["제목"] || "(제목 없음)"}`, `일시: ${m["일시"] ? String(m["일시"]).slice(0, 16).replace("T", " ") : "미정"}`, `종류: ${m["종류"] || "-"} · 프로젝트: ${m["프로젝트"] || "미분류"}`, `참석자: ${m["참석자"] || "-"}`, `안건: ${m["아젠다"] || "-"}`, "",
      ...sect("요약", m["요약"]), ...sect("결정 사항", m["결정 사항"]), ...sect("액션 아이템", m["액션 아이템"]), ...sect("노트", note !== undefined ? note : m["노트"]),
      `ODD HR 작성 · ${ymd(new Date())}`].join("\n");
  }
  function weeklyDraft(role, name, project) {
    const now = new Date(); const monday = mondayOf(now);
    const mine = S.data.tasks.filter((r) => (!project || (r["프로젝트"] || "미분류") === project) && (name ? (r["담당자"] || "") === name || (!r["담당자"] && r["담당 역할"] === role) : r["담당 역할"] === role));
    const touched = (r) => { const t = Date.parse(r["수정"] || r["생성"] || ""); return !isNaN(t) && t >= monday.getTime(); };
    const line = (r) => `- ${r["할 일"]}${r["프로젝트"] && r["프로젝트"] !== "미분류" ? ` (${r["프로젝트"]})` : ""}${r["마감"] ? ` · 마감 ${String(r["마감"]).slice(5).replace("-", "/")}` : ""}`;
    const done = mine.filter((r) => statusOf(r) === "완료" && touched(r));
    const doing = mine.filter((r) => ["진행", "검토 요청", "대기"].includes(statusOf(r)));
    const blocked = mine.filter((r) => statusOf(r) === "막힘");
    const sect = (title, rows, extra) => [title, ...(rows.length ? rows.slice(0, 6).map((r) => line(r) + (extra ? extra(r) : "")) : ["- 기록 없음"])].join("\n");
    return [
      `${name || role}${project ? ` · ${project}` : ""} · ${monday.getMonth() + 1}/${monday.getDate()} 주`,
      "",
      sect("끝낸 것", done),
      "",
      sect("진행 중인 것", doing, (r) => ` · ${statusOf(r)}`),
      "",
      sect("막힌 것", blocked, () => " · 필요한 도움: (적어 주세요)"),
      "",
      "다음 주에 할 것",
      "- "
    ].join("\n");
  }

  // ---------- 오늘 결정 바: 자유롭게 적으면 남은 시간과 종류로 나눈다 ----------
  const DECIDE_WORDS = /(결정|정하|정할|고르|골라|선택|승인|확정|할지|말지|여부|할까|갈까|vs|VS|어느|어떤|컨펌|판단|채택|거절|수락|ok할|OK할|허락|합의)/;
  const NOW_WORDS = /(지금|당장|바로|즉시|급함|급해|급히|긴급|ASAP|asap|빨리|오늘 ?오전|점심 ?전|1시간 ?안|한 ?시간 ?안)/;
  function timeOf(t) {
    // "오후 3시", "3시 반", "15시", "15:30", "저녁", "점심" → [시, 분]
    let m = t.match(/(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*(?:시|:)\s*(반|\d{1,2})?\s*(?:분)?/);
    if (m) {
      let hh = Number(m[2]), mm = m[3] === "반" ? 30 : Number(m[3] || 0);
      if (/(오후|저녁|밤)/.test(m[1] || "") && hh < 12) hh += 12;
      if (!m[1] && hh >= 1 && hh <= 7) hh += 12;   // "3시"는 보통 오후 3시
      if (hh <= 23 && mm <= 59) return [hh, mm];
    }
    if (/점심/.test(t)) return [12, 0];
    if (/(오전 ?중|오전까지)/.test(t)) return [12, 0];
    if (/(오후 ?중|오후까지)/.test(t)) return [18, 0];
    if (/저녁/.test(t)) return [19, 0];
    if (/(밤|자기 ?전)/.test(t)) return [23, 0];
    return null;
  }
  function judgeQuick(q, now) {
    const t = q.text || "";
    now = now || new Date();
    const today = ymd(now);
    const dIso = dueOf(t, today);
    const tm = timeOf(t);
    let deadline = null;
    if (dIso || tm) {
      const base = dIso ? fromIso(dIso) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (tm) base.setHours(tm[0], tm[1], 0, 0); else base.setHours(23, 59, 0, 0);
      deadline = base;
    }
    const kind = DECIDE_WORDS.test(t) ? "결정" : "수행";
    const hours = deadline ? (deadline - now) / 3600000 : null;
    // 관련 프로젝트 마감이 가까우면 한 단계 올린다
    let proj = null;
    for (const [p, [d, what]] of Object.entries(PROJECT_DEADLINES)) {
      const key = p.split(" ")[0].replace("경찰서", "");
      if (t.includes(key) || (p.includes("공모전") && t.includes("공모전")) || (p.includes("경찰서") && /경찰서|양천/.test(t))) { proj = { p, d, what, n: dday(d) }; break; }
    }
    let bucket, why;
    if (NOW_WORDS.test(t) || (hours !== null && hours <= 3)) { bucket = "지금"; why = hours !== null ? (hours < 0 ? "기한이 지났습니다" : `${hours < 1 ? Math.max(1, Math.round(hours * 60)) + "분" : Math.round(hours * 10) / 10 + "시간"} 남음`) : "급하다고 적었습니다"; }
    else if (hours !== null && deadline && ymd(deadline) === today) { bucket = "오늘"; why = `오늘 ${pad2(deadline.getHours())}:${pad2(deadline.getMinutes())}까지${tm ? ` · ${Math.round(hours)}시간 남음` : ""}`; }
    else if (hours === null) { bucket = "오늘"; why = "기한을 안 적어 오늘 할 일로 봅니다"; }
    else if (hours <= 48) { bucket = "내일"; why = `${deadline.getMonth() + 1}/${deadline.getDate()}${tm ? ` ${pad2(deadline.getHours())}:${pad2(deadline.getMinutes())}` : ""}까지`; }
    else if (hours <= 24 * 7) { bucket = "이번 주"; why = `${deadline.getMonth() + 1}/${deadline.getDate()}까지 · D-${dday(ymd(deadline))}`; }
    else { bucket = "나중"; why = `${deadline.getMonth() + 1}/${deadline.getDate()}까지`; }
    const order = ["지금", "오늘", "내일", "이번 주", "나중"];
    if (proj && proj.n !== null && proj.n <= 7 && bucket !== "지금") {
      bucket = order[Math.max(0, order.indexOf(bucket) - 1)];
      why += ` · ${proj.p} ${proj.what} D-${proj.n}라 앞당김`;
    }
    return { kind, bucket, why, deadline, rank: order.indexOf(bucket) * 1e13 + (deadline ? deadline.getTime() : now.getTime() + 864e5) };
  }

  let quickUnsub = null;
  function quickCol() { return S.db && S.me ? S.db.collection(`data/users/${S.me}`) : null; }
  function subscribeQuick() {
    const col = quickCol();
    if (!col || quickUnsub) return;
    quickUnsub = col.onSnapshot((snap) => {
      S.quick = snap.docs.filter((d) => d.id.startsWith("q-")).map((d) => ({ ...d.data(), url: d.id }));
      S.quickReady = true; paint();
    }, () => { S.quickReady = true; });
  }
  async function addQuick(raw) {
    const lines = String(raw || "").split(/\n+/).map((l) => l.replace(/^\s*(?:[-*•·▶]|\d{1,2}[.)])\s+/, "").trim()).filter((l) => l.length > 1).slice(0, 20);
    if (!lines.length) return 0;
    const col = quickCol();
    for (const text of lines) {
      const doc = { text: text.slice(0, 300), done: false, created: new Date().toISOString() };
      if (col) await col.doc(`q-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`).set(doc);
      else S.quick.push({ ...doc, url: `q-local-${S.quick.length}` });
    }
    return lines.length;
  }
  async function quickSet(q, patch) {
    const col = quickCol();
    if (col) { if (patch === null) await col.doc(q.url).delete(); else await col.doc(q.url).update(patch); }
    else { const i = S.quick.indexOf(q); if (patch === null) S.quick.splice(i, 1); else Object.assign(q, patch); }
  }
  function quickBox() {
    const now = new Date();
    const items = S.quick.filter((q) => !q.done).map((q) => ({ q, j: judgeQuick(q, now) })).sort((a, b) => a.j.rank - b.j.rank);
    const doneToday = S.quick.filter((q) => q.done && String(q.doneAt || "").slice(0, 10) === ymd(now));
    const nowDecide = items.filter((x) => x.j.bucket === "지금" && x.j.kind === "결정");
    const nowDo = items.filter((x) => x.j.bucket === "지금" && x.j.kind === "수행");
    const later = items.filter((x) => x.j.bucket !== "지금");
    const itemRow = (x, showKind) => h("div", { class: "row" },
      h("button", { class: "check", type: "button", "aria-label": `${x.q.text} 끝냄`, title: "끝냄", onclick: () => act("quick", () => quickSet(x.q, { done: true, doneAt: new Date().toISOString() }), "끝낸 것으로 표시했습니다.") }),
      h("div", {}, h("div", { class: "t", text: x.q.text }),
        h("div", { class: "m" }, showKind ? h("span", { class: "pill" + (x.j.kind === "결정" ? " info" : ""), text: x.j.kind }) : null,
          h("span", { class: "pill" + (x.j.bucket === "지금" ? " risk" : ""), text: x.j.bucket === "지금" ? "지금 당장" : x.j.bucket }), h("span", { text: x.j.why }))),
      h("div", { class: "actions" },
        h("button", { class: "btn small", type: "button", title: "팀 할 일로 보내기 (PM 담당)", text: "할 일로", onclick: () => act("quick", async () => {
          const p = { "할 일": x.q.text, "상태": "대기", "프로젝트": "미분류", "담당 역할": "PM", "출처": "오늘 결정 바", "작성": "사람 작성", "긴급도": x.j.bucket === "지금" ? "긴급" : x.j.bucket === "오늘" ? "높음" : x.j.bucket === "나중" ? "낮음" : "보통" };
          if (x.j.deadline) p["마감"] = ymd(x.j.deadline);
          await createPages("tasks", [p]); await quickSet(x.q, { done: true, doneAt: new Date().toISOString(), sentToTasks: true });
        }, "할 일 화면으로 보냈습니다.") }),
        h("button", { class: "btn small danger", type: "button", "aria-label": `${x.q.text} 지우기`, text: "지우기", onclick: () => act("quick", () => quickSet(x.q, null), "지웠습니다.") })));
    const col = (title, list, empty) => h("div", { class: "quick-col" },
      h("div", { class: "group-title" }, title, h("span", { text: String(list.length) })),
      list.length ? h("div", { class: "rows" }, list.map((x) => itemRow(x, false))) : h("div", { class: "msg", style: "color:var(--muted);padding:6px 0", text: empty }));
    const input = h("textarea", { id: "quickIn", class: "quick-in", rows: 1, placeholder: "오늘 결정하거나 해야 할 것을 자유롭게 적고 Enter. 예: 오후 3시까지 썸네일 A/B 중 결정 · 교수님 메일 회신 급함 · 내일 장비 대여 신청",
      onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } },
      oninput: (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(160, e.target.scrollHeight) + "px"; } });
    const submit = () => { const v = input.value; if (!v.trim()) return; S.clearDrafts = true; act("quick", async () => { const n = await addQuick(v); input.value = ""; return n; }, "적었습니다. 남은 시간에 맞춰 나눴습니다."); };
    return h("section", { class: "box quick" },
      h("h2", {}, "오늘 내가 결정할 것"),
      h("div", { class: "quick-bar" }, input, h("button", { class: "btn primary", type: "button", text: "추가", onclick: submit })),
      h("p", { class: "sub", style: "margin:0", text: "적은 문장에서 시각과 날짜를 읽어 남은 시간을 계산합니다. '결정, 고르기, 승인, 할지' 같은 말이 있으면 결정, 아니면 수행으로 나눕니다. 3시간 안이거나 '급함, 당장'이라고 적으면 지금 당장입니다. 이 목록은 나만 봅니다." }),
      h("div", { class: "quick-now" },
        col("지금 당장 결정할 것", nowDecide, "지금 결정할 것은 없습니다."),
        col("지금 당장 수행할 것", nowDo, "지금 할 것은 없습니다.")),
      later.length ? h("div", {}, h("div", { class: "group-title" }, "그다음", h("span", { text: String(later.length) })), h("div", { class: "rows" }, later.map((x) => itemRow(x, true)))) : null,
      doneToday.length ? h("div", { class: "msg", style: "color:var(--muted)", text: `오늘 끝낸 것 ${doneToday.length}건` }) : null,
      flashEl("quick"));
  }

  // ---------- 예시 데이터 ----------
  function exampleData() {
    return {
      tasks: [
        { url: "ex-t1", "할 일": "편집본 v02 드라이브에 올리기", "상태": "제안", "프로젝트": "양천경찰서 영상", "담당 역할": "편집", "담당자": "편집 담당", "마감": shift(1), "근거 메시지": "[편집] [오후 3:10] 편집본 v02 내일 오전까지 드라이브에 올릴게요", "확신도": "높음", "작성": "ODD HR 작성", "출처": "카카오톡", "대화방": "예시 팀방", "긴급도": "높음" },
        { url: "ex-t2", "할 일": "경찰서 담당자에게 시사본 링크 보내기", "상태": "제안", "프로젝트": "양천경찰서 영상", "담당 역할": "PM", "마감": shift(0), "근거 메시지": "[PM] [오후 3:00] 경찰서 담당자님께 시사본 링크 보내 주세요", "확신도": "높음", "작성": "ODD HR 작성", "출처": "카카오톡", "대화방": "예시 팀방", "긴급도": "긴급" },
        { url: "ex-t3", "할 일": "음악 저작권 확인하기", "상태": "제안", "프로젝트": "장기실종아동 공모전", "담당 역할": "미정", "마감": shift(6), "근거 메시지": "[편집] [오후 4:00] 음악 저작권 확인은 누가 하나요?", "확신도": "중간", "작성": "ODD HR 작성", "출처": "카카오톡", "대화방": "예시 팀방" },
        { url: "ex-t4", "할 일": "촬영 장소 섭외 확정", "상태": "막힘", "프로젝트": "장기실종아동 공모전", "담당 역할": "촬영", "담당자": "촬영 담당", "마감": shift(2), "작성": "사람 작성", "출처": "직접 입력" },
        { url: "ex-t5", "할 일": "엔딩 10초 줄이기", "상태": "진행", "프로젝트": "양천경찰서 영상", "담당 역할": "편집", "담당자": "편집 담당", "마감": shift(4), "작성": "ODD HR 작성", "출처": "회의록", "출처 미팅": "예시: 주간 제작 회의" },
        { url: "ex-t6", "할 일": "썸네일 시안 3종 검토 받기", "상태": "검토 요청", "프로젝트": "양천경찰서 영상", "담당 역할": "디자인", "담당자": "디자인 담당", "마감": shift(3), "작성": "사람 작성", "출처": "직접 입력" },
        { url: "ex-t7", "할 일": "자막 폰트 라이선스 확인", "상태": "대기", "프로젝트": "장기실종아동 공모전", "담당 역할": "디자인", "마감": shift(5), "작성": "ODD HR 작성", "출처": "회의록", "출처 미팅": "예시: 주간 제작 회의", "효과": "도움 됨" }
      ],
      goals: [
        { url: "ex-g1", "목표": "양천경찰서 영상 11/27 편집 완료", "프로젝트": "양천경찰서 영상", "담당 역할": "PM", "마감": "2026-11-27", "진행률": 0.6, "상태": "진행 중" },
        { url: "ex-g2", "목표": "시나리오 최종본 확정", "프로젝트": "양천경찰서 영상", "상위 목표": "양천경찰서 영상 11/27 편집 완료", "담당 역할": "기획", "진행률": 1, "상태": "완료" },
        { url: "ex-g3", "목표": "가편집 v02 교수님 피드백 반영", "프로젝트": "양천경찰서 영상", "상위 목표": "양천경찰서 영상 11/27 편집 완료", "담당 역할": "편집", "진행률": 0.4, "상태": "진행 중", "최근 업데이트": "엔딩 길이 조정 중" },
        { url: "ex-g4", "목표": "공모전 12/1 접수", "프로젝트": "장기실종아동 공모전", "담당 역할": "PM", "마감": "2026-12-01", "진행률": 0.3, "상태": "진행 중" }
      ],
      meetings: [
        { url: "ex-m1", "제목": "예시: 주간 제작 회의", "종류": "정기 회의", "프로젝트": "양천경찰서 영상", "일시": shift(-2) + "T14:00:00", "참석자": "PM, 기획, 편집, 디자인", "아젠다": "가편집 피드백, 썸네일 방향", "노트": "엔딩이 길다는 의견. 10초 줄이기로. 자막 폰트 라이선스 확인 필요.", "요약": "가편집 엔딩을 10초 줄이고 자막 폰트 라이선스를 확인하기로 했다.", "결정 사항": "엔딩 10초 단축", "액션 아이템": "엔딩 10초 줄이기 (편집)\n자막 폰트 라이선스 확인 (디자인)", "만족도": "좋음" },
        { url: "ex-m2", "제목": "예시: 편집 담당 원온원", "종류": "원온원", "프로젝트": "양천경찰서 영상", "일시": shift(1) + "T16:00:00", "참석자": "PM, 편집", "아젠다": "작업량, 막힌 점" },
        { url: "ex-m3", "제목": "예시: 공모전 킥오프", "종류": "임시 회의", "프로젝트": "장기실종아동 공모전", "참석자": "전원" }
      ]
    };
  }

  // ---------- 데이터베이스 (Desk 내장) ----------
  const ERR = {
    invalid_argument: "저장 권한이 없거나 값이 잘못됐습니다. 보기 권한만 있다면 PM에게 참여자(Contributor) 권한을 요청하세요.",
    resource_exhausted: "요청이 너무 많습니다. 잠시 뒤 다시 누르세요.",
    quota_exceeded: "저장 공간이 가득 찼습니다. 끝난 작업을 정리한 뒤 다시 시도하세요.",
    unavailable: "저장소가 잠시 응답하지 않습니다. 잠시 뒤 다시 누르세요.",
    revoked: "이 화면의 접근 권한이 바뀌었습니다. 새로고침하세요."
  };
  const errText = (e) => ERR[e && e.code] || (e && e.code === "local" ? e.message : "저장하지 못했습니다. 잠시 뒤 다시 시도하세요.");
  const stamp = () => `${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준`;

  const live = { got: {}, timer: null, unsub: [] };
  function subscribe() {
    live.unsub.forEach((u) => { try { u(); } catch (e) {} });
    live.unsub = []; live.got = {};
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (S.mode === "live") S.note = "저장소에 닿지 않아 최신이 아닐 수 있습니다";
      else { S.mode = "live"; S.note = "저장소에 아직 닿지 않았습니다. 잠시 뒤 새로고침하세요"; }
      paint();
    }, 10000);
    KEYS.forEach((k) => {
      live.unsub.push(S.db.collection(k).onSnapshot((snap) => {
        S.data[k] = snap.docs.map((d) => ({ ...d.data(), url: d.id }));
        if (!snap.metadata.fromCache) live.got[k] = true;
        if (KEYS.every((x) => live.got[x])) { clearTimeout(live.timer); S.note = stamp(); }
        S.mode = "live";
        paint();
      }, (e) => {
        clearTimeout(live.timer);
        S.mode = "live";
        S.note = e && e.code === "revoked" ? "접근 권한이 바뀌었습니다" : "일부 데이터를 불러오지 못했습니다. 새로고침하세요";
        paint();
      }));
    });
  }

  let extraUnsub = [];
  function subscribeExtra() {
    if (!APP || !S.db) return;
    extraUnsub.forEach((u) => { try { u(); } catch (e) {} });
    const on = (col, key, sort) => S.db.collection(col).onSnapshot((snap) => { S[key] = snap.docs.map((d) => ({ ...d.data(), url: d.id })).sort(sort); paint(); }, () => {});
    extraUnsub = [
      on("messages", "msgs", (a, b) => T(a.at) - T(b.at)),
      on("files", "files", (a, b) => T(b.at) - T(a.at)),
      on("weekly", "weeklies", (a, b) => T(b["제출"]) - T(a["제출"])),
      on("forms", "forms", (a, b) => T(b.at) - T(a.at))
    ];
  }

  // 다른 사람이 저장해도 입력 중인 칸이 지워지지 않게, 입력 중엔 다시 그리기를 미룬다
  let deferred = false;
  const editing = () => {
    const a = document.activeElement;
    if (document.querySelector("#main .dp-pop:not([hidden])")) return true;
    return !!(a && a.closest && a.closest("#main, #drawer, #qa, #pal") && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.closest("form, .dp")));
  };
  function paint() {
    tellOS();
    if (inLayer()) {
      if (S.drawer) { const lg = document.querySelector("#drawer .chat-log"); const atEnd = lg && lg.scrollHeight - lg.scrollTop - lg.clientHeight < 60; renderDrawer(); const lg2 = document.querySelector("#drawer .chat-log"); if (lg2 && atEnd) lg2.scrollTop = lg2.scrollHeight; }
      deferred = true; renderMenu(); return;
    }
    if (S.view === "messages" && $("chatlog") && editing()) { refreshChat(); renderMenu(); return; }   // 글을 쓰는 중에도 새 메시지는 보인다
    if (editing()) { deferred = true; renderMenu(); return; }
    render();
  }
  document.addEventListener("focusout", () => setTimeout(() => { if (deferred && !editing()) { deferred = false; render(); } }, 0));

  function useExample(note) { S.data = exampleData(); S.mode = "example"; S.note = note || ""; render(); }
  const strip = (o) => { const c = { ...o }; delete c.url; return c; };

  async function updatePage(row, props) {
    if (S.mode !== "live" || !S.db) { Object.assign(row, props); return; }
    if (S.canWrite === false) throw { code: "invalid_argument" };
    const now = new Date().toISOString(), extra = {};
    if (props["상태"] !== undefined && props["상태"] !== row["상태"] && S.data.tasks.includes(row)) { extra["상태 변경"] = now; extra["상태 변경자"] = S.me || ""; extra["상태 변경자 이름"] = myNameFor(row["프로젝트"]); }
    await S.db.collection(S.keyOf(row)).doc(row.url).update({ ...strip(props), ...extra, "수정": now });
    Object.assign(row, props, extra);
  }
  async function removeTask(row) {
    if (!S.isPM) throw { code: "local", message: "삭제는 PM만 할 수 있습니다." };
    const i = S.data.tasks.indexOf(row);
    if (S.mode !== "live" || !S.db) { if (i >= 0) S.data.tasks.splice(i, 1); return; }
    await S.db.collection("tasks").doc(row.url).delete();
  }
  S.keyOf = (row) => KEYS.find((k) => S.data[k].includes(row)) || "tasks";
  async function createPages(key, list) {
    if (S.mode !== "live" || !S.db) {
      list.forEach((p, i) => S.data[key].push({ url: `ex-new-${Date.now()}-${i}`, ...p }));
      return;
    }
    if (S.canWrite === false) throw { code: "invalid_argument" };
    for (const p of list) {
      const body = { ...strip(p), "생성": new Date().toISOString() };
      if (S.me) body["만든 사람"] = S.me;
      const who = myNameFor(p["프로젝트"]); if (who) body["만든이"] = who;
      await S.db.collection(key).add(body);
    }
  }

  // ---------- 민감 메시지 표시 (PM만 읽는 칸) ----------
  let flagUnsub = null;
  function subscribeFlags() {
    if (flagUnsub) { try { flagUnsub(); } catch (e) {} }
    flagUnsub = S.db.collection("flags").onSnapshot((snap) => { S.flags = snap.docs.map((d) => ({ ...d.data(), url: d.id })); paint(); }, () => { S.flags = []; });
  }

  // ---------- PC 에이전트 (Claude 모델을 부르지 않는 도구 호출) ----------
  const HOST = "host:odd-hr-kakaotalk";
  const PC_ERR = {
    server_not_connected: "이 PC에는 카톡 에이전트가 없습니다. 카톡 점검은 PM의 PC(Windows, Mac)에 설치한 ODD HR 앱에서 돕니다.",
    approval_required: "Claude 앱에서 PC 에이전트 사용을 허용해야 합니다. 다시 누르면 허용 창이 뜹니다.",
    consent_required: "Claude 앱에서 PC 에이전트 사용을 허용해야 합니다. 다시 누르면 허용 창이 뜹니다.",
    cancelled: "허용 창이 닫혀 취소됐습니다.",
    not_in_manifest: "이 화면에 PC 에이전트 연결이 선언되지 않았습니다.",
    blocked_by_policy: "조직 정책으로 PC 연결이 막혀 있습니다.",
    tool_error: "PC 에이전트가 오류를 냈습니다. 카카오톡이 켜져 있고 대화방 창이 열려 있는지 확인하세요."
  };
  const pcErr = (e) => PC_ERR[e && e.code] || `PC 에이전트를 부르지 못했습니다${e && e.code ? ` (${e.code})` : ""}.`;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  async function pcCall(tool, args) {
    if (!S.mcp) throw { code: "server_not_connected" };
    const r = await S.mcp.callTool(HOST, tool, args || {});
    let p = r && (r.payload !== undefined ? r.payload : r.structuredContent);
    if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) {} }
    if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 1 && "result" in p) p = p.result;
    return p;
  }

  const TASK_FIELDS = ["할 일", "프로젝트", "담당 역할", "담당자", "마감", "긴급도", "출처", "대화방", "근거 메시지", "확신도", "중복 키", "판정", "생성"];
  const FLAG_FIELDS = ["대화방", "날짜", "시각", "내용", "생성"];
  const okId = (id, pre) => typeof id === "string" && new RegExp(`^${pre}-[0-9a-f]{8,40}$`).test(id);
  function cleanFields(f, keys) {
    const o = {};
    keys.forEach((k) => { if (f && f[k] !== undefined && f[k] !== null) o[k] = String(f[k]).slice(0, k === "근거 메시지" ? 600 : 200); });
    return o;
  }
  // 받은 제안은 데이터로만 다룬다: 아는 칸만 옮기고, 상태는 늘 '제안', 작성 표시는 늘 붙인다
  async function importBatch(data, fromPc) {
    if (!S.db) throw { code: "local", message: "저장소가 연결되지 않아 가져올 수 없습니다." };
    if (S.canWrite === false) throw { code: "invalid_argument" };
    const props = Array.isArray(data && data.proposals) ? data.proposals : [];
    const flags = Array.isArray(data && data.flags) ? data.flags : [];
    let added = 0, had = 0; const done = [];
    for (const p of props.slice(0, 500)) {
      if (!okId(p && p.id, "kakao")) continue;
      const fields = cleanFields(p.fields, TASK_FIELDS);
      if (!fields["할 일"]) continue;
      if (fields["마감"] && !/^\d{4}-\d{2}-\d{2}$/.test(fields["마감"])) delete fields["마감"];
      if (fields["담당 역할"] && !ROLES.includes(fields["담당 역할"])) fields["담당 역할"] = "미정";
      if (fields["긴급도"] && !LEVELS.includes(fields["긴급도"])) delete fields["긴급도"];
      const ref = S.db.collection("tasks").doc(p.id);
      const snap = await ref.get();
      if (snap.exists) had++;
      else { await ref.set({ ...fields, "상태": "제안", "작성": "ODD HR 작성", "출처": "카카오톡", "가져옴": new Date().toISOString() }); added++; }
      done.push(p.id);
    }
    let flagged = 0;
    if (S.isOwner || (S.user && (await S.user.canEdit().catch(() => false)))) {
      for (const f of flags.slice(0, 200)) {
        if (!okId(f && f.id, "flag")) continue;
        const ref = S.db.collection("flags").doc(f.id);
        const snap = await ref.get();
        if (!snap.exists) { await ref.set({ ...cleanFields(f.fields, FLAG_FIELDS), "상태": "확인 전" }); flagged++; }
        done.push(f.id);
      }
    }
    if (fromPc && done.length) await pcCall("odd_hr_mark_synced", { ids: done });
    return { added, had, flagged };
  }
  const importText = (r) => r.added || r.flagged ? `새 제안 ${r.added}건${r.had ? `, 이미 있던 ${r.had}건 건너뜀` : ""}${r.flagged ? `, PM 확인 필요 ${r.flagged}건` : ""}을 가져왔습니다. 작업 화면에서 처리하세요.` : r.had ? `새 제안이 없습니다 (이미 있던 ${r.had}건).` : "가져올 새 제안이 없습니다.";

  async function pcSync(scanFirst, quiet) {
    if (S.pc.state === "busy") return;
    S.pc.state = "busy"; if (!quiet) { S.flash.pc = { ok: true, text: scanFirst ? "카톡을 점검하는 중입니다. 1분쯤 걸릴 수 있습니다." : "PC 에이전트에서 가져오는 중입니다." }; paint(); }
    try {
      let scanNote = "";
      if (scanFirst) {
        const rep = await pcCall("odd_hr_scan_now");
        const rooms = (rep && rep.rooms) || [];
        const errs = rooms.filter((r) => r.error);
        scanNote = rep && rep.error ? rep.error + " " : errs.length ? `${errs.map((r) => `${r.room}: ${r.error}`).join(" / ")} ` : `점검 완료 (읽은 메시지 ${rooms.reduce((a, r) => a + (r.read || 0), 0)}건, 판정 ${rep.engine || "규칙"}). `;
      }
      const data = await pcCall("odd_hr_pending", { limit: 200 });
      const r = await importBatch(data, true);
      try { S.pc.status = await pcCall("odd_hr_status"); } catch (e) {}
      lsSet("oddhr.pc", "1");
      S.pc.state = "ok"; S.pc.pulled = new Date();
      startAutoPull();
      if (!quiet || r.added || r.flagged) S.flash.pc = { ok: true, text: scanNote + importText(r) };
      if (quiet && (r.added || r.flagged) && window.oddhr && window.oddhr.notify) window.oddhr.notify("ODD HR 카톡 점검", importText(r));
    } catch (e) {
      S.pc.state = "err";
      if (!quiet) S.flash.pc = { ok: false, text: e && e.code === "invalid_argument" ? errText(e) : pcErr(e) };
    }
    paint();
  }
  function checkNowBtn(big) {
    if (!S.isOwner) return null;
    return h("button", { class: "btn " + (big ? "primary" : "small primary"), type: "button", disabled: S.pc.state === "busy",
      text: S.pc.state === "busy" ? "카톡 점검하는 중" : "지금 카톡 점검하기", title: "PC 에이전트가 지금 바로 대화방을 읽고, 새 제안을 가져옵니다. 추가 비용이 들지 않습니다.",
      onclick: () => pcSync(true, false) });
  }
  // Desk를 열어 두면 3분마다 PC 대기열을 조용히 가져온다 (PC는 3분마다 스스로 점검한다)
  setInterval(() => { if (S.view === "home" && document.visibilityState !== "hidden") paint(); }, 60000);
  let pullTimer = null;
  function startAutoPull() {
    if (pullTimer || !S.isOwner || !S.mcp) return;
    const every = Math.max(60, Number((S.pc.status && S.pc.status.interval_sec) || 180)) * 1000;
    pullTimer = setInterval(() => { if (S.pc.state !== "busy" && lsGet("oddhr.autoscan") !== "0") pcSync(true, true); }, every);
  }
  async function pcStatus() {
    S.pc.state = "busy"; paint();
    try { S.pc.status = await pcCall("odd_hr_status"); S.pc.state = "ok"; S.flash.pc = null; lsSet("oddhr.pc", "1"); }
    catch (e) { S.pc.state = "err"; S.flash.pc = { ok: false, text: pcErr(e) }; }
    paint();
  }
  function importFile(file) {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = async () => {
      let data = null;
      try { data = JSON.parse(String(rd.result || "")); } catch (e) {}
      if (!data || data.format !== "odd-hr-proposals") { S.flash.pc = { ok: false, text: "ODD HR 제안 파일이 아닙니다. outbox 폴더의 ODD-HR-제안-날짜.json을 고르세요." }; paint(); return; }
      S.pc.state = "busy"; paint();
      try { const r = await importBatch(data, false); S.flash.pc = { ok: true, text: importText(r) }; }
      catch (e) { S.flash.pc = { ok: false, text: errText(e) }; }
      S.pc.state = null; paint();
    };
    rd.readAsText(file);
  }

  async function act(key, fn, okText) {
    S.busy = true; S.flash[key] = null; render();
    try {
      await fn();
      const f = S.flash[key] = { ok: true, text: S.mode === "live" ? okText : `${okText} (예시라 저장되지 않음)` };
      setTimeout(() => { if (S.flash[key] === f) { S.flash[key] = null; paint(); } }, 6000);
      S.clearDrafts = true;
    } catch (e) {
      S.flash[key] = { ok: false, text: errText(e) };
    } finally { S.busy = false; render(); }
  }
  const flashEl = (key) => S.flash[key] ? h("div", { class: "msg " + (S.flash[key].ok ? "ok" : "err"), role: "status", text: S.flash[key].text }) : null;

  // ---------- 공통 조각 ----------
  function taskMeta(r) {
    return h("div", { class: "m" },
      ddayEl(r["마감"]),
      r["프로젝트"] ? h("span", { class: "pill", text: r["프로젝트"] }) : null,
      r["담당 역할"] ? h("span", { class: "pill", text: [r["담당 역할"], r["담당자"]].filter(Boolean).join(" · ") }) : null,
      r["작성"] === "ODD HR 작성" ? h("span", { class: "pill ai", text: "ODD HR 작성" }) : null,
      risky(r) && statusOf(r) === "제안" ? h("span", { class: "pill risk", text: "고위험" }) : null
    );
  }
  function pageHead(title, desc, ...tools) {
    return h("div", { class: "pagehead" }, h("div", {}, h("h1", { text: title }), desc ? h("p", { text: desc }) : null), tools.length ? h("div", { class: "toolbar" }, tools) : null);
  }
  function filterBar(withDone) {
    const sel = (label, key, opts) => h("select", { "aria-label": label, onchange: (e) => { S.filter[key] = e.target.value; render(); } },
      ["전체", ...opts].map((o) => { const op = h("option", { value: o, text: o === "전체" ? `${label}: 전체` : o }); if (S.filter[key] === o) op.selected = true; return op; }));
    return h("div", { class: "filters" }, sel("역할", "role", ROLES), sel("프로젝트", "project", PROJECTS),
      withDone && APP ? h("button", { class: "chip", type: "button", "aria-pressed": String(!!S.filter.mine), text: "내 것만", title: "내가 담당자이거나, 담당자 없이 내 역할에 걸린 일", onclick: () => { S.filter.mine = !S.filter.mine; render(); } }) : null,
      !withDone && APP ? h("button", { class: "chip", type: "button", "aria-pressed": String(!!S.filter.toMe), text: "내게 온 것만", onclick: () => { S.filter.toMe = !S.filter.toMe; render(); } }) : null,
      withDone ? h("button", { class: "chip", type: "button", "aria-pressed": String(S.filter.showDone), text: "완료 보기", onclick: () => { S.filter.showDone = !S.filter.showDone; render(); } }) : null);
  }

  // ---------- 홈 ----------
  function viewHome() {
    const d = new Date();
    const props = proposals();
    const todos = openTodos();
    const fires = [];
    S.data.tasks.forEach((r) => {
      const st = statusOf(r), n = dday(r["마감"]);
      if (["완료", "기각"].includes(st)) return;
      if (st === "막힘") fires.push(["막힘", true, r["할 일"], `${r["담당 역할"] || "담당 미정"}이 막혔다고 표시했습니다.`, -2]);
      else if (n !== null && n < 0) fires.push(["마감 지남", true, r["할 일"], `${ddayText(n)} · ${r["프로젝트"] || "미분류"}`, n]);
      else if (st !== "제안" && n !== null && n <= 3) fires.push(["3일 이내", false, r["할 일"], `${ddayText(n)} · ${st}`, n]);
      if (st !== "제안" && (!r["담당 역할"] || r["담당 역할"] === "미정")) fires.push(["담당 없음", false, r["할 일"], "승인됐지만 맡은 역할이 없습니다.", 20]);
    });
    const load = {};
    todos.forEach((r) => { const k = r["담당자"] || r["담당 역할"]; const n = dday(r["마감"]); if (k && k !== "미정" && n !== null && n <= 7) load[k] = (load[k] || 0) + 1; });
    Object.entries(load).forEach(([k, c]) => { if (c >= 5) fires.push(["과부하", false, `${k}에게 7일 안 마감 ${c}건`, "옮길 수 있는 일이 있는지 보세요.", 10]); });
    fires.sort((a, b) => a[4] - b[4]);
    const flagsOpen = S.flags.filter((f) => f["상태"] !== "확인함");
    const nextMeet = S.data.meetings.filter((m) => m["일시"] && dday(m["일시"]) >= 0).sort((a, b) => String(a["일시"]).localeCompare(String(b["일시"])))[0];

    const decide = h("section", { class: "box" },
      h("h2", {}, "승인 기다리는 제안", h("span", { class: "n", text: `${props.length}건` })),
      h("p", { class: "sub", text: "긴급도 순입니다. 누르면 옆에서 바로 처리합니다." }),
      props.length ? h("div", { class: "rows" }, props.slice(0, 5).map((r) => h("button", { class: "row", type: "button", onclick: () => openTask(r.url) },
        h("span", { class: "lvl " + level(r), text: level(r) }),
        h("div", {}, h("div", { class: "t", text: r["할 일"] || "(제목 없음)" }), taskMeta(r)),
        h("span", { class: "pill", text: "열기" })))) : h("div", { class: "empty", text: "결정할 제안이 없습니다. PC 에이전트의 카톡 점검을 가져오면 여기에 쌓입니다." }),
      props.length > 5 ? h("button", { class: "btn small", type: "button", text: `나머지 ${props.length - 5}건 보기`, onclick: () => go("tasks") }) : null
    );

    const flagBox = flagsOpen.length ? h("section", { class: "box" },
      h("h2", {}, "PM 확인 필요", h("span", { class: "n", text: `${flagsOpen.length}건` })),
      h("p", { class: "sub", text: "건강, 가족, 갈등처럼 민감할 수 있는 메시지입니다. 원문은 옮기지 않았습니다. 카톡에서 직접 확인하세요. 이 칸은 PM만 봅니다." }),
      h("div", { class: "rows" }, flagsOpen.slice(0, 8).map((f) => h("div", { class: "row" },
        h("span", { class: "lvl 보통", text: "확인" }),
        h("div", {}, h("div", { class: "t", text: `${f["대화방"] || "대화방"} · ${String(f["날짜"] || "").replace(/\s*[월화수목금토일]요일$/, "")} ${f["시각"] || ""}` }), h("div", { class: "m", text: "민감할 수 있는 메시지 1건" })),
        h("button", { class: "btn small", type: "button", disabled: S.busy, text: "확인함", onclick: () => act("flags", async () => { await S.db.collection("flags").doc(f.url).update({ "상태": "확인함", "확인": new Date().toISOString() }); }, "확인함으로 표시했습니다.") })))),
      flashEl("flags")) : null;

    const fireBox = h("section", { class: "box" },
      h("h2", {}, "불씨", h("span", { class: "n", text: `${fires.length}건` })),
      fires.length ? h("div", { class: "rows" }, fires.slice(0, 6).map((f) => h("div", { class: "row" },
        h("span", { class: "lvl " + (f[1] ? "긴급" : "보통"), text: f[0] }),
        h("div", {}, h("div", { class: "t", text: f[2] || "(제목 없음)" }), h("div", { class: "m", text: f[3] })), h("span")))) : h("div", { class: "empty", text: "지금 번질 만한 불씨가 없습니다." })
    );

    const projBox = h("section", { class: "box" }, h("h2", {}, "프로젝트"),
      h("div", { class: "rows" }, PROJECTS.map((p) => {
        const rows = S.data.tasks.filter((r) => (r["프로젝트"] || "미분류") === p && !["완료", "기각"].includes(statusOf(r)));
        const dl = PROJECT_DEADLINES[p];
        if (!rows.length && !dl) return null;
        const n = dl ? dday(dl[0]) : null;
        return h("div", { class: "row" },
          dl ? h("span", { class: "dday" + (n !== null && n <= 7 ? " hot" : ""), text: ddayText(n) }) : h("span", { class: "dday", text: "—" }),
          h("div", {}, h("div", { class: "t", text: p }), h("div", { class: "m", text: `${dl ? dl[1] + " · " : ""}열린 일 ${rows.length}건 · 막힘 ${rows.filter((r) => statusOf(r) === "막힘").length}건` })), h("span"));
      })));

    const meetBox = h("section", { class: "box" }, h("h2", {}, "다음 미팅"),
      nextMeet ? h("button", { class: "row", type: "button", onclick: () => { S.sel.meeting = nextMeet.url; S.meetTab = "upcoming"; go("meetings"); } },
        h("span", { class: "dday", text: whenText(nextMeet["일시"]) }),
        h("div", {}, h("div", { class: "t", text: nextMeet["제목"] || "(제목 없음)" }), h("div", { class: "m", text: [nextMeet["종류"], nextMeet["참석자"]].filter(Boolean).join(" · ") })), h("span", { class: "pill", text: "준비" }))
        : h("div", { class: "empty", text: "예정된 미팅이 없습니다." }));

    return [
      pageHead(`${d.getMonth() + 1}월 ${d.getDate()}일 아침상`, "ODD HR이 카톡, 미팅, 목표를 읽고 오늘 먼저 볼 것만 골랐습니다.", checkNowBtn()),
      S.view === "home" && S.flash.pc ? flashEl("pc") : null,
      APP ? notifBox() : null,
      incomingBox(),
      APP ? starterBox() : null,
      quickBox(),
      voiceBox(),
      APP ? weeklyHome() : null,
      h("div", { class: "stat" },
        h("div", {}, h("b", { text: props.length }), h("span", { text: "결정할 제안" })),
        h("div", {}, h("b", { text: todos.length }), h("span", { text: "열린 할 일" })),
        h("div", {}, h("b", { text: todos.filter((r) => statusOf(r) === "검토 요청").length }), h("span", { text: "검토 요청" })),
        h("div", {}, h("b", { text: fires.length }), h("span", { text: "불씨" }))),
      h("div", { class: "grid2" }, h("div", { style: "display:grid;gap:20px;min-width:0" }, decide, meetBox), h("div", { style: "display:grid;gap:20px;min-width:0" }, flagBox, fireBox, projBox))
    ];
  }

  // ---------- 작업 ----------
  function viewTasks() {
    const list = proposals().filter(roleOk).filter(projOk).filter((r) => !S.filter.toMe || isMine(r));
    if (!list.find((r) => r.url === S.sel.task)) S.sel.task = list[0] ? list[0].url : null;
    const cur = list.find((r) => r.url === S.sel.task);

    const left = h("section", { class: "box" },
      h("h2", {}, "제안된 작업", h("span", { class: "n", text: `${list.length}건` })),
      filterBar(false),
      list.length ? h("div", { class: "rows", role: "listbox", "aria-label": "제안된 작업" }, list.map((r) => h("button", {
        class: "row", type: "button", role: "option", "aria-selected": String(r.url === S.sel.task),
        onclick: () => { S.sel.task = r.url; S.risk = null; S.dismiss = null; render(); }
      }, h("span", { class: "lvl " + level(r), text: level(r) }), h("div", {}, h("div", { class: "t", text: r["할 일"] || "(제목 없음)" }), taskMeta(r)), h("span")))) :
        h("div", { class: "empty", text: "처리할 제안이 없습니다." })
    );

    let right;
    if (!cur) right = h("section", { class: "box" }, h("div", { class: "empty", text: "왼쪽에서 작업을 고르면 제안 이유와 처리 버튼이 나옵니다." }), flashEl("task"));
    else {
      const isRisk = risky(cur);
      const startTask = () => {
        if (isRisk && S.risk !== cur.url) { S.risk = cur.url; render(); return; }
        const reason = isRisk ? ($("riskReason") || {}).value || "" : "";
        if (isRisk && !reason.trim()) { S.flash.task = { ok: false, text: "외부로 나가거나 일정을 바꾸는 일이라 승인 이유가 필요합니다." }; render(); return; }
        const mem = APP ? APP.myMember(pidOf(cur["프로젝트"])) : null;
        const take = mem && !cur["담당자"] ? Object.assign({ "담당자": mem.name }, !cur["담당 역할"] || cur["담당 역할"] === "미정" ? { "담당 역할": mem.role } : {}) : {};
        act("task", () => updatePage(cur, Object.assign({ "상태": "진행" }, take, isRisk ? { "승인 이유": reason.trim() } : {})), take["담당자"] ? "작업을 시작했습니다. 담당자를 나로 적었습니다. 할 일에서 이어서 볼 수 있습니다." : "작업을 시작했습니다. 할 일에서 이어서 볼 수 있습니다.");
        S.risk = null;
      };
      right = h("section", { class: "box detail" },
        h("div", { class: "actions" }, h("span", { class: "lvl " + level(cur), text: `긴급도 ${level(cur)}` }), cur["작성"] === "ODD HR 작성" ? h("span", { class: "pill ai", text: "ODD HR 작성" }) : null, isRisk ? h("span", { class: "pill risk", text: "고위험 승인" }) : null),
        h("h3", { text: cur["할 일"] || "(제목 없음)" }),
        h("dl", { class: "kv" },
          h("dt", { text: "마감" }), h("dd", {}, cur["마감"] ? `${String(cur["마감"]).slice(0, 10)} ` : "없음", ddayEl(cur["마감"])),
          h("dt", { text: "프로젝트" }), h("dd", { text: cur["프로젝트"] || "미분류" }),
          h("dt", { text: "담당" }), h("dd", { text: [cur["담당 역할"], cur["담당자"]].filter(Boolean).join(" · ") || "미정" }),
          h("dt", { text: "출처" }), h("dd", { text: [cur["출처"], cur["대화방"] || cur["출처 미팅"]].filter(Boolean).join(" · ") || "직접 입력" }),
          cur["제안한 사람"] ? h("dt", { text: "제안한 사람" }) : null, cur["제안한 사람"] ? h("dd", { text: cur["제안한 사람"] }) : null,
          h("dt", { text: "확신도" }), h("dd", { text: cur["확신도"] || "—" })),
        h("div", { class: "field" }, "제안 이유", h("div", { class: "quote", text: cur["근거 메시지"] || "근거 메시지가 없습니다." })),
        S.risk === cur.url ? h("label", { class: "field" }, "승인 이유 (외부 발송, 일정 변경, 범위 축소는 이유를 남깁니다)", h("input", { id: "riskReason", placeholder: "예: 교수님 확인 끝난 시사본이라 보내도 됨" })) : null,
        S.dismiss === cur.url ? h("label", { class: "field" }, "내 일이 아닌 이유 (같은 유형이 반복되면 카톡 점검 규칙에 반영합니다)", h("input", { id: "dismissReason", placeholder: "예: 잡담에서 나온 말" })) : null,
        h("div", { class: "actions" },
          S.dismiss === cur.url
            ? [h("button", { class: "btn primary", type: "button", disabled: S.busy, text: "내 일 아님으로 넘기기", onclick: () => { const v = ($("dismissReason") || {}).value || ""; act("task", () => updatePage(cur, { "상태": "기각", "기각 사유": v.trim() || "사유 없음" }), "내 일 아님으로 넘겼습니다."); S.dismiss = null; } }),
               h("button", { class: "btn", type: "button", text: "취소", onclick: () => { S.dismiss = null; render(); } })]
            : [h("button", { class: "btn accent", type: "button", disabled: S.busy, text: S.risk === cur.url ? "이유 적고 작업 시작" : "작업 시작", onclick: startTask }),
               h("button", { class: "btn", type: "button", disabled: S.busy, text: "이미 처리함", title: S.isPM ? "완료로 기록합니다" : "PM에게 검토 요청으로 올립니다 (완료 처리는 PM이 합니다)", onclick: () => act("task", () => updatePage(cur, S.isPM ? { "상태": "완료" } : { "상태": "검토 요청", "메모": "이미 처리했다고 표시" }), S.isPM ? "완료로 기록했습니다." : "이미 처리한 일로 PM에게 검토 요청을 올렸습니다.") }),
               h("button", { class: "btn danger", type: "button", disabled: S.busy, text: "내 일 아님", onclick: () => { S.dismiss = cur.url; S.risk = null; render(); } })],
          null),
        flashEl("task"));
    }

    const np = S.newProj && PROJECTS.includes(S.newProj) ? S.newProj : curProjName();
    const mates = membersOf(np);
    const pre = S.prefill || {}; S.prefill = null;
    const create = h("section", { class: "box" },
      h("h2", {}, APP ? (S.isPM ? "팀원에게 업무 제안하기" : "할 일 만들기, 팀원에게 제안하기") : "직접 작업 만들기"),
      APP ? h("p", { class: "sub", text: S.isPM ? "담당자를 고르고 보내면 그 사람 홈의 '들어온 업무 요청'에 뜨고 알림이 갑니다. 수락하면 할 일이 되고, 넘기면 이유와 함께 알려 줍니다." : "담당자를 고르고 '제안으로 보내기'를 하면 그 사람에게 알림이 가고, 수락하면 할 일이 됩니다. 수락이나 거절 결과는 나에게 알림으로 옵니다." }) : null,
      h("form", { class: "form", onsubmit: (e) => {
        e.preventDefault();
        const f = e.target, title = f.ntitle.value.trim();
        if (!title) { S.flash.create = { ok: false, text: "할 일을 적어 주세요." }; render(); return; }
        const p = { "할 일": title, "상태": "대기", "프로젝트": f.nproj.value, "담당 역할": f.nrole.value, "긴급도": f.nlvl.value, "출처": "직접 입력", "작성": "사람 작성" };
        if (f.ndue.value) { p["마감"] = f.ndue.value }
        const who = f.nwho ? f.nwho.value : "", asProp = f.nmode && f.nmode.value === "제안";
        if (who) p["담당자"] = who;
        if (asProp) { const me = myNameFor(p["프로젝트"]) || "팀원"; Object.assign(p, { "상태": "제안", "출처": isPMof(p["프로젝트"]) ? "PM 제안" : "팀원 제안", "제안한 사람": me, "근거 메시지": pre.quote || `${me}님이 직접 제안했습니다.`, "확신도": "높음" }); }
        else if (pre.quote) p["근거 메시지"] = pre.quote;
        act("create", () => createPages("tasks", [p]), asProp ? `${who || p["담당 역할"]}에게 ${S.isPM ? "업무 요청" : "제안"}을 보냈습니다. 상대 홈에 '들어온 업무 요청'으로 뜹니다.` : "할 일로 추가했습니다.");
      } },
        h("label", { class: "field wide" }, "할 일", h("input", { id: "ntitle", name: "ntitle", value: pre.title || "", placeholder: "예: 촬영 장비 대여 신청하기" })),
        h("label", { class: "field" }, "프로젝트", h("select", { id: "nproj", name: "nproj", onchange: (e) => { S.newProj = e.target.value; render(); } }, projSel(np))),
        APP ? h("label", { class: "field" }, "담당자", h("select", { id: "nwho", name: "nwho", onchange: (e) => { const m = mates.find((x) => x.name === e.target.value); if (m && $("nrole")) $("nrole").value = m.role; } },
          h("option", { value: "", text: "정하지 않음 (역할 전체)" }), mates.map((m) => { const o = h("option", { value: m.name, text: `${m.name} (${m.role})` }); if (m.name === pre.who) o.selected = true; return o; }))) : null,
        h("label", { class: "field" }, "담당 역할", h("select", { id: "nrole", name: "nrole" }, ROLES.map((p) => { const o = h("option", { value: p, text: p }); if (p === pre.role) o.selected = true; return o; }))),
        h("label", { class: "field" }, "긴급도", h("select", { id: "nlvl", name: "nlvl" }, LEVELS.map((p) => { const o = h("option", { value: p, text: p }); if (p === "보통") o.selected = true; return o; }))),
        dateField("ndue", "마감", { placeholder: "마감 없음" }),
        APP ? h("label", { class: "field" }, "보내는 방식", h("select", { id: "nmode", name: "nmode" }, h("option", { value: "바로", text: "바로 할 일로 넣기" }), (() => { const o = h("option", { value: "제안", text: S.isPM ? "업무 요청으로 보내기 (상대가 수락)" : "제안으로 보내기 (상대가 수락)" }); if (pre.mode === "제안" || (S.isPM && pre.mode !== "바로")) o.selected = true; return o; })())) : null,
        h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit", disabled: S.busy, text: "추가" }))),
      flashEl("create"));

    const routines = h("section", { class: "box" }, h("h2", {}, "반복 작업"),
      h("p", { class: "sub", text: "추가 비용이 들지 않습니다. 카톡 점검은 PM의 PC(Windows, Mac)에서 ODD HR 앱이 돌리고, 나머지는 앱이 바로 계산합니다." }),
      h("div", { class: "rows" },
        [["3분마다", "카톡 점검", "PM PC가 지정 대화방을 읽고 할 일 후보를 골라 둡니다. Desk를 열어 두면 자동으로 가져옵니다"], ["언제든", "주간 업데이트 초안", "할 일 화면 아래에서 역할을 고르면 바로 만들어집니다"]].map((x) =>
          h("div", { class: "row" }, h("span", { class: "dday", text: x[0] }), h("div", {}, h("div", { class: "t", text: x[1] }), h("div", { class: "m", text: x[2] })), h("span")))));

    const sent = APP && S.isPM ? S.data.tasks.filter((r) => r["출처"] === "PM 제안" && r["만든 사람"] === S.me).sort((a, b) => T(b["생성"]) - T(a["생성"])).slice(0, 12) : [];
    const sentBox = sent.length ? h("section", { class: "box" }, h("h2", {}, "내가 보낸 업무 요청", h("span", { class: "n", text: `${sent.length}건` })),
      h("div", { class: "rows" }, sent.map((r) => h("div", { class: "row" }, h("span", { class: "pill " + (statusOf(r) === "기각" ? "risk" : statusOf(r) === "제안" ? "" : "ok"), text: statusOf(r) === "제안" ? "답 기다림" : statusOf(r) === "기각" ? "넘김" : "수락" }),
        h("div", {}, h("div", { class: "t", text: r["할 일"] }), h("div", { class: "m", text: [r["담당자"] || r["담당 역할"], r["마감"] ? `${String(r["마감"]).slice(5).replace("-", "/")}까지` : "", statusOf(r) === "기각" && r["기각 사유"] ? `이유: ${r["기각 사유"]}` : ""].filter(Boolean).join(" · ") })), h("span"))))) : null;
    return APP && S.isPM
      ? [pageHead("작업", "팀원에게 업무를 제안하고, 카톡·회의록에서 찾은 일을 나눕니다. 보낸 요청은 팀원 홈의 '들어온 업무 요청'에 뜹니다.", checkNowBtn()), h("div", { class: "grid2" }, create, sentBox || routines), h("div", { class: "split" }, left, right)]
      : [pageHead("작업", "ODD HR이 찾은 일입니다. 작업 시작, 이미 처리함, 내 일 아님 중 하나를 고르세요.", checkNowBtn()), h("div", { class: "split" }, left, right), h("div", { class: "grid2" }, create, routines)];
  }

  // ---------- 할 일 ----------
  const NEXT = { "대기": "진행", "진행": "검토 요청", "검토 요청": "완료", "막힘": "진행", "완료": "진행" };
  const CHECK = { "대기": "", "진행": "진행", "검토 요청": "검토", "막힘": "막힘", "완료": "완료" };
  function viewTodo() {
    const groups = ["막힘", "검토 요청", "진행", "대기"].concat(S.filter.showDone ? ["완료"] : []);
    if (S.filter.mine === null) S.filter.mine = !!APP && !S.isPM && S.data.tasks.some(isMine);
    const all = S.data.tasks.filter((r) => groups.includes(statusOf(r))).filter(roleOk).filter(projOk).filter((r) => !S.filter.mine || isMine(r))
      .sort((a, b) => (dday(a["마감"]) ?? 999) - (dday(b["마감"]) ?? 999));
    const box = h("section", { class: "box" }, filterBar(true));
    if (!all.length) box.appendChild(h("div", { class: "empty" }, S.filter.mine ? "내가 맡은 할 일이 없습니다." : "조건에 맞는 할 일이 없습니다. 작업 화면에서 제안을 시작하면 여기에 들어옵니다.",
      S.filter.mine ? h("button", { class: "btn small", type: "button", text: "팀 전체 보기", onclick: () => { S.filter.mine = false; render(); } }) : null));
    groups.forEach((g) => {
      const items = all.filter((r) => statusOf(r) === g);
      if (!items.length) return;
      box.appendChild(h("div", { class: "group-title" }, g, h("span", { text: String(items.length) })));
      box.appendChild(h("div", { class: "rows" }, items.map((r) => {
        // 팀원은 '검토 요청'까지만 올린다. 완료 처리, 다시 열기, 삭제는 PM만 한다.
        const next = NEXT[g];
        const canMove = S.isPM || (next !== "완료" && g !== "완료");
        const delAsk = S.confirmDel === r.url;
        const canEdit = S.isPM || isMine(r) || r["만든 사람"] === S.me || !APP;
        if (S.editTask === r.url) return taskEditForm(r);
        return h("div", { class: "row" + (delAsk ? " confirm" : "") },
          h("button", { class: "check " + CHECK[g], type: "button", disabled: S.busy || !canMove,
            title: canMove ? `${g}에서 ${next}(으)로` : "PM 승인 대기 중", "aria-label": canMove ? `${r["할 일"]}: ${g}에서 ${next}(으)로 바꾸기` : `${r["할 일"]}: PM 승인 대기 중`,
            onclick: () => setStatus(r, next) }),
          h("div", {}, h("button", { class: "t linklike", type: "button", text: r["할 일"] || "(제목 없음)", title: "옆에서 열기", onclick: () => openTask(r.url) }), taskMeta(r), taskMsgs(r).length ? h("span", { class: "talk-n", text: `💬 ${taskMsgs(r).length}` }) : null,
            delAsk ? h("div", { class: "msg err", text: "삭제하면 되돌릴 수 없습니다. 끝난 일이면 삭제 대신 완료 처리를 권합니다." }) : null),
          h("div", { class: "actions" },
            delAsk ? [
              h("button", { class: "btn small danger", type: "button", disabled: S.busy, text: "삭제", onclick: () => { S.confirmDel = null; act("todo", () => removeTask(r), "삭제했습니다."); } }),
              h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.confirmDel = null; render(); } })
            ] : [
              S.isPM && g !== "완료" ? h("button", { class: "btn small primary", type: "button", disabled: S.busy, text: g === "검토 요청" ? "승인" : "완료", title: "PM만 완료 처리할 수 있습니다",
                onclick: () => setStatus(r, "완료", {}, g === "검토 요청" ? "승인해 완료했습니다." : "완료 처리했습니다.") }) : null,
              !S.isPM && g === "검토 요청" ? h("span", { class: "pill", text: "PM 승인 대기" }) : null,
              g !== "막힘" && g !== "완료" ? h("button", { class: "btn small", type: "button", disabled: S.busy, text: "막힘", onclick: () => setStatus(r, "막힘", {}, "막힘으로 표시했습니다. PM에게 알림이 갑니다.") }) : null,
              S.isPM && g === "완료" ? h("button", { class: "btn small", type: "button", disabled: S.busy, text: "다시 열기", onclick: () => setStatus(r, "진행", {}, "다시 진행 중으로 바꿨습니다.") }) : null,
              APP ? h("button", { class: "btn small", type: "button", text: "열기", "aria-label": `${r["할 일"]} 옆에서 열기`, onclick: () => openTask(r.url) }) : canEdit && g !== "완료" ? h("button", { class: "btn small", type: "button", disabled: S.busy, text: "고치기", "aria-label": `${r["할 일"]} 고치기`, onclick: () => { S.editTask = r.url; render(); } }) : null,
              S.isPM ? h("button", { class: "btn small danger", type: "button", disabled: S.busy, text: "삭제", "aria-label": `${r["할 일"]} 삭제`, onclick: () => { S.confirmDel = r.url; render(); } }) : null
            ]));
      })));
    });
    const fl = flashEl("todo"); if (fl) box.appendChild(fl);
    const weekly = APP ? weeklyBox() : null;
    return [pageHead("할 일", S.isPM ? "동그라미를 누르면 대기, 진행, 검토 요청, 완료 순으로 넘어갑니다. 완료 처리와 삭제는 PM만 보입니다." : "동그라미를 누르면 대기, 진행, 검토 요청 순으로 넘어갑니다. 완료 처리는 PM이 합니다."), voiceBox(), box, weekly];
  }

  function taskEditForm(r) {
    const mates = membersOf(r["프로젝트"]);
    return h("form", { class: "form row-edit", onsubmit: (e) => {
      e.preventDefault();
      const f = e.target, title = f.ettitle.value.trim();
      if (!title) { S.flash.todo = { ok: false, text: "할 일을 비울 수 없습니다." }; render(); return; }
      const props = { "할 일": title, "담당 역할": f.etrole.value, "긴급도": f.etlvl.value, "마감": f.etdue.value || "" };
      if (f.etwho) props["담당자"] = f.etwho.value;
      S.editTask = null;
      act("todo", () => updatePage(r, props), "할 일을 고쳤습니다.");
    } },
      h("label", { class: "field wide" }, "할 일", h("input", { id: "ettitle", name: "ettitle", value: r["할 일"] || "" })),
      APP ? h("label", { class: "field" }, "담당자", h("select", { id: "etwho", name: "etwho", onchange: (e) => { const m = mates.find((x) => x.name === e.target.value); if (m) $("etrole").value = m.role; } },
        h("option", { value: "", text: "정하지 않음 (역할 전체)" }), mates.map((m) => { const o = h("option", { value: m.name, text: `${m.name} (${m.role})` }); if (m.name === r["담당자"]) o.selected = true; return o; }),
        r["담당자"] && !mates.some((m) => m.name === r["담당자"]) ? (() => { const o = h("option", { value: r["담당자"], text: r["담당자"] }); o.selected = true; return o; })() : null)) : null,
      h("label", { class: "field" }, "담당 역할", h("select", { id: "etrole", name: "etrole" }, ROLES.map((p) => { const o = h("option", { value: p, text: p }); if (p === (r["담당 역할"] || "미정")) o.selected = true; return o; }))),
      h("label", { class: "field" }, "긴급도", h("select", { id: "etlvl", name: "etlvl" }, LEVELS.map((p) => { const o = h("option", { value: p, text: p }); if (p === level(r)) o.selected = true; return o; }))),
      dateField("etdue", "마감", { placeholder: "마감 없음", value: r["마감"] || "" }),
      h("div", { class: "actions wide" },
        h("button", { class: "btn primary small", type: "submit", disabled: S.busy, text: "저장" }),
        h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.editTask = null; S.clearDrafts = true; render(); } }),
        APP ? h("button", { class: "btn small", type: "button", text: "이 일로 메시지 보내기", onclick: () => { S.editTask = null; render(); openTask(r.url); } }) : null));
  }

  // ---------- 목표 ----------
  function viewGoals() {
    const goals = S.data.goals;
    const tops = goals.filter((g) => !g["상위 목표"]);
    const kids = (g) => goals.filter((c) => c["상위 목표"] && c["상위 목표"] === g["목표"]);
    const pct = (g) => { const ch = kids(g); if (ch.length) return ch.reduce((s, c) => s + (Number(c["진행률"]) || 0), 0) / ch.length; return Number(g["진행률"]) || 0; };
    const editing = S.sel.goal;

    const goalEl = (g, child) => {
      const p = pct(g), auto = kids(g).length > 0;
      return h("div", { class: "goal" + (child ? " child" : "") },
        h("div", { class: "head" }, h("span", { class: "name", text: g["목표"] || "(이름 없음)" }),
          h("span", { class: "actions" }, ddayEl(g["마감"]), h("span", { class: "pct", text: `${Math.round(p * 100)}%` }), g["상태"] ? h("span", { class: "pill" + (g["상태"] === "완료" ? " ok" : ""), text: g["상태"] }) : null)),
        h("div", { class: "progress", role: "img", "aria-label": `진행률 ${Math.round(p * 100)}%` }, h("span", { style: `width:${Math.min(100, Math.round(p * 100))}%` })),
        h("div", { class: "m", style: "font-size:12px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap" },
          [g["담당 역할"], g["담당자"]].filter(Boolean).join(" · ") || "담당 미정",
          auto ? h("span", { text: "하위 목표 평균으로 자동 계산" }) : null,
          g["최근 업데이트"] ? h("span", { text: `최근: ${g["최근 업데이트"]}` }) : null),
        auto ? null : (editing === g.url
          ? h("form", { class: "form", onsubmit: (e) => {
              e.preventDefault();
              const v = Math.max(0, Math.min(100, Number(e.target.gp.value) || 0)) / 100;
              const props = { "진행률": v, "상태": v >= 1 ? "완료" : (g["상태"] === "보류" ? "보류" : "진행 중"), "진행률 확인": new Date().toISOString() };
              if (e.target.gu.value.trim()) props["최근 업데이트"] = e.target.gu.value.trim();
              S.sel.goal = null;
              act("goal", () => updatePage(g, props), "진행률을 업데이트했습니다.");
            } },
              h("label", { class: "field" }, "진행률 (%)", h("input", { id: "gp", name: "gp", type: "number", min: "0", max: "100", step: "5", value: String(Math.round(p * 100)) })),
              h("label", { class: "field" }, "한 줄 업데이트", h("input", { id: "gu", name: "gu", placeholder: "예: 2차 편집 피드백 반영 끝" })),
              h("div", { class: "actions" }, h("button", { class: "btn primary small", type: "submit", disabled: S.busy, text: "저장" }), h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.sel.goal = null; render(); } })))
          : h("div", { class: "actions" }, h("button", { class: "btn small", type: "button", text: "진행률 업데이트", onclick: () => { S.sel.goal = g.url; render(); } }))));
    };

    const byProject = PROJECTS.map((p) => {
      const t = tops.filter((g) => (g["프로젝트"] || "미분류") === p);
      if (!t.length) return null;
      return h("section", { class: "box" }, h("h2", { text: p }), h("div", {}, t.map((g) => [goalEl(g, false), kids(g).map((c) => goalEl(c, true))])));
    }).filter(Boolean);

    const create = h("section", { class: "box" }, h("h2", {}, "목표 추가"),
      h("form", { class: "form", onsubmit: (e) => {
        e.preventDefault();
        const f = e.target, name = f.gname.value.trim();
        if (!name) { S.flash.goalnew = { ok: false, text: "목표 이름을 적어 주세요." }; render(); return; }
        const p = { "목표": name, "프로젝트": f.gproj.value, "담당 역할": f.grole.value, "진행률": 0, "상태": "진행 중" };
        if (f.gparent.value) p["상위 목표"] = f.gparent.value;
        if (f.gdue.value) { p["마감"] = f.gdue.value }
        act("goalnew", () => createPages("goals", [p]), "목표를 추가했습니다.");
      } },
        h("label", { class: "field wide" }, "목표", h("input", { id: "gname", name: "gname", placeholder: "예: 가편집 v03 교수님 확인 받기" })),
        h("label", { class: "field" }, "프로젝트", h("select", { id: "gproj", name: "gproj" }, projOptions())),
        h("label", { class: "field" }, "상위 목표", h("select", { id: "gparent", name: "gparent" }, h("option", { value: "", text: "없음 (최상위)" }), tops.map((g) => h("option", { value: g["목표"], text: g["목표"] })))),
        h("label", { class: "field" }, "담당 역할", h("select", { id: "grole", name: "grole" }, ["PM", "기획", "디자인", "촬영", "편집", "전원"].map((p) => h("option", { value: p, text: p })))),
        dateField("gdue", "마감", { placeholder: "마감 없음", quick: Object.entries(PROJECT_DEADLINES).map(([p, [d, what]]) => [`${p.split(" ")[0]} ${what} ${d.slice(5).replace("-", "/")}`, d]) }),
        h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit", disabled: S.busy, text: "추가" }))),
      flashEl("goalnew"));

    return [pageHead("목표", "프로젝트 목표 아래 하위 목표를 둡니다. 하위 목표가 있으면 상위 진행률은 자동으로 평균이 됩니다."),
      S.isPM ? goalAskBox() : null,
      byProject.length ? byProject : h("div", { class: "empty", text: "아직 목표가 없습니다. 아래에서 프로젝트 목표부터 추가하세요." }),
      flashEl("goal"), create];
  }

  // ---------- 미팅 ----------
  function viewMeetings() {
    const all = S.data.meetings;
    const up = all.filter((m) => m["일시"] && dday(m["일시"]) >= 0).sort((a, b) => String(a["일시"]).localeCompare(String(b["일시"])));
    const past = all.filter((m) => m["일시"] && dday(m["일시"]) < 0).sort((a, b) => String(b["일시"]).localeCompare(String(a["일시"])));
    const tbd = all.filter((m) => !m["일시"]);
    const lists = { upcoming: up, past, tbd };
    const list = lists[S.meetTab];
    if (!list.find((m) => m.url === S.sel.meeting)) S.sel.meeting = list[0] ? list[0].url : null;
    const cur = list.find((m) => m.url === S.sel.meeting);

    const tabs = h("div", { class: "tabs", role: "tablist" }, [["upcoming", "예정", up.length], ["past", "지난", past.length], ["tbd", "일정 미정", tbd.length]].map(([k, l, n]) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(S.meetTab === k), text: `${l} ${n}`, onclick: () => { S.meetTab = k; S.ai = null; S.aiState = null; render(); } })));

    const left = h("section", { class: "box" }, tabs,
      list.length ? h("div", { class: "rows" }, list.map((m) => h("button", { class: "row", type: "button", "aria-selected": String(m.url === S.sel.meeting), onclick: () => { S.sel.meeting = m.url; S.ai = null; S.aiState = null; S.editMeeting = null; render(); } },
        h("span", { class: "dday", text: whenText(m["일시"]) }),
        h("div", {}, h("div", { class: "t", text: m["제목"] || "(제목 없음)" }), h("div", { class: "m" }, m["종류"] ? h("span", { class: "pill" + (m["종류"] === "원온원" ? " info" : ""), text: m["종류"] }) : null, m["프로젝트"] ? h("span", { class: "pill", text: m["프로젝트"] }) : null, m["요약"] ? h("span", { class: "pill ok", text: "요약 있음" }) : null)), h("span")))) :
        h("div", { class: "empty", text: "이 탭에 미팅이 없습니다." }));

    let right;
    if (!cur) right = h("section", { class: "box" }, h("div", { class: "empty", text: "미팅을 고르면 아젠다, 노트, 자동 정리가 나옵니다." }));
    else {
      const ai = S.ai && S.ai.url === cur.url ? S.ai : null;
      right = h("section", { class: "box detail" },
        h("div", { class: "actions" }, cur["종류"] ? h("span", { class: "pill" + (cur["종류"] === "원온원" ? " info" : ""), text: cur["종류"] }) : null, h("span", { class: "dday", text: whenText(cur["일시"]) }),
          S.isPM && S.editMeeting !== cur.url ? h("button", { class: "btn small", type: "button", style: "margin-left:auto", text: "정보 수정", onclick: () => { S.editMeeting = cur.url; render(); } }) : null),
        S.editMeeting === cur.url && S.isPM ? meetingEditForm(cur) : [
          h("h3", { text: cur["제목"] || "(제목 없음)" }),
          h("dl", { class: "kv" }, h("dt", { text: "참석자" }), h("dd", { text: cur["참석자"] || "—" }), h("dt", { text: "프로젝트" }), h("dd", { text: cur["프로젝트"] || "미분류" }), h("dt", { text: "아젠다" }), h("dd", { text: cur["아젠다"] || "—" })),
          cur["수정한 사람"] ? h("div", { class: "msg", style: "color:var(--muted)", text: `PM이 ${String(cur["정보 수정"] || "").slice(5, 16).replace("T", " ")}에 정보를 고쳤습니다.` }) : null],
        cur["종류"] === "원온원" ? h("div", { class: "notice", text: "원온원 노트는 두 사람이 함께 봅니다. 혼자만 볼 메모는 여기 적지 마세요." }) : null,
        h("div", { class: "tplbar" },
          h("label", { for: "mtpl", text: "회의록 양식" }),
          h("select", { id: "mtpl", "aria-label": "회의록 양식" }, Object.keys(TEMPLATES).map((k) => { const o = h("option", { value: k, text: k }); if (k === templateFor(cur["종류"])) o.selected = true; return o; })),
          h("button", { class: "btn small", type: "button", text: "양식 넣기", title: "노트가 비어 있으면 양식으로 채우고, 적은 것이 있으면 아래에 붙입니다", onclick: () => { const ta = $("mnote"), t = TEMPLATES[$("mtpl").value]; ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, "")}\n\n${t}` : t; ta.focus(); const i = ta.value.indexOf("- ") + 2; ta.setSelectionRange(i, i); } }),
          h("span", { class: "msg", style: "color:var(--muted)", text: "[결정]과 [액션 아이템] 칸에 적은 줄은 자동 정리가 그대로 가져갑니다." })),
        h("label", { class: "field" }, "노트", h("textarea", { id: "mnote", placeholder: "'양식 넣기'로 시작하거나, 회의 중 나온 말을 한 줄에 하나씩 적으세요. 예: 엔딩 10초 줄이기로 함 (편집) / 폰트 라이선스 금요일까지 확인 (디자인)", value: cur["노트"] || "",
          onblur: (e) => { const v = e.target.value; if (S.mode === "live" && v !== (cur["노트"] || "") && v.trim()) updatePage(cur, { "노트": v }).then(() => { const el = $("mnote-saved"); if (el) el.textContent = `자동 저장 ${hm(new Date())}`; }).catch(() => {}); } })),
        h("div", { class: "actions" },
          h("button", { class: "btn", type: "button", disabled: S.busy, text: "노트 저장", onclick: () => act("meet", () => updatePage(cur, { "노트": $("mnote").value }), "노트를 저장했습니다.") }),
          h("button", { class: "btn accent", type: "button", disabled: S.busy, text: "자동 정리", title: "규칙으로 결정 사항과 액션 아이템을 고릅니다. 추가 비용이 들지 않습니다.", onclick: () => { const v = $("mnote").value; if (!v.trim()) { S.aiState = "노트가 비어 있습니다. 먼저 노트를 적어 주세요."; render(); return; } S.ai = autoSummarize(cur, v); S.aiState = "done"; render(); } }),
          S.sample ? h("button", { class: "btn", type: "button", disabled: S.busy || S.aiState === "thinking", text: S.aiState === "thinking" ? "요약하는 중" : "AI 요약 (Claude 사용)", onclick: () => summarize(cur, $("mnote").value) }) : null,
          h("button", { class: "btn", type: "button", text: "회의록 만들기", title: "미팅 정보, 요약, 결정, 액션 아이템, 노트를 한 장으로 묶습니다", onclick: () => { S.minutes = { url: cur.url, text: minutesText(cur, $("mnote").value) }; render(); } }),
          h("span", { id: "mnote-saved", class: "msg", style: "color:var(--muted)" })),
        S.minutes && S.minutes.url === cur.url ? h("div", { class: "detail" },
          h("label", { class: "field" }, "회의록 (고쳐서 쓰세요)", h("textarea", { id: "minutes", style: "min-height:260px", value: S.minutes.text })),
          h("div", { class: "actions" },
            h("button", { class: "btn", type: "button", text: "복사", onclick: async (e) => { const ta = $("minutes"); try { await navigator.clipboard.writeText(ta.value); e.target.textContent = "복사했습니다"; } catch (err) { ta.focus(); ta.select(); e.target.textContent = "선택했습니다. 복사하세요"; } } }),
            APP ? h("button", { class: "btn primary", type: "button", disabled: S.busy, text: "드라이브에 저장", onclick: () => { const text = $("minutes").value; act("meet", async () => { await saveTextToDrive(cur["프로젝트"], `회의록 ${String(cur["일시"] || ymd(new Date())).slice(0, 10)} ${cur["제목"] || "미팅"}.txt`, text, "회의록"); S.minutes = null; }, "회의록을 드라이브의 회의록 폴더에 저장했습니다."); } }) : null,
            h("button", { class: "btn", type: "button", text: "닫기", onclick: () => { S.minutes = null; S.clearDrafts = true; render(); } }))) : null,
        h("div", { class: "msg", style: "color:var(--muted)", text: "자동 정리는 노트 문장에서 결정 사항과 액션 아이템을 골라 줍니다. 고른 것은 작업 제안으로 올릴 수 있습니다." }),
        S.aiState && S.aiState !== "thinking" && S.aiState !== "done" ? h("div", { class: "msg err", text: S.aiState }) : null,
        ai ? h("div", { class: "detail" },
          h("div", { class: "field" }, ai.engine === "자동 정리" ? "자동 정리 (노트 문장을 골라 붙인 것)" : "AI 요약", h("div", { class: "quote", text: ai.summary || "—" })),
          ai.decisions.length ? h("div", { class: "field" }, "결정 사항", h("ul", { style: "margin:0;padding-left:18px" }, ai.decisions.map((d) => h("li", { text: d })))) : null,
          h("div", { class: "field" }, "액션 아이템 (체크한 것을 작업 제안으로 올립니다)",
            ai.actions.length ? h("div", { class: "rows" }, ai.actions.map((a, i) => h("label", { class: "row" },
              h("input", { type: "checkbox", id: `act-${i}`, checked: true }),
              h("div", {}, h("div", { class: "t", text: a.title }), h("div", { class: "m" }, h("span", { class: "pill", text: [a.role || "미정", a.who].filter(Boolean).join(" · ") }), a.due ? h("span", { class: "pill", text: a.due }) : null)), h("span")))) : h("div", { class: "empty", text: "액션 아이템이 없습니다." })),
          h("div", { class: "actions" },
            h("button", { class: "btn primary", type: "button", disabled: S.busy, text: "요약 저장하고 제안 올리기", onclick: () => saveSummary(cur, ai) }))) :
          (cur["요약"] ? h("div", { class: "detail" },
            h("div", { class: "field" }, "저장된 요약", h("div", { class: "quote", text: cur["요약"] })),
            cur["결정 사항"] ? h("div", { class: "field" }, "결정 사항", h("div", { class: "quote", text: cur["결정 사항"] })) : null,
            cur["액션 아이템"] ? h("div", { class: "field" }, "액션 아이템", h("div", { class: "quote", text: cur["액션 아이템"] })) : null) : null),
        h("div", { class: "field" }, "미팅 후기",
          h("div", { class: "lights" }, [["좋음", "g"], ["보통", "y"], ["아쉬움", "r"]].map(([v, c]) => h("button", { type: "button", class: c, "aria-pressed": String(cur["만족도"] === v), text: v, disabled: S.busy, onclick: () => act("meet", () => updatePage(cur, { "만족도": v }), "후기를 남겼습니다.") })))),
        flashEl("meet"));
    }

    const actionsAll = S.data.tasks.filter((r) => r["출처 미팅"]);
    const actBox = h("section", { class: "box" }, h("h2", {}, "모든 액션 아이템", h("span", { class: "n", text: `${actionsAll.length}건` })),
      h("p", { class: "sub", text: "미팅에서 나온 일입니다. 끝난 뒤 도움이 됐는지 신호등으로 남기면 어떤 조치가 효과 있었는지 쌓입니다." }),
      actionsAll.length ? h("div", { class: "rows" }, actionsAll.map((r) => h("div", { class: "row" },
        h("span", { class: "pill", text: statusOf(r) }),
        h("div", {}, h("div", { class: "t", text: r["할 일"] || "(제목 없음)" }), h("div", { class: "m", text: r["출처 미팅"] })),
        h("div", { class: "lights" }, [["도움 됨", "g"], ["보통", "y"], ["도움 안 됨", "r"]].map(([v, c]) => h("button", { type: "button", class: c, "aria-pressed": String(r["효과"] === v), text: v, disabled: S.busy, onclick: () => act("acts", () => updatePage(r, { "효과": v }), "회고를 남겼습니다.") })))))) :
        h("div", { class: "empty", text: "미팅에서 올린 액션 아이템이 아직 없습니다." }),
      flashEl("acts"));

    const create = h("section", { class: "box" }, h("h2", {}, "미팅 만들기"),
      h("form", { class: "form", onsubmit: (e) => {
        e.preventDefault();
        const f = e.target, title = f.mtitle.value.trim();
        if (!title) { S.flash.meetnew = { ok: false, text: "미팅 제목을 적어 주세요." }; render(); return; }
        const p = { "제목": title, "종류": f.mkind.value, "프로젝트": f.mproj.value, "참석자": f.mwho.value.trim(), "아젠다": f.magenda.value.trim() };
        if (f.mwhen.value) { p["일시"] = f.mwhen.value }
        act("meetnew", () => createPages("meetings", [p]), "미팅을 만들었습니다.");
      } },
        h("label", { class: "field wide" }, "제목", h("input", { id: "mtitle", name: "mtitle", placeholder: "예: 공모전 2차 제작 회의" })),
        h("label", { class: "field" }, "종류", h("select", { id: "mkind", name: "mkind" }, ["정기 회의", "원온원", "임시 회의", "외부 미팅"].map((p) => h("option", { value: p, text: p })))),
        h("label", { class: "field" }, "프로젝트", h("select", { id: "mproj", name: "mproj" }, projOptions())),
        dateField("mwhen", "일시", { placeholder: "일정 미정", time: true }),
        h("label", { class: "field" }, "참석자", h("input", { id: "mwho", name: "mwho", placeholder: "PM, 편집" })),
        h("label", { class: "field wide" }, "아젠다", h("input", { id: "magenda", name: "magenda", placeholder: "예: 가편집 피드백, 다음 촬영 일정" })),
        h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit", disabled: S.busy, text: "만들기" }))),
      flashEl("meetnew"));

    return [pageHead("미팅", "노트를 적고 자동 정리를 누르면 결정 사항과 액션 아이템이 뽑힙니다. 액션 아이템은 작업 제안으로 올라갑니다."), h("div", { class: "split" }, left, right), h("div", { class: "grid2" }, actBox, create)];
  }

  const MEET_KINDS = ["정기 회의", "원온원", "임시 회의", "외부 미팅"];
  function meetingEditForm(m) {
    const sel = (id, list, cur) => h("select", { id, name: id }, list.map((v) => { const o = h("option", { value: v, text: v }); if (v === cur) o.selected = true; return o; }));
    return h("form", { class: "form", onsubmit: (e) => {
        e.preventDefault();
        const f = e.target, title = f.etitle.value.trim();
        if (!title) { S.flash.meet = { ok: false, text: "미팅 제목을 비울 수 없습니다." }; render(); return; }
        const props = { "제목": title, "종류": f.ekind.value, "프로젝트": f.eproj.value, "참석자": f.ewho.value.trim(), "아젠다": f.eagenda.value.trim(), "일시": f.ewhen.value || "",
          "정보 수정": new Date().toISOString(), "수정한 사람": "PM" };
        // 제목이 바뀌면 이 미팅에서 나온 액션 아이템의 '출처 미팅'도 함께 바꾼다
        const oldTitle = m["제목"];
        act("meet", async () => {
          await updatePage(m, props);
          if (oldTitle && oldTitle !== title) for (const t of S.data.tasks.filter((r) => r["출처 미팅"] === oldTitle)) await updatePage(t, { "출처 미팅": title });
          S.editMeeting = null;
        }, "미팅 정보를 고쳤습니다.");
      } },
      h("label", { class: "field wide" }, "제목", h("input", { id: "etitle", name: "etitle", value: m["제목"] || "" })),
      h("label", { class: "field" }, "종류", sel("ekind", MEET_KINDS, m["종류"] || "정기 회의")),
      h("label", { class: "field" }, "프로젝트", sel("eproj", PROJECTS, m["프로젝트"] || "미분류")),
      dateField("ewhen", "일시", { placeholder: "일정 미정", time: true, value: m["일시"] || "" }),
      h("label", { class: "field" }, "참석자", h("input", { id: "ewho", name: "ewho", value: m["참석자"] || "", placeholder: "PM, 편집" })),
      h("label", { class: "field wide" }, "아젠다", h("input", { id: "eagenda", name: "eagenda", value: m["아젠다"] || "", placeholder: "예: 가편집 피드백" })),
      h("div", { class: "actions wide" },
        h("button", { class: "btn primary", type: "submit", disabled: S.busy, text: "저장" }),
        h("button", { class: "btn", type: "button", text: "취소", onclick: () => { S.editMeeting = null; S.clearDrafts = true; render(); } })));
  }

  async function summarize(m, note) {
    if (!S.sample) return;
    if (!String(note || "").trim()) { S.aiState = "노트가 비어 있습니다. 먼저 노트를 적어 주세요."; render(); return; }
    S.aiState = "thinking"; render();
    const prompt = [
      "너는 영상 제작 팀의 미팅 기록을 정리하는 도우미다. 아래 미팅 노트만 근거로 정리한다. 노트에 없는 내용은 만들지 않는다.",
      "갈등, 개인 사정, 건강, 성적 이야기는 요약과 액션 아이템에 넣지 않는다.",
      `오늘 날짜: ${ymd(new Date())}. "내일", "금요일" 같은 말은 미팅 날짜 기준으로 YYYY-MM-DD로 바꾼다. 날짜가 없으면 null.`,
      "담당 역할은 PM, 기획, 디자인, 촬영, 편집, 미정 중 하나.",
      '다음 JSON만 답한다: {"summary": "3문장 이내 요약", "decisions": ["결정 사항"], "actions": [{"title": "동사로 끝나는 한 줄", "role": "편집", "due": "2026-11-20"}]}',
      "",
      `미팅 제목: ${m["제목"] || ""}`,
      `미팅 날짜: ${String(m["일시"] || "미정").slice(0, 10)}`,
      `종류: ${m["종류"] || ""} / 참석자: ${m["참석자"] || ""}`,
      `아젠다: ${m["아젠다"] || ""}`,
      "노트:",
      String(note).slice(0, 12000)
    ].join("\n");
    try {
      const out = await S.sample.json(prompt);
      const actions = Array.isArray(out && out.actions) ? out.actions.filter((a) => a && a.title).map((a) => ({ title: String(a.title).slice(0, 200), role: ROLES.includes(a.role) ? a.role : "미정", due: /^\d{4}-\d{2}-\d{2}$/.test(String(a.due || "")) ? a.due : null })) : [];
      S.ai = { url: m.url, note, summary: String((out && out.summary) || "").slice(0, 1500), decisions: Array.isArray(out && out.decisions) ? out.decisions.map(String).slice(0, 20) : [], actions, engine: "AI 요약" };
      S.aiState = "done";
    } catch (e) {
      const c = e && e.code;
      S.aiState = c === "not_granted" ? "AI 요약을 허용하지 않아 쓸 수 없습니다." : c === "rate_limited" ? "요청이 많습니다. 잠시 뒤 다시 누르세요." : c === "invalid_json" ? "요약 형식을 읽지 못했습니다. 다시 눌러 주세요." : c === "cancelled" ? null : "요약하지 못했습니다. 잠시 뒤 다시 누르세요.";
      if (c === "not_granted" || c === "sampling_disabled") S.sample = null;
    }
    render();
  }

  function saveSummary(m, ai) {
    const picked = ai.actions.filter((_, i) => { const el = $(`act-${i}`); return el && el.checked; });
    act("meet", async () => {
      await updatePage(m, { "노트": ai.note, "요약": ai.summary, "결정 사항": ai.decisions.join("\n"), "액션 아이템": ai.actions.map((a) => `${a.title} (${[a.role, a.who].filter(Boolean).join(" ")}${a.due ? `, ${a.due.slice(5).replace("-", "/")}까지` : ""})`).join("\n") });
      if (picked.length) await createPages("tasks", picked.map((a) => {
        const p = { "할 일": a.title, "상태": "제안", "프로젝트": m["프로젝트"] || "미분류", "담당 역할": a.role, "출처": "회의록", "작성": "ODD HR 작성", "출처 미팅": m["제목"] || "", "근거 메시지": `${m["제목"] || "미팅"} 노트에서 추출`, "확신도": "중간" };
        if (a.due) { p["마감"] = a.due }
        if (a.who) p["담당자"] = a.who;
        return p;
      }));
      S.ai = null;
    }, picked.length ? `요약을 저장하고 ${picked.length}건을 작업 제안으로 올렸습니다.` : "요약을 저장했습니다.");
  }

  // ---------- 에이전트 ----------
  function viewAgents() {
    const A = [
      ["카톡 점검", "PC 에이전트", "3분마다 · 지금 점검 버튼 · 무료", ["지정한 카톡 대화방"], ["규칙으로 할 일 후보 고르기", "애매한 것만 로컬 모델에 다시 묻기 (선택)", "민감한 메시지는 원문 없이 PM 확인 필요로만 표시"], ["카톡 발송", "Desk의 기존 행 수정과 삭제", "메시지를 PC 밖으로 보내기"], "PM"],
      ["아침상", "앱", "열 때마다 · 무료", ["작업, 목표, 미팅 저장소"], ["오늘 결정할 것과 불씨 정리"], ["할 일 확정", "외부 발송"], "PM"],
      ["미팅 정리", "앱", "자동 정리를 누를 때 · 무료", ["그 미팅의 노트"], ["결정 사항과 액션 아이템 고르기", "고른 것을 작업 제안으로 올리기"], ["노트에 없는 내용 만들기", "민감한 문장 옮기기", "제안 확정"], "누른 사람"],
      ["주간 업데이트", "앱", "언제든 · 무료", ["본인 역할의 할 일 상태"], ["본인용 주간 진행 초안"], ["대신 제출", "사람 평가"], "본인"]
    ];
    const cards = h("div", { class: "cards" }, A.map(([name, kind, when, reads, does, cant, off]) => h("article", { class: "card" },
      h("div", { class: "actions" }, h("h3", { text: name }), h("span", { class: "pill" + (kind === "PC 에이전트" ? " ai" : " info"), text: kind })),
      h("div", { class: "m", style: "font-size:12.5px;color:var(--muted)", text: when }),
      h("div", { class: "lab", text: "읽는 것" }), h("ul", {}, reads.map((x) => h("li", { text: x }))),
      h("div", { class: "lab", text: "하는 것" }), h("ul", {}, does.map((x) => h("li", { text: x }))),
      h("div", { class: "lab", text: "하지 않는 것" }), h("ul", {}, cant.map((x) => h("li", { text: x }))),
      h("div", { class: "m", style: "font-size:12.5px", text: `끄는 사람: ${off}` }))));

    const st = S.pc.status;
    const last = st && Array.isArray(st.recent_runs) && st.recent_runs[0];
    const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: (e) => importFile(e.target.files && e.target.files[0]) });
    const pc = h("section", { class: "box" },
      h("h2", {}, "PC 에이전트", h("span", { class: "pill ok", text: "추가 비용 0" })),
      h("p", { class: "sub", text: "PM의 PC(Windows, Mac)에서 ODD HR 앱 안에 들어 있는 에이전트입니다. 앱이 켜져 있으면(창을 닫아 트레이에 있어도) 정한 간격마다 카톡 대화방을 읽고, 할 일 후보를 바로 팀 서버에 제안으로 올립니다. 바로 보고 싶으면 '지금 카톡 점검하기'를 누르세요." }),
      st ? h("dl", { class: "kv" },
        h("dt", { text: "자동 점검" }), h("dd", { text: lsGet("oddhr.autoscan") !== "0" ? `${Math.round((st.interval_sec || 180) / 60)}분마다 (앱이 켜져 있을 때)` : "꺼짐 (설정에서 켜기)" }),
        h("dt", { text: "감시 대화방" }), h("dd", { text: (st.rooms || []).join(", ") || "없음 (설치 때 지정)" }),
        h("dt", { text: "판정 방식" }), h("dd", { text: st.engine || "규칙" }),
        h("dt", { text: "가져올 제안" }), h("dd", { text: `${st.waiting || 0}건${st.flags_waiting ? ` · PM 확인 필요 ${st.flags_waiting}건` : ""}` }),
        h("dt", { text: "최근 점검" }), h("dd", { text: last ? `${String(last.at || "").slice(5, 16).replace("T", " ")} · ${last.error ? "실패: " + last.error : `새 메시지 ${last.new_n}건, 제안 ${last.tasks_n}건`}` : "기록 없음" })) : null,
      S.isOwner ? h("div", { class: "actions" },
        checkNowBtn(true),
        h("button", { class: "btn", type: "button", disabled: S.pc.state === "busy", text: "가져오기만", onclick: () => pcSync(false, false) }),
        h("button", { class: "btn", type: "button", disabled: S.pc.state === "busy", text: "상태 보기", onclick: pcStatus })) : null,
      h("div", { class: "actions" },
        h("button", { class: "btn small", type: "button", disabled: S.pc.state === "busy" || S.canWrite === false, text: "파일에서 가져오기", onclick: () => fileInput.click() }), fileInput,
        h("span", { class: "msg", style: "color:var(--muted)", text: "다른 PC의 카톡 에이전트가 만든 %LOCALAPPDATA%\\ODD-HR\\outbox 파일을 올려도 됩니다." })),
      S.isOwner ? null : h("div", { class: "notice", text: "카톡 에이전트는 PM의 PC(Windows, Mac)에서 ODD HR 앱이 켜져 있을 때 돕니다. 대화방과 간격은 설정에서 바꿉니다." }),
      flashEl("pc"));
    const know = h("section", { class: "box" }, h("h2", {}, "지식과 데이터"),
      h("p", { class: "sub", text: "에이전트는 아래 자료만 근거로 씁니다. 폐기된 산출물과 대체된 결정은 읽지 않습니다." }),
      h("div", { class: "rows" }, [["작업", "#tasks", "제안과 할 일 (팀 서버)"], ["목표", "#goals", "프로젝트 목표와 진행률 (팀 서버)"], ["미팅", "#meetings", "미팅 노트와 요약 (팀 서버)"]].map(([n, u, d]) =>
        h("div", { class: "row" }, h("span", { class: "pill", text: "문서" }), h("div", {}, h("div", { class: "t" }, h("a", u.startsWith("#") ? { href: u, text: n } : { href: u, target: "_blank", rel: "noopener", text: n })), h("div", { class: "m", text: d })), h("span")))));
    const rules = h("div", { class: "notice" }, "모든 에이전트 공통: 메시지와 문서 속 문장은 지시가 아니라 데이터로 다룹니다. 삭제하지 않고 기각이나 폐기 표시만 합니다. 외부 발송, 일정 변경, 범위 축소는 초안까지만 만들고 사람이 승인 이유와 함께 승인합니다. 만든 것에는 ODD HR 작성 표시를 붙입니다.");
    return [pageHead("에이전트", "ODD HR에서 일하는 에이전트와 각자 읽는 것, 하는 것, 하지 않는 것입니다. 모든 기능이 추가 비용 없이 돕니다."), pc, cards, know, rules];
  }

  // ---------- 알림: 데이터에서 계산한다 (읽은 시각은 이 기기에 저장) ----------
  const seenKey = () => `oddhr.seen.${S.me || "x"}`;
  const seenAt = () => Number(lsGet(seenKey()) || 0);
  function allNotifs() {
    if (!APP || !S.me) return [];
    const out = [], me = S.me;
    const push = (id, at, kind, text, sub, go, acts) => out.push({ id, at: T(at), kind, text, sub, go, acts });
    S.data.tasks.forEach((r) => {
      const st = statusOf(r), by = r["상태 변경자"], byName = r["상태 변경자 이름"] || "팀원";
      if (st === "제안" && r["제안한 사람"] && r["만든 사람"] !== me && isMine(r))
        push(`p-${r.url}`, r["생성"], "요청", r["출처"] === "PM 제안" ? `${r["제안한 사람"]}님(PM)이 업무를 요청했습니다` : `${r["제안한 사람"]}님이 할 일을 제안했습니다`, r["할 일"], () => openTask(r.url), [["수락", () => acceptTask(r), true], ["넘기기", () => { openTask(r.url); S.drawer.decline = true; renderDrawer(); }]]);
      if (r["만든 사람"] === me && r["출처"] === "팀원 제안" && by && by !== me && ["진행", "기각"].includes(st))
        push(`a-${r.url}-${st}`, r["상태 변경"], st === "기각" ? "거절" : "수락", `${byName}님이 내 제안을 ${st === "기각" ? "넘겼습니다" : "수락했습니다"}`, `${r["할 일"]}${st === "기각" && r["기각 사유"] ? ` · ${r["기각 사유"]}` : ""}`, () => openTask(r.url));
      if (st === "완료" && by && by !== me && isMine(r))
        push(`d-${r.url}`, r["상태 변경"], "완료", `PM이 완료 처리했습니다`, r["할 일"], () => openTask(r.url));
      if (st === "검토 요청" && isPMof(r["프로젝트"]) && by && by !== me)
        push(`r-${r.url}-${r["상태 변경"]}`, r["상태 변경"], "검토", `${byName}님이 검토를 요청했습니다`, r["할 일"], () => openTask(r.url), [["승인", () => setStatus(r, "완료", {}, "승인해 완료했습니다."), true], ["다시 해 주세요", () => { setStatus(r, "진행", {}, "다시 진행으로 돌렸습니다."); openChat(`d:${by}`, `「${r["할 일"]}」 `); }]]);
      if (st === "막힘" && isPMof(r["프로젝트"]) && by && by !== me)
        push(`b-${r.url}-${r["상태 변경"]}`, r["상태 변경"], "막힘", `${byName}님이 막혔다고 표시했습니다`, r["할 일"], () => openTask(r.url), [["묻기", () => openChat(`d:${by}`, `「${r["할 일"]}」 어디서 막혔어요? `), true]]);
      const n = dday(r["마감"]);
      if (isMine(r) && ["대기", "진행", "막힘"].includes(st) && n !== null && n <= 1 && n >= 0)
        push(`due-${r.url}-${ymd(new Date())}`, new Date(new Date().setHours(8, 0, 0, 0)).toISOString(), "마감", n === 0 ? "오늘 마감입니다" : "내일 마감입니다", r["할 일"], () => openTask(r.url), [["검토 요청", () => setStatus(r, "검토 요청", {}, "PM에게 검토 요청을 올렸습니다.")]]);
    });
    S.msgs.forEach((m) => { if (m.to === me && m.from !== me) push(`m-${m.url}`, m.at, "메시지", `${nameOf(m.from)}님의 메시지`, String(m.text || "").slice(0, 80), () => (m.task ? openTask(m.task) : openChat(`d:${m.from}`)), [["답장", () => openChat(`d:${m.from}`), true]]); });
    S.weeklies.forEach((w) => {
      if (w.from !== me && isPMof(w["프로젝트"]) && !w["PM 확인"]) push(`w-${w.url}-${w["제출"]}`, w["제출"], "주간", `${w["이름"] || nameOf(w.from)}님이 주간 업데이트를 냈습니다`, w["프로젝트"], () => { S.weekOpen = w.url; go("home"); });
      if (w.from === me && w["PM 확인"]) push(`wc-${w.url}`, w["PM 확인 시각"], "확인", `${w["PM 확인"]}님이 내 주간 업데이트를 확인했습니다`, w["PM 코멘트"] || w["프로젝트"], () => { S.weekOpen = w.url; go("home"); });
    });
    S.files.forEach((f) => { if (f.from !== me && T(f.at) > Date.now() - 3 * 864e5) push(`f-${f.url}`, f.at, "파일", `${f["올린이"] || nameOf(f.from)}님이 드라이브에 올렸습니다`, f["이름"], () => { S.drive.proj = pidOf(f["프로젝트"]); go("drive"); }); });
    const gn = goalNotif(); if (gn) out.push(gn);
    return out.sort((a, b) => b.at - a.at).slice(0, 60);
  }
  const unreadNotifs = () => { const s = seenAt(); return allNotifs().filter((n) => n.at > s && n.kind !== "파일"); };
  const told = new Set(); let toldReady = false;
  setInterval(() => { try { tellOS(); renderMenu(); } catch (e) {} }, 60000);   // 목표 확인 시각 등 시간이 지나 생기는 알림
  function tellOS() {
    if (!APP || !S.me || lsGet("oddhr.notify") === "0") return;
    const list = unreadNotifs();
    if (!toldReady) { if (S.mode === "live" && S.data.tasks.length + S.msgs.length) { list.forEach((n) => told.add(n.id)); toldReady = true; } return; }
    const fresh = list.filter((n) => !told.has(n.id) && n.at > Date.now() - 10 * 60000);
    list.forEach((n) => told.add(n.id));
    if (fresh.length === 1) APP.notify(`ODD HR · ${fresh[0].text}`, fresh[0].sub || "");
    else if (fresh.length > 1) APP.notify("ODD HR", `새 알림 ${fresh.length}건: ${fresh.slice(0, 3).map((n) => n.text).join(" / ")}`);
  }
  const KIND_CLASS = { 요청: "info", 목표: "ai", 제안: "info", 수락: "ok", 완료: "ok", 확인: "ok", 거절: "risk", 막힘: "risk", 마감: "risk", 검토: "", 메시지: "info", 주간: "ai", 파일: "" };
  function notifBox() {
    const all = allNotifs(), s = seenAt(), unread = all.filter((n) => n.at > s && n.kind !== "파일");
    if (!all.length) return null;
    const list = S.notifOpen ? all.slice(0, 20) : unread.slice(0, 5);
    if (!list.length) return h("div", { class: "notif-mini" }, h("span", { text: "새 알림이 없습니다." }), h("button", { class: "linkish", type: "button", text: `지난 알림 ${all.length}건 보기`, onclick: () => { S.notifOpen = true; render(); } }));
    return h("section", { class: "box notif" },
      h("h2", {}, "알림", unread.length ? h("span", { class: "n", text: `새 ${unread.length}건` }) : null,
        h("span", { class: "toolbar", style: "margin-left:auto" },
          unread.length ? h("button", { class: "btn small", type: "button", text: "모두 읽음", onclick: () => { lsSet(seenKey(), String(Date.now())); render(); } }) : null,
          h("button", { class: "btn small", type: "button", text: S.notifOpen ? "새 알림만" : "지난 알림", onclick: () => { S.notifOpen = !S.notifOpen; render(); } }))),
      h("div", { class: "rows" }, list.map((n) => h("div", { class: "row notif-row" + (n.at > s ? " unread" : "") },
        h("span", { class: "pill " + (KIND_CLASS[n.kind] || ""), text: n.kind }),
        h("button", { class: "notif-main", type: "button", onclick: n.go }, h("div", { class: "t", text: n.text }), h("div", { class: "m", text: [n.sub, ago(new Date(n.at).toISOString())].filter(Boolean).join(" · ") })),
        h("div", { class: "actions" }, (n.acts || []).map(([l, fn, primary]) => h("button", { class: "btn small" + (primary ? " primary" : ""), type: "button", disabled: S.busy, text: l, onclick: fn })),
          h("button", { class: "btn small ghost", type: "button", text: "열기", onclick: n.go }))))));
  }

  // ---------- 시작 안내 (처음 쓰는 사람용, 다 하면 사라진다) ----------
  function starterBox() {
    if (!S.me || lsGet(`oddhr.starter.${S.me}`) === "done") return null;
    const pid = APP.currentProject, m = APP.myMember(pid);
    if (!m) return null;
    const pm = APP.isPM(pid);
    const steps = pm ? [
      ["팀원에게 입장 코드 나눠 주기", APP.members.filter((x) => x.project_id === pid).length > 1, "team"],
      ["첫 할 일을 팀원에게 제안하기", S.data.tasks.some((r) => r["만든 사람"] === S.me), "tasks"],
      ["프로젝트 대화방에 첫 글 쓰기", S.msgs.some((x) => x.from === S.me), "messages"],
      APP.agentAvailable ? ["카톡 대화방 연결하기", !!(S.pc.status && (S.pc.status.rooms || []).length), "settings"] : ["드라이브에 콘티나 기획안 올리기", S.files.some((f) => f.from === S.me), "drive"]
    ] : [
      ["팀원 탭에서 내 지금 단계 정하기", !!m.stage, "team"],
      ["프로젝트 대화방에 인사하기", S.msgs.some((x) => x.from === S.me), "messages"],
      ["이번 주 업데이트 제출하기", S.weeklies.some((w) => w.from === S.me), "todo"],
      ["설정에서 이메일 연결하기 (아이폰·다른 PC에서 쓰려면)", !APP.isAnon, "settings"]
    ];
    const left = steps.filter((x) => !x[1]).length;
    if (!left) { lsSet(`oddhr.starter.${S.me}`, "done"); return null; }
    return h("section", { class: "box starter" },
      h("h2", {}, "시작하기", h("span", { class: "n", text: `${steps.length - left}/${steps.length}` }),
        h("button", { class: "btn small", type: "button", style: "margin-left:auto", text: "숨기기", onclick: () => { lsSet(`oddhr.starter.${S.me}`, "done"); render(); } })),
      h("div", { class: "rows" }, steps.map(([t, done, v]) => h("button", { class: "row", type: "button", disabled: done, onclick: () => go(v) },
        h("span", { class: "check" + (done ? " 완료" : ""), "aria-hidden": "true" }), h("div", {}, h("div", { class: "t" + (done ? " struck" : ""), text: t })), h("span", { class: "pill", text: done ? "끝" : "하러 가기" })))));
  }

  // ---------- 메시지 ----------
  const nameOf = (uid) => { if (!APP) return "팀원"; if (uid === S.me) return "나"; const m = APP.members.find((x) => x.user_id === uid); return m ? m.name : "나간 사람"; };
  function channels() {
    if (!APP || !S.me) return [];
    const list = APP.projects.map((p) => ({ id: `p:${p.id}`, name: p.name, kind: "프로젝트", pid: p.id }));
    const seen = new Set();
    APP.members.filter((m) => m.user_id !== S.me && APP.projects.some((p) => p.id === m.project_id)).forEach((m) => {
      if (seen.has(m.user_id)) return; seen.add(m.user_id);
      list.push({ id: `d:${m.user_id}`, name: m.name, kind: m.role, uid: m.user_id, pid: m.project_id });
    });
    return list;
  }
  const inCh = (c, m) => c.uid ? (m.to === c.uid && m.from === S.me) || (m.from === c.uid && m.to === S.me) : !m.to && pidOf(m["프로젝트"]) === c.pid;
  const readKey = (id) => `oddhr.read.${S.me}.${id}`;
  const unreadIn = (id) => { const c = channels().find((x) => x.id === id); if (!c) return 0; const r = Number(lsGet(readKey(id)) || 0); return S.msgs.filter((m) => inCh(c, m) && m.from !== S.me && T(m.at) > r).length; };
  function chatLog(c) {
    const list = S.msgs.filter((m) => inCh(c, m));
    if (!list.length) return [h("div", { class: "empty", text: c.uid ? `${c.name}님에게 첫 메시지를 보내 보세요. 두 사람만 봅니다.` : "프로젝트 팀 전체가 보는 대화방입니다. 첫 글을 남겨 보세요." })];
    let day = "";
    return list.map((m) => {
      const d = String(m.at || "").slice(0, 10), mine = m.from === S.me, out = [];
      if (d !== day) { day = d; out.push(h("div", { class: "chat-day", text: d ? prettyDate(d) : "" })); }
      out.push(h("div", { class: "bubble-row" + (mine ? " mine" : "") },
        h("div", { class: "bubble" },
          mine || c.uid ? null : h("div", { class: "who", text: nameOf(m.from) }),
          m.file ? fileChip(m) : h("div", { class: "txt", text: m.text }),
          m.task && S.data.tasks.some((r) => r.url === m.task) ? h("button", { class: "task-link", type: "button", text: `☐ ${S.data.tasks.find((r) => r.url === m.task)["할 일"]} · ${statusOf(S.data.tasks.find((r) => r.url === m.task))}`, onclick: () => openTask(m.task) }) : null,
          h("div", { class: "meta" }, h("span", { text: hm(m.at) }),
            h("button", { class: "linkish", type: "button", text: "할 일로", title: "이 메시지로 할 일을 만들거나 업무 요청을 보냅니다 (화면을 떠나지 않음)", onclick: () => openQuick({ kind: !mine && m.from ? "업무 요청" : "할 일", title: titleOf(String(m.text).replace(/^「.*?」\s*/, "").split("\n")[0]), quote: `[${nameOf(m.from)}] ${String(m.text).slice(0, 300)}`, who: !mine && m.from ? nameOf(m.from) : "", proj: APP.projectName(c.pid) }) }),
            mine ? h("button", { class: "linkish danger", type: "button", text: "지우기", onclick: () => act("chat", () => S.db.collection("messages").doc(m.url).delete(), "지웠습니다.") }) : null))));
      return out;
    });
  }
  function refreshChat() {
    const log = $("chatlog"), c = channels().find((x) => x.id === S.chat.ch);
    if (!log || !c) return;
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.textContent = ""; [chatLog(c)].flat(Infinity).forEach((n) => n && log.appendChild(n));
    if (atEnd) log.scrollTop = log.scrollHeight;
    lsSet(readKey(c.id), String(Date.now()));
  }
  async function sendMsg(c, text, fileId, taskId) {
    const body = { text: text.slice(0, 4000), at: new Date().toISOString(), "프로젝트": APP.projectName(c.pid) };
    if (fileId) body.file = fileId;
    if (taskId) body.task = taskId;
    if (c.uid) body.to = c.uid;
    await S.db.collection("messages").doc(`m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`).set(body);
  }
  function chatListBox(chs, c, item) {
    item = item || ((ch) => h("button", { class: "row", type: "button", onclick: () => { S.chat.ch = ch.id; S.chat.list = false; render(); } }, h("div", { class: "avatar small" + (ch.uid ? "" : " group"), text: ch.uid ? ch.name.slice(0, 1) : "#" }), h("div", {}, h("div", { class: "t", text: ch.name })), h("span")));
    return h("section", { class: "box chat-list" + (S.chat.list === false && (c || S.chat.ch === "gmail") ? " hide-narrow" : "") },
      h("div", { class: "group-title" }, "프로젝트 대화방"), h("div", { class: "rows" }, chs.filter((x) => !x.uid).map(item)),
      chs.some((x) => x.uid) ? [h("div", { class: "group-title" }, "1:1 메시지"), h("div", { class: "rows" }, chs.filter((x) => x.uid).map(item))] : h("div", { class: "msg", style: "color:var(--muted)", text: "팀원이 들어오면 1:1 메시지를 보낼 수 있습니다." }),
      APP && APP.gmailAvailable ? [h("div", { class: "group-title" }, "메일"), h("div", { class: "rows" }, h("button", { class: "row", type: "button", "aria-selected": String(S.chat.ch === "gmail"), onclick: () => { S.chat.ch = "gmail"; S.chat.list = false; render(); } },
        h("div", { class: "avatar small group", "aria-hidden": "true", text: "M" }), h("div", {}, h("div", { class: "t", text: "Gmail" }), h("div", { class: "m", text: APP.gmailToken() ? APP.gmailEmail() || "연결됨" : "구글 로그인으로 연결" })), h("span")))] : null);
  }
  function viewMessages() {
    if (!APP) return [pageHead("메시지", "앱에서만 쓸 수 있습니다.")];
    const chs = channels();
    if (S.chat.ch !== "gmail" && !chs.find((x) => x.id === S.chat.ch)) S.chat.ch = (chs.find((x) => x.pid === APP.currentProject) || chs[0] || {}).id || null;
    if (S.chat.ch === "gmail") return [pageHead("메시지", "팀 대화방은 프로젝트 멤버 모두가, 1:1 메시지는 두 사람만 봅니다."), h("div", { class: "chat-split open" }, chatListBox(chs, null), h("div", {}, h("button", { class: "btn small show-narrow", type: "button", text: "‹ 목록", onclick: () => { S.chat.ch = null; S.chat.list = true; render(); } }), gmailPanel()))];
    const c = chs.find((x) => x.id === S.chat.ch);
    const last = (ch) => { const l = S.msgs.filter((m) => inCh(ch, m)); return l[l.length - 1]; };
    const item = (ch) => { const n = unreadIn(ch.id), l = last(ch); return h("button", { class: "row", type: "button", "aria-selected": String(ch.id === S.chat.ch), onclick: () => { S.chat.ch = ch.id; S.chat.list = false; render(); } },
      h("div", { class: "avatar small" + (ch.uid ? "" : " group"), "aria-hidden": "true", text: ch.uid ? ch.name.slice(0, 1) : "#" }),
      h("div", {}, h("div", { class: "t", text: ch.name }), h("div", { class: "m", text: l ? `${l.from === S.me ? "나: " : ""}${String(l.text).slice(0, 40)}` : ch.uid ? ch.kind : "팀 전체 대화방" })),
      n ? h("span", { class: "badge", text: String(n) }) : h("span", { class: "m", text: l ? hm(l.at) : "" })); };
    const left = chatListBox(chs, c, item);
    if (!c) return [pageHead("메시지", ""), left];
    lsSet(readKey(c.id), String(Date.now()));
    const input = h("textarea", { id: "chatin", class: "quick-in", rows: 1, placeholder: c.uid ? `${c.name}님에게 메시지 (Enter 보내기, Shift+Enter 줄바꿈)` : `${c.name} 팀 전체에게 (Enter 보내기, Shift+Enter 줄바꿈)`, value: S.chat.draft || "",
      oninput: (e) => { S.chat.draft = e.target.value; e.target.style.height = "auto"; e.target.style.height = Math.min(160, e.target.scrollHeight) + "px"; },
      onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } });
    const send = async () => {
      const v = input.value.trim(); if (!v || S.chat.sending) return;
      S.chat.sending = true; input.value = ""; S.chat.draft = "";
      try { await sendMsg(c, v); S.flash.chat = null; } catch (e) { input.value = v; S.flash.chat = { ok: false, text: errText(e) }; }
      S.chat.sending = false; render(); setTimeout(() => { const el = $("chatin"); if (el) el.focus(); const lg = $("chatlog"); if (lg) lg.scrollTop = lg.scrollHeight; }, 0);
    };
    const log = h("div", { id: "chatlog", class: "chat-log", role: "log", "aria-live": "polite" }, chatLog(c));
    const right = h("section", { class: "box chat" },
      h("div", { class: "chat-head" },
        h("button", { class: "btn small show-narrow", type: "button", text: "‹ 목록", onclick: () => { S.chat.list = true; render(); } }),
        h("h2", {}, c.name, h("span", { class: "n", text: c.uid ? `1:1 · ${c.kind}` : `팀 ${APP.members.filter((m) => m.project_id === c.pid).length}명` }))),
      log,
      S.chat.pick ? filePicker(c) : null,
      h("div", { class: "quick-bar" },
        h("button", { class: "btn attach", type: "button", "aria-label": "드라이브 파일 보내기", title: "드라이브 파일 위치를 보냅니다", "aria-pressed": String(!!S.chat.pick), text: "📎", onclick: () => { S.chat.pick = !S.chat.pick; render(); } }),
        input, h("button", { class: "btn primary", type: "button", text: "보내기", onclick: send })),
      flashEl("chat"));
    setTimeout(() => { const lg = $("chatlog"); if (lg) lg.scrollTop = lg.scrollHeight; }, 0);
    return [pageHead("메시지", "팀 대화방은 프로젝트 멤버 모두가, 1:1 메시지는 두 사람만 봅니다. 메시지 옆 '할 일로'를 누르면 바로 할 일 제안이 됩니다."),
      h("div", { class: "chat-split" + (S.chat.list === false ? " open" : "") }, left, right)];
  }

  // ---------- 드라이브 ----------
  const FOLDERS = ["기획", "디자인", "촬영", "편집", "회의록", "기타"];
  const fileIcon = (f) => f["종류"] === "링크" ? "링크" : /^image\//.test(f["형식"] || "") ? "이미지" : /^video\//.test(f["형식"] || "") ? "영상" : /pdf/.test(f["형식"] || "") ? "PDF" : /^text\//.test(f["형식"] || "") ? "문서" : "파일";
  async function putFile(pname, file, folder, memo) {
    const pid = pidOf(pname); if (!pid) throw { code: "local", message: "프로젝트를 고르세요." };
    if (file.size > APP.files.max) throw { code: "local", message: `${file.name}: 50MB가 넘습니다. 큰 영상은 구글 드라이브 등에 올리고 '링크 등록'을 쓰세요.` };
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const ext = (String(file.name).match(/\.([A-Za-z0-9]{1,8})$/) || [, "bin"])[1].toLowerCase();
    const path = `${pid}/${id}.${ext}`;
    await APP.files.upload(pid, path, file);
    try { await S.db.collection("files").doc(id).set({ "이름": String(file.name).slice(0, 200), "종류": "파일", "경로": path, "크기": file.size, "형식": file.type || "", "폴더": folder, "메모": memo || "", "올린이": myNameFor(pname), at: new Date().toISOString(), "프로젝트": pname }); }
    catch (e) { try { await APP.files.remove(path); } catch (x) {} throw e; }
    return id;
  }
  const saveTextToDrive = (pname, name, text, folder) => putFile(pname, new File([text], name.replace(/[\\/:*?"<>|]/g, " ").slice(0, 120), { type: "text/plain;charset=utf-8" }), folder, "");
  async function openFile(f, save) {
    if (f["종류"] === "링크") { window.open(f["주소"], "_blank", "noopener"); return; }
    S.drive.busy = f.url; render();
    try {
      const b = await APP.files.blob(f["경로"]);
      const url = URL.createObjectURL(b);
      const a = h("a", { href: url, download: save ? f["이름"] : null, target: save ? null : "_blank", rel: "noopener" });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { S.flash.drive = { ok: false, text: errText(e) }; }
    S.drive.busy = ""; render();
  }
  function viewDrive() {
    if (!APP) return [pageHead("드라이브", "앱에서만 쓸 수 있습니다.")];
    const pid = APP.projects.some((p) => p.id === S.drive.proj) ? S.drive.proj : APP.currentProject;
    const pname = APP.projectName(pid);
    const pm = APP.isPM(pid);
    const q = (S.drive.q || "").trim().toLowerCase();
    const inProj = S.files.filter((f) => f["프로젝트"] === pname);
    const list = inProj.filter((f) => (S.drive.folder === "전체" || (f["폴더"] || "기타") === S.drive.folder) && (!q || `${f["이름"]} ${f["메모"]} ${f["올린이"]}`.toLowerCase().includes(q)));
    const tabs = APP.projects.length > 1 ? h("div", { class: "tabs", role: "tablist", "aria-label": "프로젝트" }, APP.projects.map((p) => h("button", { type: "button", role: "tab", "aria-selected": String(p.id === pid), text: p.name, onclick: () => { S.drive.proj = p.id; render(); } }))) : null;
    const folders = h("div", { class: "filters" }, ["전체", ...FOLDERS].map((fd) => h("button", { class: "chip", type: "button", "aria-pressed": String(S.drive.folder === fd), text: `${fd} ${fd === "전체" ? inProj.length : inProj.filter((f) => (f["폴더"] || "기타") === fd).length}`, onclick: () => { S.drive.folder = fd; render(); } })),
      h("input", { id: "dq", type: "search", class: "searchin", placeholder: "이름, 메모, 올린 사람 찾기", value: S.drive.q || "", oninput: (e) => { S.drive.q = e.target.value; clearTimeout(viewDrive.t); viewDrive.t = setTimeout(() => { render(); const el = $("dq"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 250); } }));
    const fileIn = h("input", { type: "file", multiple: true, hidden: true, onchange: (e) => upload([...(e.target.files || [])]) });
    const folderSel = () => h("select", { id: "dfolder", "aria-label": "올릴 폴더" }, FOLDERS.map((fd) => { const o = h("option", { value: fd, text: fd }); if (fd === (S.drive.folder !== "전체" ? S.drive.folder : "기타")) o.selected = true; return o; }));
    const upload = (files) => {
      if (!files.length) return;
      const folder = ($("dfolder") || {}).value || "기타";
      act("drive", async () => { for (const f of files) await putFile(pname, f, folder, ""); }, `${files.length}개를 ${folder} 폴더에 올렸습니다.`);
    };
    const drop = h("div", { class: "dropzone", tabindex: "0", role: "button", "aria-label": "파일 올리기",
      onclick: () => fileIn.click(), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileIn.click(); } },
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); }, ondragleave: (e) => e.currentTarget.classList.remove("over"),
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); upload([...(e.dataTransfer.files || [])]); } },
      h("strong", { text: "파일을 끌어다 놓거나 눌러서 고르기" }), h("span", { text: "파일 하나 50MB까지. 촬영 원본처럼 큰 영상은 오른쪽 '링크 등록'으로 넣으세요." }));
    const uploader = h("section", { class: "box" }, h("h2", {}, "올리기"),
      h("div", { class: "drive-up" },
        h("div", { style: "display:grid;gap:10px;min-width:0" }, h("label", { class: "field" }, "폴더", folderSel()), drop, fileIn),
        h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); const f = e.target, url = f.lurl.value.trim(), name = f.lname.value.trim();
            if (!/^https:\/\//.test(url)) { S.flash.drive = { ok: false, text: "링크는 https://로 시작해야 합니다." }; render(); return; }
            act("drive", () => S.db.collection("files").doc(`f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`).set({ "이름": name || url.replace(/^https:\/\//, "").slice(0, 60), "종류": "링크", "주소": url.slice(0, 1000), "폴더": ($("dfolder") || {}).value || "기타", "메모": f.lmemo.value.trim(), "올린이": myNameFor(pname), at: new Date().toISOString(), "프로젝트": pname }), "링크를 등록했습니다."); } },
          h("label", { class: "field wide" }, "링크 등록 (구글 드라이브, 유튜브 비공개, 위트랜스퍼 등)", h("input", { id: "lurl", name: "lurl", placeholder: "https://" })),
          h("label", { class: "field" }, "이름", h("input", { id: "lname", name: "lname", placeholder: "예: 1차 촬영 원본" })),
          h("label", { class: "field" }, "메모", h("input", { id: "lmemo", name: "lmemo", placeholder: "예: 11/14 촬영, 카메라 A" })),
          h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", disabled: S.busy, text: "링크 등록" })))),
      flashEl("drive"));
    const rows = list.length ? h("div", { class: "rows" }, list.map((f) => {
      const canDel = pm || f.from === S.me, ask = S.drive.del === f.url;
      if (S.drive.hl === f.url) setTimeout(() => { const el = document.querySelector(".file-row.hl"); if (el) el.scrollIntoView({ block: "center" }); S.drive.hl = null; }, 80);
      return h("div", { class: "row file-row" + (ask ? " confirm" : "") + (S.drive.hl === f.url ? " hl" : "") },
        h("span", { class: "ftype", text: fileIcon(f) }),
        h("div", {}, h("div", { class: "t", text: f["이름"] }),
          h("div", { class: "m" }, h("span", { class: "pill", text: f["폴더"] || "기타" }), h("span", { text: [f["올린이"] || nameOf(f.from), f.at ? `${String(f.at).slice(5, 10).replace("-", "/")} ${hm(f.at)}` : "", f["크기"] ? sizeText(f["크기"]) : ""].filter(Boolean).join(" · ") }), f["메모"] ? h("span", { text: f["메모"] }) : null),
          ask ? h("div", { class: "msg err", text: "지우면 되돌릴 수 없습니다." }) : null),
        h("div", { class: "actions" },
          ask ? [h("button", { class: "btn small danger", type: "button", text: "지우기", onclick: () => { S.drive.del = null; act("drive", async () => { if (f["경로"]) await APP.files.remove(f["경로"]).catch(() => {}); await S.db.collection("files").doc(f.url).delete(); }, "지웠습니다."); } }), h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.drive.del = null; render(); } })]
          : [h("button", { class: "btn small", type: "button", disabled: S.drive.busy === f.url, text: f["종류"] === "링크" ? "열기" : S.drive.busy === f.url ? "여는 중" : "열기", onclick: () => openFile(f, false) }),
             f["종류"] !== "링크" ? h("button", { class: "btn small", type: "button", disabled: S.drive.busy === f.url, text: "저장", onclick: () => openFile(f, true) }) : null,
             S.drive.share === f.url ? h("span", { class: "share-to" },
               h("select", { id: `shto-${f.url}`, "aria-label": "보낼 곳" }, channels().filter((ch) => ch.pid === pid || (ch.uid && APP.members.some((m) => m.user_id === ch.uid && m.project_id === pid))).map((ch) => h("option", { value: ch.id, text: ch.uid ? `${ch.name}님에게` : `${ch.name} 대화방` }))),
               h("button", { class: "btn small primary", type: "button", text: "보내기", onclick: () => { const id = $(`shto-${f.url}`).value, ch = channels().find((x) => x.id === id); S.drive.share = null; act("drive", () => sendMsg({ ...ch, pid: ch.uid ? pid : ch.pid }, `[드라이브] ${f["이름"]}`, f.url), `${ch.uid ? ch.name + "님에게" : "대화방에"} 파일 위치를 보냈습니다.`); } }),
               h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.drive.share = null; render(); } }))
             : h("button", { class: "btn small", type: "button", text: "메시지로 보내기", title: "대화방이나 팀원에게 이 파일 위치를 보냅니다. 받은 사람은 눌러서 바로 엽니다.", onclick: () => { S.drive.share = f.url; render(); } }),
             canDel ? h("button", { class: "btn small danger", type: "button", "aria-label": `${f["이름"]} 지우기`, text: "지우기", onclick: () => { S.drive.del = f.url; render(); } }) : null]));
    })) : h("div", { class: "empty", text: q ? "찾는 파일이 없습니다." : "이 폴더는 비어 있습니다." });
    return [pageHead("드라이브", `${pname} 팀 자료함입니다. 멤버만 열 수 있습니다. 지우기는 올린 사람과 PM만 합니다.`), tabs, uploader, h("section", { class: "box" }, h("h2", {}, "파일", h("span", { class: "n", text: `${list.length}개` })), folders, rows)];
  }

  // ---------- 주간 업데이트: 작성·제출 (할 일 화면), 모아 보기 (홈) ----------
  const weekId = (pid) => `w-${String(pid).replace(/-/g, "").slice(0, 12)}-${String(S.me).replace(/-/g, "").slice(0, 12)}-${ymd(mondayOf(new Date())).replace(/-/g, "")}`;
  const thisWeek = (w) => w["주"] === ymd(mondayOf(new Date()));
  function weeklyBox() {
    const pid = APP.projects.some((p) => p.id === (S.weekly && S.weekly.pid)) ? S.weekly.pid : APP.currentProject;
    const pname = APP.projectName(pid), m = APP.myMember(pid) || {};
    const mine = S.weeklies.find((w) => w.url === weekId(pid));
    const wk = S.weekly && S.weekly.pid === pid ? S.weekly : { pid, text: mine ? mine["내용"] : "" };
    const submit = () => {
      const text = ($("wktext") || {}).value || "";
      if (!text.trim()) { S.flash.weekly = { ok: false, text: "내용을 적어 주세요." }; render(); return; }
      const body = { "내용": text.slice(0, 8000), "제출": new Date().toISOString(), "주": ymd(mondayOf(new Date())), "이름": m.name || "", "역할": m.role || "", "프로젝트": pname };
      act("weekly", async () => {
        const ref = S.db.collection("weekly").doc(weekId(pid));
        if (mine) await ref.update(body); else await ref.set(body);
        S.weekly = null;
      }, mine ? "고쳐서 다시 제출했습니다. 홈에서 보입니다." : "제출했습니다. PM과 팀 홈에서 보입니다.");
    };
    return h("section", { class: "box", id: "weekly" },
      h("h2", {}, "주간 업데이트", mine ? h("span", { class: "pill ok", text: `제출함 ${String(mine["제출"]).slice(5, 10).replace("-", "/")} ${hm(mine["제출"])}` }) : h("span", { class: "pill", text: "이번 주 아직" }),
        mine && mine["PM 확인"] ? h("span", { class: "checked", text: `✓ ${mine["PM 확인"]} 확인` }) : null),
      h("p", { class: "sub", text: "내 할 일로 이번 주 초안을 만듭니다. 고친 뒤 제출하면 홈에서 팀과 PM이 봅니다." }),
      h("div", { class: "form" },
        APP.projects.length > 1 ? h("label", { class: "field" }, "프로젝트", h("select", { id: "wkproj", onchange: (e) => { S.weekly = { pid: APP.projectId(e.target.value), text: "" }; S.clearDrafts = true; render(); } }, projSel(pname))) : null,
        h("div", { class: "field" }, "나", h("div", { class: "quote", style: "padding:9px 12px", text: `${m.name || "-"} · ${m.role || "-"}` })),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", text: mine ? "초안 다시 만들기" : "초안 만들기", onclick: () => { S.weekly = { pid, text: weeklyDraft(m.role, m.name, pname) }; S.clearDrafts = true; render(); } }))),
      wk.text || mine ? h("label", { class: "field" }, "내용", h("textarea", { id: "wktext", value: wk.text, style: "min-height:220px", placeholder: "초안 만들기를 누르거나 직접 적으세요" })) : null,
      wk.text || mine ? h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", disabled: S.busy, text: mine ? "고쳐서 다시 제출" : "제출", onclick: submit }),
        mine && mine["PM 코멘트"] ? h("span", { class: "msg", text: `PM 코멘트: ${mine["PM 코멘트"]}` }) : null) : null,
      flashEl("weekly"));
  }
  function weeklyHome() {
    const mineP = APP.projects.map((p) => p.name);
    const list = S.weeklies.filter((w) => thisWeek(w) && mineP.includes(w["프로젝트"]));
    const pmAny = APP.projects.some((p) => APP.isPM(p.id));
    const missing = [];
    if (pmAny) APP.projects.filter((p) => APP.isPM(p.id)).forEach((p) => APP.members.filter((m) => m.project_id === p.id && m.user_id !== S.me).forEach((m) => { if (!list.some((w) => w.from === m.user_id && w["프로젝트"] === p.name)) missing.push(`${m.name}${APP.projects.length > 1 ? `(${p.name})` : ""}`); }));
    const iSent = list.some((w) => w.from === S.me);
    if (!list.length && !pmAny) return h("section", { class: "box" }, h("h2", {}, "이번 주 업데이트"), h("div", { class: "empty" }, "아직 아무도 내지 않았습니다.", h("button", { class: "btn small primary", type: "button", text: "내 업데이트 쓰기", onclick: () => { go("todo"); setTimeout(() => { const el = $("weekly"); if (el) el.scrollIntoView({ block: "start" }); }, 60); } })));
    return h("section", { class: "box" },
      h("h2", {}, "이번 주 업데이트", h("span", { class: "n", text: `${list.length}건` }),
        !iSent ? h("button", { class: "btn small primary", type: "button", style: "margin-left:auto", text: "내 업데이트 쓰기", onclick: () => { go("todo"); setTimeout(() => { const el = $("weekly"); if (el) el.scrollIntoView({ block: "start" }); }, 60); } }) : null),
      pmAny && missing.length ? h("p", { class: "sub", text: `아직 안 낸 사람: ${missing.join(", ")}` }) : null,
      list.length ? h("div", { class: "rows" }, list.map((w) => {
        const open = S.weekOpen === w.url, pm = isPMof(w["프로젝트"]) && w.from !== S.me;
        const after = w["PM 확인 시각"] && T(w["제출"]) > T(w["PM 확인 시각"]) + 1000;
        return h("div", { class: "weekly-item" },
          h("button", { class: "row", type: "button", "aria-expanded": String(open), onclick: () => { S.weekOpen = open ? null : w.url; render(); } },
            h("div", { class: "avatar small", "aria-hidden": "true", text: (w["이름"] || "?").slice(0, 1) }),
            h("div", {}, h("div", { class: "t", text: `${w["이름"] || nameOf(w.from)} · ${w["역할"] || ""}` }), h("div", { class: "m", text: `${w["프로젝트"]} · ${String(w["제출"]).slice(5, 10).replace("-", "/")} ${hm(w["제출"])} 제출` })),
            w["PM 확인"] ? h("span", { class: "pill ok", text: after ? "확인 후 고침" : "PM 확인" }) : h("span", { class: "pill", text: "확인 전" })),
          open ? h("div", { class: "weekly-body" }, h("div", { class: "quote", text: w["내용"] }),
            w["PM 코멘트"] ? h("div", { class: "msg", text: `PM 코멘트: ${w["PM 코멘트"]}` }) : null,
            pm ? h("form", { class: "quick-bar", onsubmit: (e) => { e.preventDefault(); const cm = e.target.wcm.value.trim(); act("wk", () => S.db.collection("weekly").doc(w.url).update({ "PM 확인": myNameFor(w["프로젝트"]) || "PM", "PM 확인 시각": new Date().toISOString(), ...(cm ? { "PM 코멘트": cm.slice(0, 500) } : {}) }), "확인했습니다. 본인에게 알림이 갑니다."); } },
              h("input", { name: "wcm", id: `wcm-${w.url}`, class: "quick-in", placeholder: "한 줄 코멘트 (선택)" }), h("button", { class: "btn primary", type: "submit", disabled: S.busy, text: w["PM 확인"] ? "다시 확인" : "확인" })) : null,
            h("button", { class: "btn small", type: "button", text: w.from === S.me ? "내 대화방 보기" : `${w["이름"] || "팀원"}님에게 메시지`, onclick: () => openChat(w.from === S.me ? `p:${pidOf(w["프로젝트"])}` : `d:${w.from}`, w.from === S.me ? "" : "주간 업데이트 봤어요. ") })) : null);
      })) : h("div", { class: "empty", text: "이번 주 제출이 아직 없습니다." }),
      flashEl("wk"));
  }

  // ---------- 들어온 업무 요청 (홈): PM이나 팀원이 나에게 보낸 제안 ----------
  const fromPerson = (r) => ["팀원 제안", "PM 제안"].includes(r["출처"]) && r["만든 사람"] !== S.me;
  function incomingBox() {
    const list = S.data.tasks.filter((r) => statusOf(r) === "제안" && isMine(r) && fromPerson(r)).sort((a, b) => levelRank(a) - levelRank(b) || (dday(a["마감"]) ?? 999) - (dday(b["마감"]) ?? 999));
    if (!list.length) return null;
    return h("section", { class: "box incoming" },
      h("h2", {}, "들어온 업무 요청", h("span", { class: "n", text: `${list.length}건` })),
      h("p", { class: "sub", text: "수락하면 내 할 일이 되고, 넘기면 이유와 함께 요청한 사람에게 알림이 갑니다." }),
      h("div", { class: "rows" }, list.map((r) => {
        const ask = S.decline === r.url;
        return h("div", { class: "row req" },
          h("span", { class: "lvl " + level(r), text: level(r) }),
          h("div", {}, h("button", { class: "t linklike", type: "button", text: r["할 일"], onclick: () => openTask(r.url) }),
            h("div", { class: "m" }, h("span", { text: `${r["제안한 사람"] || "PM"}님 요청` }), r["프로젝트"] ? h("span", { class: "pill", text: r["프로젝트"] }) : null, ddayEl(r["마감"]), r["마감"] ? h("span", { text: `${String(r["마감"]).slice(5).replace("-", "/")}까지` }) : null),
            r["근거 메시지"] && !/직접 제안했습니다/.test(r["근거 메시지"]) ? h("div", { class: "quote", style: "margin-top:6px;padding:8px 12px;font-size:13px", text: r["근거 메시지"] }) : null,
            ask ? h("form", { class: "quick-bar", style: "margin-top:8px", onsubmit: (e) => { e.preventDefault(); const v = e.target.dr.value.trim(); S.decline = null; act("incoming", () => updatePage(r, { "상태": "기각", "기각 사유": v || "사유 없음" }), "넘겼습니다. 요청한 사람에게 알림이 갑니다."); } },
              h("input", { name: "dr", id: `dr-${r.url}`, class: "quick-in", placeholder: "넘기는 이유 (예: 이번 주 촬영이 겹쳐요, 디자인 쪽 일 같아요)" }), h("button", { class: "btn", type: "submit", text: "넘기기" }), h("button", { class: "btn", type: "button", text: "취소", onclick: () => { S.decline = null; render(); } })) : null),
          ask ? h("span") : h("div", { class: "actions" },
            h("button", { class: "btn small primary", type: "button", disabled: S.busy, text: "수락", onclick: () => acceptTask(r) }),
            h("button", { class: "btn small", type: "button", text: "넘기기", onclick: () => { S.decline = r.url; render(); setTimeout(() => { const el = $(`dr-${r.url}`); if (el) el.focus(); }, 0); } }),
            APP ? h("button", { class: "btn small", type: "button", text: "묻기", title: "요청한 사람에게 1:1 메시지", onclick: () => openTask(r.url) }) : null));
      })),
      flashEl("incoming"));
  }

  // ---------- 목표 진행률 확인 (PM에게 하루 두 번: 오전 10시, 오후 5시) ----------
  const GOAL_SLOTS = [[10, "오전"], [17, "오후"]];
  const leafGoals = () => S.data.goals.filter((g) => !S.data.goals.some((c) => c["상위 목표"] === g["목표"]) && g["상태"] !== "완료" && isPMof(g["프로젝트"]));
  function goalSlot(now) {
    now = now || new Date();
    let slot = null;
    GOAL_SLOTS.forEach(([hh, l]) => { const t = new Date(now); t.setHours(hh, 0, 0, 0); if (now >= t) slot = { at: t, label: l }; });
    return slot;
  }
  const goalChecked = (g, since) => T(g["진행률 확인"] || g["수정"]) >= since.getTime();
  function goalNotif() {
    const slot = goalSlot(); if (!slot) return null;
    const open = leafGoals(); if (!open.length) return null;
    const left = open.filter((g) => !goalChecked(g, slot.at));
    if (!left.length) return null;
    return { id: `g-${ymd(slot.at)}-${slot.label}`, at: slot.at.getTime(), kind: "목표", text: `${slot.label} 목표 진행률을 확인할 시간입니다`, sub: `아직 확인 안 한 목표 ${left.length}개`, go: () => go("goals") };
  }
  function goalAskBox() {
    const slot = goalSlot(), open = leafGoals();
    if (!open.length) return null;
    const since = slot ? slot.at : new Date(new Date().setHours(0, 0, 0, 0));
    const left = open.filter((g) => !goalChecked(g, since));
    if (!left.length) return h("div", { class: "msg ok", text: `${slot ? slot.label + " " : ""}진행률 확인을 마쳤습니다. 다음 확인은 ${slot && slot.label === "오전" ? "오후 5시" : "내일 오전 10시"}에 알려 드립니다.` });
    return h("section", { class: "box ask" },
      h("h2", {}, slot ? `${slot.label} 진행률 확인` : "진행률 확인", h("span", { class: "n", text: `${left.length}개 남음` })),
      h("p", { class: "sub", text: "하루 두 번(오전 10시, 오후 5시) PM에게 묻습니다. 지금 진행률을 고르세요. 변화가 없으면 '그대로'." }),
      h("div", { class: "rows" }, left.map((g) => {
        const p = Math.round((Number(g["진행률"]) || 0) * 100);
        const set = (v, note) => act("goalask", () => updatePage(g, { "진행률": v / 100, "상태": v >= 100 ? "완료" : g["상태"] === "보류" ? "보류" : "진행 중", "진행률 확인": new Date().toISOString(), ...(note ? { "최근 업데이트": note } : {}) }), v === p ? "그대로로 확인했습니다." : `${v}%로 바꿨습니다.`);
        return h("div", { class: "row goal-ask" },
          h("span", { class: "pct", text: `${p}%` }),
          h("div", {}, h("div", { class: "t", text: g["목표"] }), h("div", { class: "m" }, g["프로젝트"] ? h("span", { class: "pill", text: g["프로젝트"] }) : null, ddayEl(g["마감"]), g["최근 업데이트"] ? h("span", { text: `최근: ${g["최근 업데이트"]}` }) : null)),
          h("div", { class: "actions" },
            h("button", { class: "btn small", type: "button", disabled: S.busy, text: "그대로", onclick: () => set(p) }),
            [10, 20].map((d) => h("button", { class: "btn small", type: "button", disabled: S.busy || p >= 100, text: `+${d}%`, onclick: () => set(Math.min(100, p + d)) })),
            h("button", { class: "btn small primary", type: "button", disabled: S.busy, text: "완료", onclick: () => set(100) })));
      })),
      flashEl("goalask"));
  }

  // ---------- 말로 할 일 올리기: 받아쓰기 → 나누기 → 우선순위 ----------
  const FILLER = /^(음+|어+|아+|그+|저기|일단|우선은|오늘은|오늘|그러니까|그리고|그 다음에?|그다음에?|또|또한|마지막으로|아 맞다|참|그리고 나서)[\s,]+/;
  const ENDS = [[/(보내야\s?(돼요?|해요?|겠다|지)|보내자|보낼게)$/, "보내기"], [/(봐야\s?(돼요?|해요?|겠다|지)|보자|볼게)$/, "보기"], [/(가야\s?(돼요?|해요?|겠다|지)|가자|갈게)$/, "가기"], [/(받아야\s?(돼요?|해요?|겠다|지)|받자|받을게)$/, "받기"], [/(써야\s?(돼요?|해요?|겠다|지)|쓰자|쓸게)$/, "쓰기"],
    [/(해야\s?(돼요?|되요?|해요?|한다|함|겠다|겠어|지)|할\s?(거야|거예요|예정|게|께)|하자|하고|해야지|하기로)$/, "하기"]];
  function splitSpoken(text) {
    return String(text || "")
      .replace(/(\S)하고\s+(?=\S)/g, "$1하기\n")
      .replace(/\s+(그리고 나서|그 다음에|그다음에|그 담에|그리고|또|또한|아 그리고|마지막으로|다음으로)\s+/g, "\n")
      .split(/[\n.!?。]|,\s*/)
      .map((x) => x.trim().replace(/^[-*•·]\s*/, ""))
      .map((x) => { let y = x; for (let i = 0; i < 3; i++) y = y.replace(FILLER, ""); return y.trim(); })
      .filter((x) => x.replace(/\s/g, "").length >= 3);
  }
  function spokenTitle(x) {
    let t = String(x).trim().replace(/[.!?~]+$/, "");
    for (const [re, end] of ENDS) { if (re.test(t)) { t = t.replace(re, end); break; } }
    t = t.replace(/((오전|오후|저녁|아침|밤)\s*)?\d{1,2}\s*시(\s*반|\s*\d{1,2}\s*분)?\s*(까지|에|전에|전까지)?\s*/g, "").replace(/(점심|저녁|오전|오후)\s*(전에|까지|중에?)\s*/g, "");
    t = titleOf(t);
    return t.replace(/(제일 먼저|가장 먼저|먼저|우선|최우선|꼭|반드시|급하게|빨리|당장)\s*/g, "").replace(/\s+/g, " ").trim() || x;
  }
  const BOOST = /(제일 먼저|가장 먼저|먼저|우선|최우선|꼭|반드시|중요|급해|급함|급하게|빨리|당장)/;
  function planSpoken(text, pname) {
    const now = new Date();
    const items = splitSpoken(text).map((raw, i) => {
      const j = judgeQuick({ text: raw }, now);
      let rank = ["지금", "오늘", "내일", "이번 주", "나중"].indexOf(j.bucket);
      if (BOOST.test(raw)) rank = Math.max(0, rank - 1);
      const lvl = ["긴급", "높음", "보통", "보통", "낮음"][rank];
      const proj = PROJECTS.find((p) => p !== "미분류" && (raw.includes(p) || p.split(/\s+/).some((w) => w.length >= 2 && raw.includes(w)))) || pname;
      return { raw, title: spokenTitle(raw), level: lvl, due: j.deadline && j.bucket !== "오늘" ? ymd(j.deadline) : (j.bucket === "지금" || j.bucket === "오늘" ? ymd(now) : ""), why: j.why + (BOOST.test(raw) ? " · '먼저/꼭'이라 올림" : ""), proj, role: roleOfText(raw), order: i, keep: true, kind: j.kind };
    });
    return items.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || (a.due || "9").localeCompare(b.due || "9") || a.order - b.order);
  }
  let rec = null;
  function voiceBox() {
    const V = S.voice || (S.voice = { text: "", items: null, on: false });
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const desktop = APP && ["win32", "darwin"].includes(APP.platform);
    const canSR = !!SR && !desktop;   // 데스크톱 앱에는 브라우저 음성 인식이 없어 운영체제 받아쓰기를 쓴다
    const hint = APP && APP.platform === "darwin" ? "받아쓰기: 칸을 누르고 키보드의 🎤(또는 Fn을 두 번) 누른 뒤 말하세요." : APP && APP.platform === "win32" ? "받아쓰기: 칸을 누르고 Windows 키 + H를 누른 뒤 말하세요." : "아이폰·아이패드: 칸을 누르고 키보드의 🎤를 눌러 말하세요.";
    const toggle = () => {
      if (!canSR) { const ta = $("voicein"); if (ta) ta.focus(); S.voiceHint = true; render(); setTimeout(() => { const t2 = $("voicein"); if (t2) t2.focus(); }, 0); return; }
      if (V.on && rec) { rec.stop(); return; }
      try {
        rec = new SR(); rec.lang = "ko-KR"; rec.continuous = true; rec.interimResults = true;
        let base = ($("voicein") || {}).value || V.text || "";
        rec.onresult = (e) => { let fin = "", tmp = ""; for (let i = e.resultIndex; i < e.results.length; i++) { (e.results[i].isFinal ? (fin += e.results[i][0].transcript) : (tmp += e.results[i][0].transcript)); } if (fin) base = (base ? base + "\n" : "") + fin.trim(); const ta = $("voicein"); if (ta) ta.value = base + (tmp ? (base ? "\n" : "") + tmp : ""); V.text = base; };
        rec.onerror = (e) => { V.on = false; S.flash.voice = { ok: false, text: e.error === "not-allowed" ? "마이크 사용을 허용해야 합니다." : "음성 인식이 멈췄습니다. 키보드의 🎤 받아쓰기를 써도 됩니다." }; render(); };
        rec.onend = () => { V.on = false; render(); };
        rec.start(); V.on = true; render();
      } catch (err) { S.voiceHint = true; render(); }
    };
    const pname = curProjName();
    return h("section", { class: "box voice" },
      h("h2", {}, "말로 할 일 올리기"),
      h("p", { class: "sub", text: "오늘 할 일을 생각나는 대로 말하면 하나씩 나눠 우선순위를 정하고, 확인 뒤 내 할 일에 올립니다. 예: \"오늘 3시까지 썸네일 시안 보내야 돼, 그리고 내일 장비 대여 신청하고 제일 먼저 교수님 메일 답장해야 해\"" }),
      h("div", { class: "quick-bar" },
        h("button", { class: "btn mic" + (V.on ? " live" : ""), type: "button", "aria-pressed": String(!!V.on), text: V.on ? "● 듣는 중 (눌러서 멈춤)" : "🎙 말하기", onclick: toggle }),
        h("textarea", { id: "voicein", class: "quick-in", rows: 2, value: V.text, placeholder: "여기에 받아쓰기 되거나 직접 적어도 됩니다", oninput: (e) => { V.text = e.target.value; } }),
        h("button", { class: "btn primary", type: "button", text: "정리하기", onclick: () => { const v = ($("voicein") || {}).value || ""; V.text = v; if (rec && V.on) rec.stop(); V.items = planSpoken(v, pname); S.clearDrafts = true; if (!V.items.length) S.flash.voice = { ok: false, text: "할 일을 찾지 못했습니다. 조금 더 길게 말해 주세요." }; render(); } })),
      S.voiceHint || !canSR ? h("div", { class: "msg", style: "color:var(--muted)", text: hint }) : null,
      V.items && V.items.length ? h("div", { class: "detail" },
        h("div", { class: "group-title" }, "우선순위 순서", h("span", { text: String(V.items.filter((x) => x.keep).length) })),
        h("div", { class: "rows" }, V.items.map((x, i) => h("div", { class: "row voice-item" + (x.keep ? "" : " off") },
          h("input", { type: "checkbox", checked: x.keep, "aria-label": `${x.title} 올리기`, onchange: (e) => { x.keep = e.target.checked; render(); } }),
          h("span", { class: "prio", text: String(V.items.filter((y, k) => y.keep && k <= i).length || "-") }),
          h("div", {},
            h("input", { class: "inline-edit", value: x.title, "aria-label": "할 일", oninput: (e) => { x.title = e.target.value; } }),
            h("div", { class: "m" }, h("span", { text: `“${x.raw}”` }), h("span", { text: x.why }))),
          h("div", { class: "actions" },
            h("select", { "aria-label": "긴급도", onchange: (e) => { x.level = e.target.value; V.items.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.order - b.order); render(); } }, LEVELS.map((l) => { const o = h("option", { value: l, text: l }); if (l === x.level) o.selected = true; return o; })),
            x.due ? h("span", { class: "pill", text: x.due.slice(5).replace("-", "/") }) : null)))),
        h("div", { class: "actions" },
          h("button", { class: "btn primary", type: "button", disabled: S.busy, text: `할 일에 ${V.items.filter((x) => x.keep).length}개 올리기`, onclick: () => {
            const mem = APP ? APP.myMember(pidOf(pname)) : null;
            const list = V.items.filter((x) => x.keep && x.title.trim()).map((x, i) => ({ "할 일": x.title.trim().slice(0, 200), "상태": "대기", "프로젝트": x.proj || pname, "담당 역할": mem ? mem.role : x.role, ...(mem ? { "담당자": mem.name } : {}), "긴급도": x.level, "우선순위": i + 1, ...(x.due ? { "마감": x.due } : {}), "출처": "음성 메모", "작성": "ODD HR 작성", "근거 메시지": `말한 내용: ${x.raw}` }));
            act("voice", async () => { await createPages("tasks", list); S.voice = null; }, `할 일 ${list.length}개를 우선순위대로 올렸습니다.`);
          } }),
          h("button", { class: "btn", type: "button", text: "다시 말하기", onclick: () => { S.voice = { text: "", items: null, on: false }; render(); } }))) : null,
      flashEl("voice"));
  }

  // ---------- 양식: 계약서 작성 도우미, 프로젝트 브리프 ----------
  const C_FIELDS = { 갑: "갑 (맡기는 쪽)", 을: "을 (하는 쪽)", 프로젝트: "프로젝트", 용도: "쓰는 곳 (용도)", 일시: "일시·기간", 장소: "장소", 금액: "금액", 결과물: "결과물·범위", 지급일: "지급일", 기간: "이용 기간" };
  const CONTRACTS = {
    "출연 계약서": { keys: ["출연", "배우", "모델", "성우", "내레이션", "인터뷰이", "엑스트라", "출연료"], fields: ["갑", "을", "프로젝트", "일시", "장소", "금액", "지급일", "용도"], clauses: [
      ["목적", "이 계약은 {갑}(이하 '갑')이 제작하는 「{프로젝트}」에 {을}(이하 '을')이 출연하는 데 필요한 사항을 정한다."],
      ["출연 내용", "을은 {일시}에 {장소}에서 갑이 정한 촬영·녹음에 출연한다. 촬영 순서와 시간은 갑이 미리 알린다."],
      ["출연료", "갑은 을에게 출연료 {금액}을 {지급일}까지 을이 지정한 계좌로 지급한다. 교통비·식비 등은 따로 정하지 않으면 출연료에 포함한다."],
      ["초상과 목소리 이용", "을은 이 영상물에 담긴 자신의 초상·목소리·이름을 갑이 {용도}에 쓰는 것을 허락한다. 이 범위를 넘는 이용은 을과 따로 협의한다."],
      ["권리", "완성된 영상물의 저작권은 갑에게 있다. 을은 영상물을 자신의 포트폴리오에 출처를 밝혀 쓸 수 있다."],
      ["일정 변경과 취소", "어느 한쪽 사정으로 일정이 바뀌면 3일 전까지 알린다. 갑의 사정으로 당일 취소되면 출연료의 50%를 지급한다."],
      ["비밀 유지", "을은 공개 전까지 촬영 내용과 대본을 외부에 알리지 않는다."],
      ["기타", "이 계약에 없는 사항은 서로 협의하여 정하고, 협의가 되지 않으면 관련 법과 일반 관행을 따른다."]] },
    "촬영 장소 사용 계약서": { keys: ["장소", "로케", "대여", "공간", "카페", "매장", "학교", "건물", "스튜디오", "사용료"], fields: ["갑", "을", "프로젝트", "장소", "일시", "금액", "지급일", "용도"], clauses: [
      ["목적", "이 계약은 {갑}(이하 '갑')이 {을}(이하 '을')이 관리하는 {장소}를 「{프로젝트}」 촬영에 쓰는 데 필요한 사항을 정한다."],
      ["사용 일시", "사용 일시는 {일시}로 한다. 준비와 정리 시간을 포함하며, 연장은 을의 동의를 받는다."],
      ["사용료", "갑은 사용료 {금액}을 {지급일}까지 지급한다. 사용료가 없는 경우 영상 크레딧에 협조 표기를 한다."],
      ["사용 범위", "갑은 미리 협의한 공간만 쓰고, 시설을 옮기거나 고칠 때에는 을의 허락을 받는다. 촬영 뒤에는 처음 상태로 되돌린다."],
      ["손해", "갑의 잘못으로 시설이 상하면 갑이 원상 복구하거나 그 비용을 물어 준다."],
      ["영상 이용", "을은 촬영된 장소의 모습이 영상물에 담겨 {용도}에 쓰이는 것을 허락한다. 상호·간판 노출은 미리 협의한다."],
      ["안전", "갑은 촬영 중 안전 수칙을 지키고, 을의 영업이나 이용자에게 불편이 없도록 한다."],
      ["기타", "이 계약에 없는 사항은 서로 협의하여 정한다."]] },
    "저작물 이용 허락서": { keys: ["음악", "BGM", "브금", "곡", "사진", "폰트", "일러스트", "저작권", "이용 허락", "라이선스", "영상 소스"], fields: ["갑", "을", "프로젝트", "결과물", "용도", "기간", "금액"], clauses: [
      ["목적", "{을}(이하 '권리자')은 자신이 권리를 가진 저작물 {결과물}을 {갑}(이하 '이용자')이 「{프로젝트}」에 쓰는 것을 아래와 같이 허락한다."],
      ["이용 범위", "이용자는 이 저작물을 {용도}에 쓸 수 있다. 편집·자르기·음량 조절 등 영상에 맞추는 변형을 허락한다."],
      ["이용 기간과 지역", "이용 기간은 {기간}으로 하고, 지역은 제한하지 않는다."],
      ["대가", "이용료는 {금액}으로 한다. 무상일 경우 영상에 '저작물명 / 권리자' 크레딧을 표기한다."],
      ["보증", "권리자는 이 저작물을 허락할 권리가 자신에게 있음을 보증한다. 제3자의 권리 주장이 생기면 권리자가 해결한다."],
      ["제한", "이용자는 이 저작물을 따로 판매하거나, 다른 사람에게 다시 이용 허락하지 않는다."],
      ["기타", "이 허락서에 없는 사항은 저작권법과 서로의 협의에 따른다."]] },
    "외주 용역 계약서": { keys: ["외주", "용역", "편집", "디자인", "썸네일", "모션", "자막", "제작 의뢰", "맡기", "프리랜서", "작업비"], fields: ["갑", "을", "프로젝트", "결과물", "기간", "금액", "지급일", "용도"], clauses: [
      ["목적", "이 계약은 {갑}(이하 '갑')이 {을}(이하 '을')에게 「{프로젝트}」의 {결과물} 제작을 맡기는 데 필요한 사항을 정한다."],
      ["작업 범위와 기한", "을은 {결과물}을 {기간}까지 갑에게 넘긴다. 작업 범위 밖의 추가 작업은 서로 협의하여 따로 정한다."],
      ["수정", "갑은 납품 뒤 2회까지 수정을 요청할 수 있다. 그 뒤의 수정이나 방향을 바꾸는 수정은 추가 비용을 협의한다."],
      ["대금", "갑은 작업비 {금액}을 {지급일}까지 지급한다. 착수금이 있으면 계약 때 정한다."],
      ["권리", "대금이 모두 지급되면 결과물의 저작재산권은 갑에게 넘어간다. 을은 결과물을 포트폴리오에 쓸 수 있다. 쓰는 곳: {용도}."],
      ["원본 파일", "을은 납품할 때 최종 파일과 함께 작업 원본(프로젝트 파일)을 넘긴다. 넘기지 않기로 하면 미리 적는다."],
      ["비밀 유지", "을은 작업 중 알게 된 갑의 자료와 정보를 외부에 알리지 않는다."],
      ["해지", "어느 한쪽이 계약을 지키지 않으면 7일 기한을 두고 고치기를 요청하고, 고쳐지지 않으면 계약을 해지할 수 있다. 해지 때까지 한 작업의 대가는 서로 협의하여 정산한다."]] },
    "장비 대여 계약서": { keys: ["장비", "카메라", "렌즈", "조명", "짐벌", "마이크", "삼각대", "대여료", "렌탈"], fields: ["갑", "을", "프로젝트", "결과물", "기간", "금액", "지급일"], clauses: [
      ["목적", "이 계약은 {을}(이하 '대여자')이 {갑}(이하 '사용자')에게 「{프로젝트}」 촬영용 장비를 빌려주는 데 필요한 사항을 정한다."],
      ["대여 장비", "대여 장비는 {결과물}로 하며, 넘겨줄 때 두 사람이 함께 상태를 확인하고 사진으로 남긴다."],
      ["대여 기간", "대여 기간은 {기간}으로 한다. 늦게 돌려주면 하루 단위로 대여료를 더 낸다."],
      ["대여료", "대여료는 {금액}으로 하고 {지급일}까지 지급한다."],
      ["관리 책임", "사용자는 장비를 주의해서 쓰고, 잃어버리거나 부서뜨리면 수리비나 같은 장비의 시세를 물어 준다. 자연스러운 마모는 예외로 한다."],
      ["기타", "이 계약에 없는 사항은 서로 협의하여 정한다."]] },
    "비밀유지 서약서": { keys: ["비밀", "보안", "NDA", "기밀", "유출", "공개 전"], fields: ["갑", "을", "프로젝트", "기간"], clauses: [
      ["목적", "{을}(이하 '서약자')은 {갑}의 「{프로젝트}」에 참여하며 알게 되는 정보를 아래와 같이 지킬 것을 서약한다."],
      ["비밀 정보", "기획안, 대본, 촬영 원본, 미공개 영상, 협력 기관 정보, 연락처 등 공개되지 않은 모든 자료를 비밀 정보로 본다."],
      ["지킬 것", "서약자는 비밀 정보를 이 프로젝트 밖에서 쓰지 않고, 허락 없이 다른 사람에게 알리거나 SNS에 올리지 않는다."],
      ["기간", "이 서약은 {기간} 동안, 정해지지 않았으면 영상 공개 뒤 1년까지 효력을 가진다."],
      ["돌려주기", "프로젝트가 끝나거나 요청을 받으면 가진 자료를 돌려주거나 지운다."]] },
    "초상권 이용 동의서": { keys: ["초상권", "얼굴", "촬영 동의", "인터뷰", "시민", "학생 출연", "등장"], fields: ["갑", "을", "프로젝트", "일시", "장소", "용도", "기간"], clauses: [
      ["동의 내용", "본인 {을}은 {일시} {장소}에서 촬영된 영상·사진에 담긴 본인의 얼굴, 목소리, 이름이 {갑}의 「{프로젝트}」에 쓰이는 것에 동의한다."],
      ["이용 범위", "이용 범위는 {용도}로 하며, 이 범위를 넘으면 다시 동의를 받는다."],
      ["이용 기간", "이용 기간은 {기간}으로 한다."],
      ["철회", "본인은 공개 전까지 동의를 철회할 수 있으며, 공개 뒤에는 이미 배포된 것을 뺀 앞으로의 이용 중단을 요청할 수 있다."],
      ["만 14세 미만", "본인이 만 14세 미만이면 법정대리인이 함께 서명한다."]] }
  };
  function pickContract(q) {
    let best = "외주 용역 계약서", score = 0;
    for (const [k, c] of Object.entries(CONTRACTS)) { const n = c.keys.filter((w) => q.includes(w)).length + (q.includes(k.replace(/ (계약서|허락서|서약서|동의서)$/, "")) ? 3 : 0); if (n > score) { best = k; score = n; } }
    return { kind: best, sure: score > 0 };
  }
  function fillFromAsk(q, kind, pname) {
    const f = {};
    const money = q.match(/(\d[\d,]*)\s*(만\s*원|만원|천\s*원|원)/);
    if (money) { const n = Number(money[1].replace(/,/g, "")); f["금액"] = /만/.test(money[2]) ? `금 ${(n * 10000).toLocaleString("ko-KR")}원 (${n}만 원)` : `금 ${n.toLocaleString("ko-KR")}원`; }
    if (/무상|무료|재능 ?기부|사례 없음/.test(q)) f["금액"] = "무상 (크레딧 표기)";
    const d = dueOf(q, ymd(new Date())); if (d) { f["일시"] = prettyDate(d); f["지급일"] = `${prettyDate(d)} 이후 7일 이내`; }
    const tm = timeOf(q); if (tm && f["일시"]) f["일시"] += ` ${pad2(tm[0])}:${pad2(tm[1])}`;
    const place = q.match(/([가-힣A-Za-z0-9 ]{2,20}?)(?:에서|장소|에 있는)/); if (place && !/(계약|필요|작성)/.test(place[1])) f["장소"] = place[1].trim();
    const per = q.match(/([가-힣]{2,4})\s?(?:님|씨|배우|성우|작가|감독|디자이너|편집자)/); if (per) f["을"] = per[0].replace(/님$/, "").trim();
    const use = q.match(/(유튜브|인스타|SNS|공모전|학교 ?홍보|홍보 ?영상|졸업 ?작품|과제|상영회|웹사이트|방송)[^,.\n]{0,12}/); if (use) f["용도"] = `${use[0].trim()} 게시와 홍보`;
    const per2 = q.match(/(\d+)\s?(개월|년|주)/); if (per2) f["기간"] = `계약일부터 ${per2[1]}${per2[2]}`;
    const thing = q.match(/([가-힣A-Za-z0-9 ]{2,30}?)\s?(을|를)\s?(맡기|의뢰|빌리|대여|쓰|사용)/); if (thing) f["결과물"] = thing[1].trim();
    f["갑"] = f["갑"] || `${pname} 팀 (대표: ${myNameFor(pname) || "PM"})`;
    f["프로젝트"] = pname;
    return f;
  }
  const DEFAULTS = { 일시: "____년 __월 __일 __시", 장소: "________", 금액: "금 ________원", 지급일: "작업(촬영) 완료 후 7일 이내", 용도: "학교 과제·공모전 출품, 팀과 학과의 SNS·유튜브 게시", 결과물: "________", 기간: "계약일부터 영상 공개 후 2년", 을: "________" };
  function contractText(kind, f) {
    const c = CONTRACTS[kind], v = (k) => (f[k] && String(f[k]).trim()) || DEFAULTS[k] || "________";
    const free = /^무상/.test(v("금액"));
    const body = c.clauses.map(([t, x], i) => `제${i + 1}조 (${t})\n${(free && x.includes("{금액}") ? `${t}${jong(t.slice(-1)) > 0 ? "은" : "는"} 받지 않는다(무상). 대신 영상 크레딧에 {을}의 이름을 협조로 표기한다.` : x).replace(/\{(\S+?)\}/g, (_, k) => v(k))}`).join("\n\n");
    return `${kind}\n\n${body}\n\n이 계약을 증명하기 위해 두 부를 만들어 서명한 뒤 한 부씩 나눠 갖는다.\n\n${ymd(new Date()).replace(/-/g, ". ")}.\n\n갑: ${v("갑")}            (서명)\n을: ${v("을")}            (서명)\n\n※ ODD HR 양식으로 만든 초안입니다. 법률 자문이 아니므로 금액이 크거나 권리가 중요한 계약은 학과·전문가의 확인을 받으세요.`;
  }
  const BRIEF_FIELDS = [["한 줄 소개", "이 영상을 한 문장으로"], ["배경", "왜 만드는지, 누가 요청했는지"], ["목적", "보고 나서 무엇이 바뀌어야 하는지"], ["타깃", "누가 보는지 (나이, 상황, 보는 곳)"], ["핵심 메시지", "꼭 남길 한 마디"], ["결과물", "형식, 길이, 화면비, 납품 파일"], ["톤앤매너", "분위기, 색, 음악 느낌"], ["레퍼런스", "참고 영상 링크"], ["예산", "총액과 쓰임"], ["제약과 주의", "꼭 지킬 것, 피할 것, 심의·저작권"]];
  function briefAuto(pname) {
    const p = APP ? APP.projects.find((x) => x.name === pname) : null;
    const team = membersOf(pname).map((m) => `${m.name} (${m.role}${m.stage ? ` · ${m.stage}` : ""})`);
    const goals = S.data.goals.filter((g) => g["프로젝트"] === pname);
    const tasks = S.data.tasks.filter((r) => r["프로젝트"] === pname);
    const meets = S.data.meetings.filter((m) => m["프로젝트"] === pname);
    const decisions = meets.flatMap((m) => String(m["결정 사항"] || "").split("\n").filter(Boolean).map((d) => `${d} (${m["제목"]})`)).slice(0, 8);
    const upcoming = meets.filter((m) => m["일시"] && dday(m["일시"]) >= 0).sort((a, b) => String(a["일시"]).localeCompare(String(b["일시"]))).slice(0, 5).map((m) => `${whenText(m["일시"])} ${m["제목"]}`);
    const ms = goals.filter((g) => g["마감"]).sort((a, b) => String(a["마감"]).localeCompare(String(b["마감"]))).map((g) => `${String(g["마감"]).slice(5).replace("-", "/")} ${g["목표"]} (${Math.round((Number(g["진행률"]) || 0) * 100)}%)`);
    return { 마감: p && p.deadline ? `${p.deadline_label || "마감"} ${p.deadline} (${ddayText(dday(p.deadline))})` : "정하지 않음", 팀: team, 일정: [...ms, ...upcoming], 결정: decisions,
      진행: `열린 일 ${tasks.filter((r) => !["완료", "기각"].includes(statusOf(r))).length}건 · 끝난 일 ${tasks.filter((r) => statusOf(r) === "완료").length}건 · 막힘 ${tasks.filter((r) => statusOf(r) === "막힘").length}건` };
  }
  function briefText(pname, b) {
    const a = briefAuto(pname), list = (x) => x.length ? x.map((y) => `- ${y}`).join("\n") : "- (없음)";
    return [`프로젝트 브리프: ${pname}`, `작성 ${ymd(new Date())} · ODD HR`, "", ...BRIEF_FIELDS.flatMap(([k]) => [`■ ${k}`, (b[k] || "").trim() || "(적지 않음)", ""]), "■ 마감", a.마감, "", "■ 팀", list(a.팀), "", "■ 일정과 마일스톤", list(a.일정), "", "■ 지금까지 정한 것", list(a.결정), "", "■ 진행 상황", a.진행].join("\n");
  }
  async function saveForm(id, body) {
    const ref = S.db.collection("forms").doc(id);
    if ((await ref.get()).exists) await ref.update(body); else await ref.set(body);
  }
  function printDoc(title, text) {
    const w = document.createElement("div"); w.className = "print-doc"; w.setAttribute("aria-hidden", "true");
    w.appendChild(h("h1", { text: title })); String(text).split("\n").forEach((l) => w.appendChild(l.trim() ? h(/^(■|제\d+조)/.test(l) ? "h3" : "p", { text: l.replace(/^■ /, "") }) : h("br")));
    document.body.appendChild(w); document.body.classList.add("printing");
    const done = () => { document.body.classList.remove("printing"); w.remove(); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done); setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
  }
  function viewForms() {
    const tab = S.formTab || "contract";
    const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "양식" }, [["contract", "계약서"], ["brief", "프로젝트 브리프"]].map(([k, l]) => h("button", { type: "button", role: "tab", "aria-selected": String(tab === k), text: l, onclick: () => { S.formTab = k; render(); } })));
    const pname = PROJECTS.includes(S.formProj) ? S.formProj : curProjName();
    const projPick = APP && APP.projects.length > 1 ? h("label", { class: "field" }, "프로젝트", h("select", { onchange: (e) => { S.formProj = e.target.value; S.contract = null; render(); } }, projSel(pname))) : null;
    const saved = (S.forms || []).filter((x) => x["프로젝트"] === pname);
    if (tab === "brief") {
      const id = `brief-${String(pidOf(pname) || "x").replace(/-/g, "").slice(0, 20)}`;
      const doc = saved.find((x) => x.url === id) || {};
      const B = S.brief && S.brief.id === id ? S.brief : (S.brief = { id, v: { ...(doc["항목"] || {}) } });
      const auto = briefAuto(pname);
      const out = briefText(pname, B.v);
      return [pageHead("양식", "계약서 초안과 프로젝트 브리프를 만듭니다. 만든 것은 드라이브에 저장하거나 PDF로 뽑을 수 있습니다."), tabs,
        h("div", { class: "split" },
          h("section", { class: "box" }, h("h2", {}, "브리프 쓰기"), projPick,
            h("p", { class: "sub", text: "적은 칸과 ODD HR이 가진 자료(마감, 팀, 목표, 미팅 결정)를 합쳐 한 장짜리 문서로 정리합니다." }),
            h("div", { class: "form" }, BRIEF_FIELDS.map(([k, ph]) => h("label", { class: "field wide" }, k, h("textarea", { id: `bf-${k.replace(/\s/g, "")}`, rows: k === "한 줄 소개" ? 1 : 2, class: "auto", value: B.v[k] || "", placeholder: ph, oninput: (e) => { B.v[k] = e.target.value; const pv = $("briefpv"); if (pv) pv.textContent = briefText(pname, B.v); } })))),
            h("div", { class: "actions" },
              APP ? h("button", { class: "btn primary", type: "button", disabled: S.busy, text: "저장", onclick: () => act("form", () => saveForm(id, { "종류": "브리프", "제목": `${pname} 브리프`, "항목": B.v, "작성자": myNameFor(pname), at: new Date().toISOString(), "프로젝트": pname }), "브리프를 저장했습니다. 팀 모두가 이 화면에서 봅니다.") }) : null,
              doc.at ? h("span", { class: "msg", style: "color:var(--muted)", text: `마지막 저장 ${doc["작성자"] || ""} ${String(doc.at).slice(5, 16).replace("T", " ")}` }) : null),
            flashEl("form")),
          h("section", { class: "box paper-box" },
            h("div", { class: "actions" }, h("h2", { style: "margin:0" }, "문서 미리 보기"), h("span", { style: "margin-left:auto" }),
              h("button", { class: "btn small", type: "button", text: "복사", onclick: async (e) => { try { await navigator.clipboard.writeText(briefText(pname, B.v)); e.target.textContent = "복사했습니다"; } catch (x) { e.target.textContent = "복사하지 못했습니다"; } } }),
              h("button", { class: "btn small", type: "button", text: "PDF·인쇄", onclick: () => printDoc(`프로젝트 브리프: ${pname}`, briefText(pname, B.v).split("\n").slice(2).join("\n")) }),
              APP ? h("button", { class: "btn small", type: "button", disabled: S.busy, text: "드라이브에 저장", onclick: () => act("form", () => saveTextToDrive(pname, `브리프 ${pname} ${ymd(new Date())}.txt`, briefText(pname, B.v), "기획"), "드라이브 기획 폴더에 저장했습니다.") }) : null),
            h("div", { class: "paper" },
              h("div", { class: "paper-title", text: `프로젝트 브리프` }), h("div", { class: "paper-sub", text: `${pname} · ${auto.마감}` }),
              h("pre", { id: "briefpv", class: "paper-body", text: out.split("\n").slice(3).join("\n") }))))];
    }
    // 계약서
    const K = S.contract || (S.contract = { ask: "", kind: "출연 계약서", f: { ...fillFromAsk("", "출연 계약서", pname) }, sure: true });
    const make = () => { const q = ($("cask") || {}).value || ""; if (!q.trim()) { S.flash.form = { ok: false, text: "어떤 계약서가 필요한지 한 문장으로 적어 주세요." }; render(); return; } const p = pickContract(q); S.contract = { ask: q, kind: p.kind, sure: p.sure, f: { ...fillFromAsk(q, p.kind, pname) } }; S.clearDrafts = true; S.flash.form = { ok: true, text: p.sure ? `'${p.kind}' 양식으로 초안을 만들었습니다. 빈칸을 채우고 확인하세요.` : `딱 맞는 양식을 못 찾아 '${p.kind}'으로 만들었습니다. 위에서 양식을 바꿀 수 있습니다.` }; render(); };
    const c = CONTRACTS[K.kind];
    const text = contractText(K.kind, K.f);
    return [pageHead("양식", "계약서 초안과 프로젝트 브리프를 만듭니다. 만든 것은 드라이브에 저장하거나 PDF로 뽑을 수 있습니다."), tabs,
      h("section", { class: "box aibar" },
        h("h2", {}, "어떤 계약서가 필요한가요?", h("span", { class: "pill ai", text: "작성 도우미" })),
        h("div", { class: "quick-bar" },
          h("textarea", { id: "cask", class: "quick-in", rows: 1, value: K.ask, placeholder: "예: 공모전 영상에 성우 김하나님 내레이션 출연, 출연료 30만 원, 11월 20일 녹음 · 카페에서 촬영 장소 빌리는 계약 · 편집 외주 2주, 80만 원",
            onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); make(); } } }),
          h("button", { class: "btn primary", type: "button", text: "초안 만들기", onclick: make })),
        h("p", { class: "sub", style: "margin:0", text: "문장에서 계약 종류, 사람, 금액, 날짜, 장소, 쓰는 곳을 읽어 기본 양식에 넣습니다. 이 기기 안에서 계산하며 추가 비용이 없습니다." }),
        flashEl("form")),
      h("div", { class: "split" },
        h("section", { class: "box" }, h("h2", {}, "빈칸 채우기"), projPick,
          h("label", { class: "field" }, "양식", h("select", { id: "ckind", onchange: (e) => { K.kind = e.target.value; render(); } }, Object.keys(CONTRACTS).map((k) => { const o = h("option", { value: k, text: k }); if (k === K.kind) o.selected = true; return o; }))),
          h("div", { class: "form" }, c.fields.map((k) => h("label", { class: "field" + (["갑", "결과물", "용도"].includes(k) ? " wide" : "") }, C_FIELDS[k], h("input", { id: `cf-${k}`, value: K.f[k] || "", placeholder: DEFAULTS[k] || "", oninput: (e) => { K.f[k] = e.target.value; const pv = $("contractpv"); if (pv) pv.textContent = contractText(K.kind, K.f); } })))),
          h("div", { class: "notice", text: "법률 자문이 아닌 초안입니다. 금액이 크거나 저작권·초상권이 걸린 계약은 학과 사무실이나 전문가에게 확인받으세요." }),
          h("div", { class: "actions" },
            APP ? h("button", { class: "btn primary", type: "button", disabled: S.busy, text: "초안 저장", onclick: () => act("form", () => saveForm(`ct${Date.now().toString(36)}`, { "종류": "계약서", "양식": K.kind, "제목": `${K.kind} ${K.f["을"] && K.f["을"] !== "________" ? `(${K.f["을"]})` : ""}`.trim(), "항목": K.f, "요청": K.ask, "작성자": myNameFor(pname), at: new Date().toISOString(), "프로젝트": pname }), "계약서 초안을 저장했습니다.") }) : null)),
        h("section", { class: "box paper-box" },
          h("div", { class: "actions" }, h("h2", { style: "margin:0" }, "미리 보기"), h("span", { style: "margin-left:auto" }),
            h("button", { class: "btn small", type: "button", text: "복사", onclick: async (e) => { try { await navigator.clipboard.writeText(contractText(K.kind, K.f)); e.target.textContent = "복사했습니다"; } catch (x) { e.target.textContent = "복사하지 못했습니다"; } } }),
            h("button", { class: "btn small", type: "button", text: "PDF·인쇄", onclick: () => printDoc(K.kind, contractText(K.kind, K.f).split("\n").slice(2).join("\n")) }),
            APP ? h("button", { class: "btn small", type: "button", disabled: S.busy, text: "드라이브에 저장", onclick: () => act("form", () => saveTextToDrive(pname, `${K.kind} ${K.f["을"] || ""} ${ymd(new Date())}.txt`, contractText(K.kind, K.f), "기타"), "드라이브에 저장했습니다.") }) : null),
          h("div", { class: "paper" }, h("div", { class: "paper-title", text: K.kind }), h("pre", { id: "contractpv", class: "paper-body", text: text.split("\n").slice(2).join("\n") })))),
      saved.filter((x) => x["종류"] === "계약서").length ? h("section", { class: "box" }, h("h2", {}, "저장한 계약서 초안", h("span", { class: "n", text: `${saved.filter((x) => x["종류"] === "계약서").length}건` })),
        h("div", { class: "rows" }, saved.filter((x) => x["종류"] === "계약서").sort((a, b) => T(b.at) - T(a.at)).map((x) => h("div", { class: "row" },
          h("span", { class: "pill", text: x["양식"] }), h("div", {}, h("div", { class: "t", text: x["제목"] }), h("div", { class: "m", text: `${x["작성자"] || ""} · ${String(x.at || "").slice(5, 16).replace("T", " ")}${x["요청"] ? ` · “${x["요청"].slice(0, 40)}”` : ""}` })),
          h("div", { class: "actions" }, h("button", { class: "btn small", type: "button", text: "열기", onclick: () => { S.contract = { ask: x["요청"] || "", kind: x["양식"], sure: true, f: { ...(x["항목"] || {}) } }; S.clearDrafts = true; render(); window.scrollTo(0, 0); } }),
            x.from === S.me || isPMof(x["프로젝트"]) ? h("button", { class: "btn small danger", type: "button", text: "지우기", onclick: () => act("form", () => S.db.collection("forms").doc(x.url).delete(), "지웠습니다.") }) : null))))) : null];
  }

  // ---------- Gmail (읽기 전용): 구글 로그인으로 연결 ----------
  const GM = { list: null, err: "", q: "newer_than:7d -category:promotions -category:social", busy: false };
  async function gmailFetch(path) {
    const t = APP.gmailToken(); if (!t) throw { code: "local", message: "Gmail 연결이 끝났습니다. 다시 연결하세요." };
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${t}` } });
    if (r.status === 401) { APP.gmailForget(); throw { code: "local", message: "Gmail 연결 시간이 지났습니다. 다시 연결하세요." }; }
    if (!r.ok) throw { code: "local", message: `Gmail이 응답하지 않습니다 (${r.status}).` };
    return r.json();
  }
  async function gmailLoad() {
    GM.busy = true; GM.err = ""; paint();
    try {
      const l = await gmailFetch(`messages?maxResults=20&q=${encodeURIComponent(GM.q)}`);
      const ids = (l.messages || []).slice(0, 20);
      GM.list = await Promise.all(ids.map(async (m) => {
        const d = await gmailFetch(`messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const hd = (n) => ((d.payload && d.payload.headers) || []).find((x) => x.name === n)?.value || "";
        const txt = `${hd("Subject")} ${d.snippet || ""}`;
        return { id: m.id, thread: d.threadId, from: hd("From").replace(/<.*?>/, "").replace(/"/g, "").trim(), subject: hd("Subject") || "(제목 없음)", snippet: (d.snippet || "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"), at: Number(d.internalDate) || 0, todo: ACTION.test(txt) || /(요청|마감|회신|부탁|제출|확인 부탁|검토)/.test(txt) };
      }));
    } catch (e) { GM.err = errText(e); }
    GM.busy = false; paint();
  }
  function gmailPanel() {
    if (!APP) return null;
    const on = !!APP.gmailToken();
    if (!on) return h("section", { class: "box" }, h("h2", {}, "Gmail"),
      h("p", { class: "sub", text: "구글 계정으로 로그인하면 받은 메일을 여기서 보고, 할 일이 될 메일을 바로 제안으로 올릴 수 있습니다. 읽기만 하며 메일을 보내거나 지우지 않습니다. 연결은 이 기기에서 1시간쯤 유지되고, 지나면 다시 누르면 됩니다." }),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", disabled: S.busy, text: "Google로 Gmail 연결", onclick: () => act("gmail", async () => { await APP.gmailConnect(); await gmailLoad(); }, "Gmail을 연결했습니다.") })),
      flashEl("gmail"));
    if (GM.list === null && !GM.busy && !GM.err) setTimeout(gmailLoad, 0);
    return h("section", { class: "box" },
      h("h2", {}, "Gmail", h("span", { class: "n", text: APP.gmailEmail() || "" }), h("span", { class: "toolbar", style: "margin-left:auto" }, h("button", { class: "btn small", type: "button", disabled: GM.busy, text: GM.busy ? "불러오는 중" : "새로고침", onclick: gmailLoad }), h("button", { class: "btn small", type: "button", text: "연결 끊기", onclick: () => { APP.gmailForget(); GM.list = null; render(); } }))),
      h("form", { class: "quick-bar", onsubmit: (e) => { e.preventDefault(); GM.q = e.target.gq.value.trim() || GM.q; gmailLoad(); } },
        h("input", { name: "gq", id: "gq", class: "quick-in", value: GM.q, "aria-label": "Gmail 검색", placeholder: "Gmail 검색 (예: from:교수님 newer_than:3d)" }), h("button", { class: "btn", type: "submit", text: "찾기" })),
      GM.err ? h("div", { class: "msg err", text: GM.err }) : null,
      GM.list && GM.list.length ? h("div", { class: "rows" }, GM.list.map((m) => h("div", { class: "row mail-row" },
        h("span", { class: "pill" + (m.todo ? " info" : ""), text: m.todo ? "할 일 같음" : "메일" }),
        h("div", {}, h("div", { class: "t", text: m.subject }), h("div", { class: "m" }, h("span", { text: m.from }), h("span", { text: new Date(m.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) })), h("div", { class: "m", style: "margin-top:2px", text: m.snippet.slice(0, 140) })),
        h("div", { class: "actions" },
          h("button", { class: "btn small primary", type: "button", text: "할 일로", onclick: () => openQuick({ kind: "할 일", title: titleOf(m.subject.replace(/^(re|fw|fwd)\s*:\s*/i, "")), quote: `[Gmail] ${m.from}: ${m.subject} · ${m.snippet.slice(0, 200)}` }) }),
          h("a", { class: "btn small", href: `https://mail.google.com/mail/u/0/#all/${m.thread}`, target: "_blank", rel: "noopener", text: "Gmail에서 열기" }))))) : GM.list ? h("div", { class: "empty", text: "조건에 맞는 메일이 없습니다." }) : null);
  }

  // ---------- 메시지에 드라이브 파일 붙이기 ----------
  function filePicker(c, inDrawer) {
    const done = () => { if (inDrawer && S.drawer) S.drawer.pick = false; else S.chat.pick = false; };
    const rerender = () => (inDrawer ? renderDrawer() : render());
    const pname = APP.projectName(c.pid);
    const q = (S.chat.pq || "").toLowerCase();
    const list = S.files.filter((f) => f["프로젝트"] === pname && (!q || `${f["이름"]} ${f["폴더"]} ${f["메모"]}`.toLowerCase().includes(q))).slice(0, 30);
    const fin = h("input", { type: "file", hidden: true, onchange: (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; act("chat", async () => { const id = await putFile(pname, f, "기타", "메시지로 보냄"); await sendMsg(c, `[드라이브] ${f.name}`, id); done(); }, "올리고 보냈습니다."); } });
    return h("div", { class: "file-pick" },
      h("div", { class: "quick-bar" }, h("input", { id: "pq", type: "search", class: "searchin", placeholder: `${pname} 드라이브에서 찾기`, value: S.chat.pq || "", oninput: (e) => { S.chat.pq = e.target.value; clearTimeout(filePicker.t); filePicker.t = setTimeout(() => { rerender(); const el = $("pq"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 200); } }),
        h("button", { class: "btn small", type: "button", text: "새 파일 올려 보내기", onclick: () => fin.click() }), fin,
        h("button", { class: "btn small", type: "button", text: "닫기", onclick: () => { done(); rerender(); } })),
      list.length ? h("div", { class: "rows" }, list.map((f) => h("button", { class: "row", type: "button", onclick: () => run(async () => { await sendMsg(c, `[드라이브] ${f["이름"]}`, f.url); done(); }, "파일 위치를 보냈습니다.") },
        h("span", { class: "ftype", text: fileIcon(f) }), h("div", {}, h("div", { class: "t", text: f["이름"] }), h("div", { class: "m", text: `${f["폴더"] || "기타"} 폴더 · ${f["올린이"] || ""}` })), h("span", { class: "pill", text: "보내기" })))) : h("div", { class: "msg", style: "color:var(--muted)", text: "드라이브에 파일이 없습니다. '새 파일 올려 보내기'를 누르세요." }));
  }
  function fileChip(m) {
    const f = S.files.find((x) => x.url === m.file);
    if (!f) return h("div", { class: "fchip gone", text: "드라이브에서 지워진 파일입니다" });
    return h("div", { class: "fchip" },
      h("span", { class: "ftype", text: fileIcon(f) }),
      h("div", { style: "min-width:0" }, h("div", { class: "fn", text: f["이름"] }), h("div", { class: "fm", text: `드라이브 › ${f["프로젝트"]} › ${f["폴더"] || "기타"}${f["크기"] ? ` · ${sizeText(f["크기"])}` : ""}` })),
      h("div", { class: "factions" },
        h("button", { class: "linkish", type: "button", text: "열기", onclick: () => openFile(f, false) }),
        f["종류"] !== "링크" ? h("button", { class: "linkish", type: "button", text: "저장", onclick: () => openFile(f, true) }) : null,
        h("button", { class: "linkish", type: "button", text: "위치 보기", onclick: () => { S.drive.proj = pidOf(f["프로젝트"]); S.drive.folder = f["폴더"] || "기타"; S.drive.hl = f.url; go("drive"); } })));
  }

  // ======================================================================
  // 흐름을 끊지 않는 UX: 옆 패널, 어디서나 만들기, 찾기(⌘K), 되돌리기, 새 기능
  // ======================================================================
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  const layer = (id) => { let el = $(id); if (!el) { el = h("div", { id }); document.body.appendChild(el); } return el; };
  const inLayer = () => { const a = document.activeElement; return !!(a && a.closest && a.closest("#drawer, #qa, #pal, #wn")); };

  // ---------- 알림 토스트 (되돌리기) ----------
  let toastTimer = null;
  function toast(text, undo, err) {
    const el = layer("toast");
    el.textContent = ""; el.className = "show" + (err ? " err" : "");
    el.setAttribute("role", "status");
    el.appendChild(h("span", { text }));
    if (undo) el.appendChild(h("button", { class: "linkish", type: "button", text: "되돌리기", onclick: async () => { el.className = ""; try { await undo(); toast("되돌렸습니다."); paint(); } catch (e) { toast(errText(e), null, true); } } }));
    el.appendChild(h("button", { class: "x", type: "button", "aria-label": "닫기", text: "×", onclick: () => { el.className = ""; } }));
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ""; }, undo ? 6000 : 3500);
  }
  async function run(fn, okText, undo) {
    S.busy = true;
    try { await fn(); if (okText) toast(okText, undo); S.clearDrafts = true; }
    catch (e) { toast(errText(e), null, true); }
    finally { S.busy = false; render(); }
  }
  // 상태 바꾸기는 어디서 하든 같은 길 (되돌리기 포함)
  function setStatus(r, next, extra, okText) {
    const prev = statusOf(r), prevExtra = {};
    Object.keys(extra || {}).forEach((k) => { prevExtra[k] = r[k] === undefined ? "" : r[k]; });
    const props = { "상태": next, ...(next === "완료" ? { "완료 처리": "PM", "완료일": new Date().toISOString() } : {}), ...(extra || {}) };
    const canUndo = prev !== "완료" || isPMof(r["프로젝트"]);
    return run(() => updatePage(r, props), okText || `'${r["할 일"]}' ${next}`, canUndo ? () => updatePage(r, { "상태": prev, ...prevExtra }) : null);
  }
  const acceptTask = (r) => { const mem = APP ? APP.myMember(pidOf(r["프로젝트"])) : null; return setStatus(r, "진행", mem && !r["담당자"] ? { "담당자": mem.name } : {}, "수락했습니다. 내 할 일에 들어갔습니다."); };

  // ---------- 옆 패널 ----------
  function openTask(url) { S.drawer = { type: "task", id: url, draft: "" }; renderDrawer(true); }
  function openChat(ch, draft) { S.drawer = { type: "chat", id: ch, draft: draft || "" }; renderDrawer(true); }
  function closeDrawer() { S.drawer = null; renderDrawer(); }
  function renderDrawer(focus) {
    const host = layer("drawer");
    const act0 = document.activeElement, actId = act0 && act0.closest && act0.closest("#drawer") ? act0.id : null;
    const keep = {}; host.querySelectorAll("input[id], textarea[id], select[id]").forEach((el) => { if (el.type !== "file") keep[el.id] = el.value; });
    const sc = host.querySelector(".sheet-body"), top = sc ? sc.scrollTop : 0;
    host.textContent = "";
    if (!S.drawer) { host.className = ""; return; }
    let body = null, title = "";
    if (S.drawer.type === "task") { const r = S.data.tasks.find((x) => x.url === S.drawer.id); if (!r) { S.drawer = null; host.className = ""; return; } title = "할 일"; body = taskDrawer(r); }
    if (S.drawer.type === "chat") { const c = channels().find((x) => x.id === S.drawer.id); if (!c) { S.drawer = null; host.className = ""; return; } title = c.uid ? `${c.name}님과 메시지` : `${c.name} 대화방`; body = chatDrawer(c); }
    host.className = "open";
    host.appendChild(h("div", { class: "scrim", onclick: closeDrawer }));
    host.appendChild(h("aside", { class: "sheet", role: "dialog", "aria-label": title },
      h("div", { class: "sheet-head" }, h("strong", { text: title }), h("span", { class: "kbd", text: "Esc" }), h("button", { class: "x", type: "button", "aria-label": "닫기", text: "×", onclick: closeDrawer })),
      h("div", { class: "sheet-body" }, body)));
    for (const [id, v] of Object.entries(keep)) { const el = document.getElementById(id); if (el && el.closest("#drawer") && el.value !== v) { if (el.__dpSet) el.__dpSet(v); else el.value = v; } }
    const nb = host.querySelector(".sheet-body"); if (nb) nb.scrollTop = top;
    if (actId) { const el = document.getElementById(actId); if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); } }
    else if (focus) { const el = host.querySelector("[data-autofocus]") || host.querySelector(".x"); if (el) el.focus(); }
    const lg = host.querySelector(".chat-log"); if (lg && (focus || S.drawer.stick !== false)) lg.scrollTop = lg.scrollHeight;
  }
  // 할 일에 딸린 대화: 메시지에 task를 붙여 보낸다. 메인 메시지 화면에서도 같은 글이 보인다
  const taskMsgs = (r) => S.msgs.filter((m) => m.task === r.url);
  function taskDrawer(r) {
    const pname = r["프로젝트"] || "미분류", pm = isPMof(pname), st = statusOf(r), mine = isMine(r);
    const canEdit = pm || mine || r["만든 사람"] === S.me || !APP;
    const mates = membersOf(pname);
    const other = (() => {
      const who = mates.find((m) => m.name === r["담당자"]);
      if (who && who.user_id !== S.me) return who;
      const maker = mates.find((m) => m.user_id === r["만든 사람"]);
      return maker && maker.user_id !== S.me ? maker : null;
    })();
    const save = (props, txt) => run(() => updatePage(r, props), txt || "저장했습니다.");
    const steps = ["대기", "진행", "검토 요청", "막힘"].concat(pm ? ["완료"] : []);
    const head = h("div", { class: "dw-head" },
      h("div", { class: "m" }, h("span", { class: "pill " + (st === "막힘" ? "risk" : st === "완료" ? "ok" : st === "제안" ? "info" : ""), text: st }), r["프로젝트"] ? h("span", { class: "pill", text: r["프로젝트"] }) : null, ddayEl(r["마감"]), r["작성"] === "ODD HR 작성" ? h("span", { class: "pill ai", text: "ODD HR 작성" }) : null),
      canEdit ? h("input", { id: "dwtitle", class: "dw-title", value: r["할 일"] || "", "aria-label": "할 일 이름", onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); }, onblur: (e) => { const v = e.target.value.trim(); if (v && v !== r["할 일"]) save({ "할 일": v }, "이름을 고쳤습니다."); } })
        : h("h3", { class: "dw-title", text: r["할 일"] || "(제목 없음)" }));
    // 제안 상태면 결정부터
    let decide = null;
    if (st === "제안") {
      const ask = S.drawer.decline;
      decide = h("div", { class: "dw-decide" },
        h("div", { class: "sub", text: r["제안한 사람"] ? `${r["제안한 사람"]}님이 보낸 ${r["출처"] === "PM 제안" ? "업무 요청" : "제안"}입니다.` : `${r["출처"] || "ODD HR"}에서 찾은 일입니다.` }),
        ask ? h("form", { class: "quick-bar", onsubmit: (e) => { e.preventDefault(); const v = e.target.dwr.value.trim() || "사유 없음"; S.drawer.decline = false; setStatus(r, "기각", { "기각 사유": v }, "넘겼습니다. 보낸 사람에게 알림이 갑니다."); } },
          h("input", { id: "dwr", name: "dwr", class: "quick-in", placeholder: "넘기는 이유 (예: 이번 주 촬영이 겹쳐요)", "data-autofocus": "" }), h("button", { class: "btn", type: "submit", text: "넘기기" }), h("button", { class: "btn", type: "button", text: "취소", onclick: () => { S.drawer.decline = false; renderDrawer(); } }))
        : h("div", { class: "actions" },
          h("button", { class: "btn primary", type: "button", disabled: S.busy, text: mine || !APP ? "수락" : "작업 시작", "data-autofocus": "", onclick: () => acceptTask(r) }),
          h("button", { class: "btn", type: "button", disabled: S.busy, text: "이미 처리함", onclick: () => setStatus(r, pm ? "완료" : "검토 요청", pm ? {} : { "메모": "이미 처리했다고 표시" }, pm ? "완료로 기록했습니다." : "PM에게 검토 요청으로 올렸습니다.") }),
          h("button", { class: "btn", type: "button", text: "넘기기", onclick: () => { S.drawer.decline = true; renderDrawer(); setTimeout(() => { const el = $("dwr"); if (el) el.focus(); }, 0); } })));
    }
    const stepper = st === "제안" || st === "기각" ? null : h("div", { class: "seg", role: "group", "aria-label": "상태" }, steps.map((s) => h("button", { type: "button", "aria-pressed": String(s === st), disabled: S.busy || s === st || (!pm && st === "완료"), text: s,
      onclick: () => setStatus(r, s, {}, s === "검토 요청" ? "PM에게 검토 요청을 올렸습니다." : s === "막힘" ? "막힘으로 표시했습니다. PM에게 알림이 갑니다." : undefined) })));
    const fields = h("div", { class: "dw-fields" },
      h("label", { class: "field" }, "담당자", APP ? h("select", { id: "dwwho", disabled: !canEdit, onchange: (e) => { const m = mates.find((x) => x.name === e.target.value); save({ "담당자": e.target.value, ...(m ? { "담당 역할": m.role } : {}) }, e.target.value ? `${e.target.value}님에게 맡겼습니다.` : "담당자를 비웠습니다."); } },
        h("option", { value: "", text: "정하지 않음" }), mates.map((m) => { const o = h("option", { value: m.name, text: `${m.name} (${m.role})` }); if (m.name === r["담당자"]) o.selected = true; return o; })) : h("div", { class: "quote", text: r["담당 역할"] || "-" })),
      h("label", { class: "field" }, "긴급도", h("select", { id: "dwlvl", disabled: !canEdit, onchange: (e) => save({ "긴급도": e.target.value }, "긴급도를 바꿨습니다.") }, LEVELS.map((l) => { const o = h("option", { value: l, text: l }); if (l === level(r)) o.selected = true; return o; }))),
      canEdit ? dateField("dwdue", "마감", { placeholder: "마감 없음", value: r["마감"] || "", onchange: (v) => { if (v !== (r["마감"] || "")) save({ "마감": v }, v ? `마감을 ${prettyDate(v)}로 바꿨습니다.` : "마감을 지웠습니다."); } }) : h("label", { class: "field" }, "마감", h("div", { class: "quote", text: r["마감"] || "없음" })));
    const why = r["근거 메시지"] ? h("div", { class: "dw-why" }, h("div", { class: "group-title", text: "근거" }), h("div", { class: "quote", text: r["근거 메시지"] }), r["출처 미팅"] ? h("button", { class: "linkish", type: "button", text: `미팅: ${r["출처 미팅"]}`, onclick: () => { const m = S.data.meetings.find((x) => x["제목"] === r["출처 미팅"]); closeDrawer(); if (m) S.sel.meeting = m.url; go("meetings"); } }) : null) : null;
    // 이 일에 대한 대화
    let talk = null;
    if (APP && S.me) {
      const list = taskMsgs(r);
      const target = S.drawer.to || (other ? `d:${other.user_id}` : `p:${pidOf(pname)}`);
      const targets = [[`p:${pidOf(pname)}`, `${pname} 대화방`], ...mates.filter((m) => m.user_id !== S.me).map((m) => [`d:${m.user_id}`, `${m.name}님에게 (1:1)`])];
      const send = async (fileId, text) => {
        const ta = $("dwmsg"), v = (text || (ta ? ta.value : "")).trim();
        if (!v && !fileId) return;
        const c = channels().find((x) => x.id === ($("dwto") || {}).value) || channels().find((x) => x.id === target);
        if (!c) return;
        if (ta) ta.value = ""; S.drawer.draft = "";
        try { await sendMsg(c, v ? `「${r["할 일"]}」 ${v}` : `「${r["할 일"]}」 파일`, fileId, r.url); } catch (e) { toast(errText(e), null, true); if (ta) ta.value = v; }
      };
      const fin = h("input", { type: "file", hidden: true, onchange: async (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; try { toast(`${f.name} 올리는 중…`); const id = await putFile(pname, f, "기타", `할 일: ${r["할 일"]}`); await send(id, `파일 ${f.name}`); toast("올리고 보냈습니다."); } catch (err) { toast(errText(err), null, true); } } });
      talk = h("div", { class: "dw-talk" },
        h("div", { class: "group-title" }, "이 일에 대한 대화", h("span", { text: String(list.length) })),
        list.length ? h("div", { class: "chat-log small" }, list.map((m) => h("div", { class: "bubble-row" + (m.from === S.me ? " mine" : "") }, h("div", { class: "bubble" },
          m.from === S.me ? null : h("div", { class: "who", text: nameOf(m.from) + (m.to ? " · 1:1" : "") }),
          m.file ? fileChip(m) : h("div", { class: "txt", text: String(m.text || "").replace(`「${r["할 일"]}」 `, "") }),
          h("div", { class: "meta" }, h("span", { text: `${String(m.at || "").slice(5, 10).replace("-", "/")} ${hm(m.at)}` })))))) : h("div", { class: "msg", style: "color:var(--muted)", text: other ? `${other.name}님에게 바로 물어보세요. 메시지 탭에도 같이 남습니다.` : "이 일에 대해 남길 말을 적으세요." }),
        h("div", { class: "quick-bar" },
          h("select", { id: "dwto", "aria-label": "보낼 곳", class: "mini-sel" }, targets.map(([id, l]) => { const o = h("option", { value: id, text: l }); if (id === target) o.selected = true; return o; })),
          h("button", { class: "btn attach", type: "button", "aria-label": "파일 붙이기", title: "파일을 드라이브에 올리고 이 일의 대화로 보냅니다", text: "📎", onclick: () => fin.click() }), fin),
        h("div", { class: "quick-bar" },
          h("textarea", { id: "dwmsg", class: "quick-in", rows: 1, placeholder: "메시지 (Enter 보내기)", value: S.drawer.draft || "", oninput: (e) => { S.drawer.draft = e.target.value; }, onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } }),
          h("button", { class: "btn primary", type: "button", text: "보내기", onclick: () => send() })));
    }
    const meta = h("div", { class: "dw-meta", text: [r["만든이"] ? `만든 사람 ${r["만든이"]}` : "", r["생성"] ? `${String(r["생성"]).slice(5, 10).replace("-", "/")} 생성` : "", r["상태 변경자 이름"] ? `마지막 변경 ${r["상태 변경자 이름"]} ${ago(r["상태 변경"])}` : ""].filter(Boolean).join(" · ") });
    const del = pm ? (S.drawer.del ? h("div", { class: "actions" }, h("span", { class: "msg err", text: "삭제하면 되돌릴 수 없습니다." }), h("button", { class: "btn small danger", type: "button", text: "삭제", onclick: () => { const t = r["할 일"]; closeDrawer(); run(() => removeTask(r), `'${t}'을(를) 삭제했습니다.`); } }), h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.drawer.del = false; renderDrawer(); } }))
      : h("button", { class: "linkish danger", type: "button", text: "이 할 일 삭제", onclick: () => { S.drawer.del = true; renderDrawer(); } })) : null;
    return [head, decide, stepper, fields, why, talk, meta, del];
  }
  function chatDrawer(c) {
    const send = async () => {
      const ta = $("dchatin"), v = (ta ? ta.value : "").trim(); if (!v) return;
      ta.value = ""; S.drawer.draft = "";
      try { await sendMsg(c, v); } catch (e) { ta.value = v; toast(errText(e), null, true); }
    };
    lsSet(readKey(c.id), String(Date.now()));
    return [
      h("div", { class: "chat-log drawer-log", role: "log" }, chatLog(c)),
      S.drawer.pick ? filePicker(c, true) : null,
      h("div", { class: "quick-bar" },
        h("button", { class: "btn attach", type: "button", "aria-label": "드라이브 파일 보내기", "aria-pressed": String(!!S.drawer.pick), text: "📎", onclick: () => { S.drawer.pick = !S.drawer.pick; renderDrawer(); } }),
        h("textarea", { id: "dchatin", class: "quick-in", rows: 1, "data-autofocus": "", value: S.drawer.draft || "", placeholder: "메시지 (Enter 보내기, Shift+Enter 줄바꿈)", oninput: (e) => { S.drawer.draft = e.target.value; }, onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } }),
        h("button", { class: "btn primary", type: "button", text: "보내기", onclick: send })),
      h("button", { class: "linkish", type: "button", text: "메시지 화면에서 크게 보기", onclick: () => { S.chat.ch = c.id; closeDrawer(); go("messages"); } })
    ];
  }

  // ---------- 어디서나 만들기 (⌘N) ----------
  const QA_KINDS = [["할 일", "내 할 일로 바로 넣습니다"], ["업무 요청", "팀원에게 보내 수락을 받습니다"], ["메시지", "대화방이나 팀원에게"], ["오늘 결정", "나만 보는 오늘 결정 바에"]];
  function openQuick(pre) { S.qa = { kind: (pre && pre.kind) || "할 일", ...(pre || {}) }; renderQuick(true); }
  function closeQuick() { S.qa = null; renderQuick(); }
  function renderQuick(focus) {
    const host = layer("qa"); host.textContent = "";
    if (!S.qa) { host.className = ""; return; }
    const Q = S.qa, pname = PROJECTS.includes(Q.proj) ? Q.proj : curProjName(), mates = membersOf(pname).filter((m) => m.user_id !== S.me);
    host.className = "open";
    const submit = async (e) => {
      if (e) e.preventDefault();
      const text = ($("qatext") || {}).value || "";
      if (!text.trim()) { $("qatext").focus(); return; }
      const due = ($("qadue") || {}).value || "", who = ($("qawho") || {}).value || "", lvl = ($("qalvl") || {}).value || "보통";
      const me = APP ? APP.myMember(pidOf(pname)) : null;
      try {
        if (Q.kind === "할 일" || Q.kind === "업무 요청") {
          const m = mates.find((x) => x.name === who);
          const p = { "할 일": text.trim().slice(0, 200), "프로젝트": pname, "긴급도": lvl, "작성": "사람 작성", ...(due ? { "마감": due } : {}) };
          if (Q.kind === "할 일") Object.assign(p, { "상태": "대기", "출처": Q.quote ? "메시지에서" : "직접 입력", "담당 역할": me ? me.role : "미정", ...(me ? { "담당자": me.name } : {}), ...(Q.quote ? { "근거 메시지": Q.quote } : {}) });
          else { if (!m) { toast("받을 사람을 고르세요.", null, true); return; } Object.assign(p, { "상태": "제안", "출처": isPMof(pname) ? "PM 제안" : "팀원 제안", "담당자": m.name, "담당 역할": m.role, "제안한 사람": myNameFor(pname) || "팀원", "근거 메시지": Q.quote || `${myNameFor(pname) || "팀원"}님이 직접 요청했습니다.`, "확신도": "높음" }); }
          await createPages("tasks", [p]);
          toast(Q.kind === "할 일" ? "내 할 일에 넣었습니다." : `${m.name}님에게 업무 요청을 보냈습니다. 상대 홈에 뜹니다.`);
        } else if (Q.kind === "메시지") {
          const c = channels().find((x) => x.id === who) || channels().find((x) => x.pid === pidOf(pname) && !x.uid);
          await sendMsg(c, text.trim());
          toast(`${c.uid ? c.name + "님에게" : c.name + " 대화방에"} 보냈습니다.`);
        } else { await addQuick(text.trim()); toast("오늘 결정 바에 넣었습니다."); }
        closeQuick(); paint();
      } catch (err) { toast(errText(err), null, true); }
    };
    const kinds = QA_KINDS.filter(([k]) => APP || k === "할 일" || k === "오늘 결정");
    const box = h("form", { class: "modal qa", role: "dialog", "aria-label": "새로 만들기", onsubmit: submit, onkeydown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(e); } },
      h("div", { class: "seg wide", role: "tablist" }, kinds.map(([k, d]) => h("button", { type: "button", role: "tab", "aria-pressed": String(Q.kind === k), title: d, text: k, onclick: () => { Q.text = ($("qatext") || {}).value; Q.kind = k; renderQuick(true); } }))),
      h("textarea", { id: "qatext", class: "qa-text", rows: 2, value: Q.text || Q.title || "", placeholder: Q.kind === "메시지" ? "보낼 메시지" : Q.kind === "오늘 결정" ? "예: 오후 3시까지 썸네일 A/B 결정" : "예: 촬영 장비 대여 신청하기", onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && Q.kind !== "메시지") { e.preventDefault(); submit(); } } }),
      Q.quote ? h("div", { class: "quote", style: "font-size:12.5px", text: Q.quote.slice(0, 200) }) : null,
      Q.kind === "오늘 결정" ? null : h("div", { class: "qa-row" },
        APP && APP.projects.length > 1 ? h("select", { id: "qaproj", "aria-label": "프로젝트", class: "mini-sel", onchange: (e) => { Q.text = $("qatext").value; Q.proj = e.target.value; renderQuick(); } }, projSel(pname)) : null,
        Q.kind === "업무 요청" ? h("select", { id: "qawho", "aria-label": "받을 사람", class: "mini-sel" }, h("option", { value: "", text: "받을 사람" }), mates.map((m) => { const o = h("option", { value: m.name, text: `${m.name} (${m.role})` }); if (m.name === Q.who) o.selected = true; return o; })) : null,
        Q.kind === "메시지" ? h("select", { id: "qawho", "aria-label": "보낼 곳", class: "mini-sel" }, channels().filter((c) => c.pid === pidOf(pname) || c.uid).map((c) => { const o = h("option", { value: c.id, text: c.uid ? `${c.name}님 (1:1)` : `${c.name} 대화방` }); if (c.id === Q.ch) o.selected = true; return o; })) : null,
        Q.kind !== "메시지" ? h("select", { id: "qalvl", "aria-label": "긴급도", class: "mini-sel" }, LEVELS.map((l) => { const o = h("option", { value: l, text: l }); if (l === (Q.level || "보통")) o.selected = true; return o; })) : null,
        Q.kind !== "메시지" ? dateField("qadue", "마감", { placeholder: "마감 없음", value: Q.due || "" }) : null),
      h("div", { class: "actions" }, h("span", { class: "kbd", text: `${MOD} Enter` }), h("span", { style: "flex:1" }), h("button", { class: "btn", type: "button", text: "닫기", onclick: closeQuick }), h("button", { class: "btn primary", type: "submit", text: Q.kind === "업무 요청" ? "보내기" : Q.kind === "메시지" ? "보내기" : "넣기" })));
    host.appendChild(h("div", { class: "scrim", onclick: closeQuick }));
    host.appendChild(box);
    if (focus) setTimeout(() => { const t = $("qatext"); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }, 0);
  }

  // ---------- 찾기와 명령 (⌘K) ----------
  function palItems(q) {
    const s = q.trim().toLowerCase(), hit = (t) => !s || String(t || "").toLowerCase().includes(s);
    const out = [];
    const cmd = (icon, label, sub, fn, kw) => { if (hit(label) || hit(kw) || hit(sub)) out.push({ icon, label, sub, fn }); };
    cmd("+", "새 할 일", `${MOD} N`, () => openQuick({ kind: "할 일" }), "만들기 추가 todo");
    if (APP) { cmd("→", "업무 요청 보내기", "팀원에게", () => openQuick({ kind: "업무 요청" }), "제안 요청 맡기기"); cmd("✉", "메시지 보내기", "", () => openQuick({ kind: "메시지" }), "채팅 dm"); }
    cmd("🎙", "말로 할 일 올리기", "", () => { go("home"); setTimeout(() => { const b = document.querySelector(".voice .btn.mic"); if (b) { b.scrollIntoView({ block: "center" }); b.click(); } }, 80); }, "음성 받아쓰기");
    cmd("!", "오늘 결정할 것 적기", "", () => openQuick({ kind: "오늘 결정" }), "결정 바");
    if (APP && APP.agentAvailable && S.isPM) cmd("↻", "지금 카톡 점검하기", "", () => pcSync(true), "카카오톡");
    if (APP) cmd("✦", "새 기능 보기", APP.version ? `버전 ${APP.version}` : "", () => openWhatsNew(true), "업데이트 변경");
    VIEWS.forEach(([k, l]) => cmd("#", `${l} 화면`, "이동", () => go(k), k));
    if (s) {
      S.data.tasks.filter((r) => !["기각"].includes(statusOf(r)) && hit(`${r["할 일"]} ${r["담당자"] || ""} ${r["프로젝트"] || ""}`)).slice(0, 8)
        .forEach((r) => out.push({ icon: "☐", label: r["할 일"], sub: [statusOf(r), r["담당자"] || r["담당 역할"], r["마감"] ? r["마감"].slice(5).replace("-", "/") : ""].filter(Boolean).join(" · "), fn: () => openTask(r.url) }));
      if (APP) {
        const seen = new Set();
        APP.members.filter((m) => m.user_id !== S.me && hit(`${m.name} ${m.role}`)).forEach((m) => { if (seen.has(m.user_id)) return; seen.add(m.user_id); out.push({ icon: m.name.slice(0, 1), label: `${m.name}`, sub: `${m.role} · 메시지 보내기`, fn: () => openChat(`d:${m.user_id}`) }); });
        S.files.filter((f) => hit(`${f["이름"]} ${f["메모"] || ""}`)).slice(0, 6).forEach((f) => out.push({ icon: "▤", label: f["이름"], sub: `드라이브 › ${f["프로젝트"]} › ${f["폴더"] || "기타"}`, fn: () => openFile(f, false) }));
      }
      S.data.meetings.filter((m) => hit(`${m["제목"]} ${m["노트"] || ""}`)).slice(0, 4).forEach((m) => out.push({ icon: "◷", label: m["제목"] || "(제목 없음)", sub: `미팅 · ${m["일시"] ? whenText(m["일시"]) : "일정 미정"}`, fn: () => { S.sel.meeting = m.url; go("meetings"); } }));
      S.data.goals.filter((g) => hit(g["목표"])).slice(0, 3).forEach((g) => out.push({ icon: "◎", label: g["목표"], sub: `목표 · ${Math.round((Number(g["진행률"]) || 0) * 100)}%`, fn: () => go("goals") }));
    }
    return out.slice(0, 40);
  }
  function openPalette() { S.pal = { q: "", i: 0 }; renderPalette(true); }
  function closePalette() { S.pal = null; renderPalette(); }
  function renderPalette(focus) {
    const host = layer("pal"); host.textContent = "";
    if (!S.pal) { host.className = ""; return; }
    host.className = "open";
    const items = palItems(S.pal.q); S.pal.i = Math.min(S.pal.i, Math.max(0, items.length - 1));
    const pick = (it) => { closePalette(); it.fn(); };
    const list = h("div", { class: "pal-list", role: "listbox" }, items.length ? items.map((it, i) => h("button", { type: "button", role: "option", class: "pal-item", "aria-selected": String(i === S.pal.i), onmouseenter: () => { S.pal.i = i; host.querySelectorAll(".pal-item").forEach((b, k) => b.setAttribute("aria-selected", String(k === i))); }, onclick: () => pick(it) },
      h("span", { class: "pal-ic", text: it.icon }), h("span", { class: "pal-t", text: it.label }), it.sub ? h("span", { class: "pal-s", text: it.sub }) : null)) : h("div", { class: "empty", text: "찾는 것이 없습니다." }));
    const input = h("input", { id: "palq", class: "pal-q", value: S.pal.q, placeholder: "할 일, 사람, 파일, 미팅, 화면, 명령 찾기", autocomplete: "off",
      oninput: (e) => { S.pal.q = e.target.value; S.pal.i = 0; renderPalette(); const el = $("palq"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); },
      onkeydown: (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); S.pal.i = (S.pal.i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length); host.querySelectorAll(".pal-item").forEach((b, k) => { b.setAttribute("aria-selected", String(k === S.pal.i)); if (k === S.pal.i) b.scrollIntoView({ block: "nearest" }); }); }
        else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); if (items[S.pal.i]) pick(items[S.pal.i]); }
      } });
    host.appendChild(h("div", { class: "scrim", onclick: closePalette }));
    host.appendChild(h("div", { class: "modal pal", role: "dialog", "aria-label": "찾기" }, input, list,
      h("div", { class: "pal-foot" }, h("span", { text: `↑↓ 고르기 · Enter 열기 · Esc 닫기` }), h("span", { text: `${MOD} K 찾기 · ${MOD} N 새로 만들기` }))));
    if (focus) setTimeout(() => { const el = $("palq"); if (el) el.focus(); }, 0);
  }

  // ---------- 새 기능 (업데이트 뒤 처음 켤 때) ----------
  const CHANGES = [
    { v: "0.3.1", title: "설치와 업데이트가 눈에 보이게", items: [
      ["'제대로 설치하기'와 업데이트", "누르면 앱이 말없이 꺼지던 문제를 고쳤습니다. 안내 창이 뜨고, Windows에서는 설치 진행 막대가 보인 뒤 ODD HR이 다시 켜집니다.", null],
      ["Windows 설치 시험", "새 버전을 낼 때마다 설치 파일이 설치되고 다시 켜지는지 자동으로 확인합니다.", null]] },
    { v: "0.3.0", title: "흐름이 끊기지 않게", items: [
      ["옆 패널", "알림, 제안, 할 일을 누르면 지금 화면 위 오른쪽에 열립니다. 상태 바꾸기, 수락, 담당자·마감 고치기, 담당자에게 메시지, 파일 붙이기까지 그 안에서 끝납니다.", null],
      ["알림에서 바로 처리", "알림 줄에서 수락, 넘기기, 승인, 답장을 누릅니다. 다른 화면으로 가지 않습니다.", () => go("home")],
      ["어디서나 만들기", `${MOD} N 또는 위쪽 '+ 새로 만들기'로 할 일, 업무 요청, 메시지, 오늘 결정을 그 자리에서 만듭니다.`, () => openQuick({ kind: "할 일" })],
      ["찾기와 명령", `${MOD} K로 할 일, 사람, 파일, 미팅, 화면, 명령을 한 번에 찾습니다.`, () => openPalette()],
      ["되돌리기", "상태를 바꾸면 아래에 6초 동안 '되돌리기'가 뜹니다.", null],
      ["보던 자리 기억", "화면을 오가도 보던 위치로 돌아옵니다. 위쪽 '← 뒤로'로 이전 화면에 갑니다.", null],
      ["자동 업데이트", "앱을 켤 때 새 버전이 있으면 먼저 받아 설치하고 다시 켭니다. 받은 파일은 지문(SHA-256)을 확인한 뒤에만 설치합니다.", null]] },
    { v: "0.2.0", title: "소통과 자료", items: [
      ["메시지·드라이브", "팀 대화방, 1:1 메시지, 파일 위치 보내기, 프로젝트 자료함.", () => go("messages")],
      ["업무 요청", "PM이 보낸 요청이 홈 '들어온 업무 요청'에 뜹니다.", null],
      ["양식", "계약서 작성 도우미와 프로젝트 브리프.", () => go("forms")],
      ["말로 할 일 올리기, 회의록 양식, 주간 업데이트, 목표 확인 알림", "", null]] }
  ];
  function openWhatsNew(force) {
    if (!APP) return;
    const seen = lsGet("oddhr.seenVersion");
    if (!force && (!APP.version || seen === APP.version)) return;
    if (!force && !seen) { lsSet("oddhr.seenVersion", APP.version); return; }   // 처음 설치한 사람에게는 시작하기가 있으니 띄우지 않는다
    const host = layer("wn"); host.textContent = ""; host.className = "open";
    const close = () => { lsSet("oddhr.seenVersion", APP.version); host.className = ""; host.textContent = ""; };
    const cur = CHANGES.find((c) => c.v === APP.version) || CHANGES[0];
    host.appendChild(h("div", { class: "scrim", onclick: close }));
    host.appendChild(h("div", { class: "modal wn", role: "dialog", "aria-label": "새 기능" },
      h("div", { class: "wn-head" }, h("span", { class: "pill ai", text: `새 버전 ${APP.version || cur.v}` }), h("h2", { text: cur.title }), h("p", { class: "sub", text: "업데이트를 마쳤습니다. 바뀐 것을 한 번 보고 시작하세요." })),
      h("div", { class: "wn-list" }, cur.items.map(([t, d, tryIt]) => h("div", { class: "wn-item" }, h("div", {}, h("strong", { text: t }), d ? h("p", { text: d }) : null), tryIt ? h("button", { class: "btn small", type: "button", text: "써 보기", onclick: () => { close(); tryIt(); } }) : null))),
      CHANGES.length > 1 ? h("details", { class: "wn-old" }, h("summary", { text: "지난 버전" }), CHANGES.filter((c) => c !== cur).map((c) => h("div", {}, h("strong", { text: `${c.v} · ${c.title}` }), h("ul", {}, c.items.map(([t, d]) => h("li", { text: d ? `${t}: ${d}` : t })))))) : null,
      h("div", { class: "actions" }, h("span", { style: "flex:1" }), h("button", { class: "btn primary", type: "button", "data-autofocus": "", text: "시작하기", onclick: close }))));
    setTimeout(() => { const b = host.querySelector("[data-autofocus]"); if (b) b.focus({ preventScroll: true }); const m = host.querySelector(".modal"); if (m) m.scrollTop = 0; }, 0);
  }

  // ---------- 위쪽 막대: 뒤로, 찾기, 새로 만들기 ----------
  function topBar() {
    return h("div", { class: "topbar" },
      S.navDepth > 0 ? h("button", { class: "btn small ghost", type: "button", text: "← 뒤로", onclick: () => history.back() }) : h("span"),
      h("button", { class: "searchbox", type: "button", onclick: openPalette, "aria-label": "찾기와 명령" }, h("span", { text: "할 일, 사람, 파일, 명령 찾기" }), h("span", { class: "kbd", text: `${MOD} K` })),
      h("button", { class: "btn primary small", type: "button", onclick: () => openQuick({ kind: "할 일" }), title: `${MOD} N` }, "+ 새로 만들기"));
  }

  // ---------- 단축키 ----------
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); S.pal ? closePalette() : openPalette(); return; }
    if (mod && (e.key === "n" || e.key === "N")) { e.preventDefault(); openQuick({ kind: "할 일" }); return; }
    if (e.key === "Escape") {
      if ($("wn") && $("wn").className === "open") { const b = $("wn").querySelector(".btn.primary"); if (b) b.click(); return; }
      if (S.pal) { closePalette(); return; }
      if (S.qa) { if (document.querySelector("#qa .dp-pop:not([hidden])")) return; closeQuick(); return; }
      if (S.drawer) { if (document.querySelector("#drawer .dp-pop:not([hidden])")) return; closeDrawer(); return; }
    }
    if (e.key === "/" && !mod && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "")) { e.preventDefault(); openPalette(); }
  });


  // ---------- 업데이트 진행 소식 (설정 화면, 토스트) ----------
  if (window.oddhr && window.oddhr.onUpdate) window.oddhr.onUpdate((m) => {
    const U = S.upd || (S.upd = {});
    U.text = m.state === "downloading" ? `새 버전 받는 중 ${m.percent || 0}% · ${m.text || ""}` : m.state === "installing" ? "지문 확인을 마쳤습니다. 설치하고 다시 켭니다…" : m.state === "error" ? `업데이트하지 못했습니다: ${m.text}` : U.text;
    const el = document.getElementById("updtext"); if (el) el.textContent = U.text;
    if (m.state === "installing") toast("업데이트를 설치하고 다시 켭니다.");
    if (m.state === "error") { U.busy = false; toast(U.text, null, true); }
  });
  function installNotice() {
    const NV = window.oddhr || {};
    if (!NV.installState || S.instHide) return null;
    const st = NV.installState();
    if (st.installed) return null;
    return h("div", { class: "notice row-notice" }, h("span", { text: "설치하지 않고 압축본으로 켰습니다. 설치하면 '설치된 앱'과 시작 메뉴에 뜨고 자동 업데이트가 됩니다." }),
      h("button", { class: "btn small primary", type: "button", text: "제대로 설치하기", onclick: async () => { toast("설치 파일을 받는 중…"); const r = await NV.installProperly(); if (!r.ok) toast(`설치하지 못했습니다: ${r.error}`, null, true); } }),
      h("button", { class: "btn small ghost", type: "button", text: "닫기", onclick: () => { S.instHide = true; render(); } }));
  }

  // ---------- 팀원 (PM 버전 / 팀원 버전) ----------
  const STAGES = {
    "기획": ["리서치", "기획안", "시나리오·대본", "콘티", "섭외"],
    "디자인": ["레퍼런스", "시안", "수정", "최종 파일"],
    "촬영": ["준비", "장비 확보", "촬영", "백업"],
    "편집": ["가편집", "수정", "컬러·사운드", "자막", "최종 렌더"],
    "PM": ["기획 조율", "제작 관리", "검수", "납품"]
  };
  const STAGE_EXTRA = ["대기", "막힘", "완료"];
  const CAN_PM = ["주간 업데이트 확인과 코멘트", "드라이브 정리 (모든 파일 지우기)", "프로젝트 만들기와 입장 코드 발급", "멤버 역할 바꾸기, PM 권한 주기, 내보내기", "할 일 완료 처리·승인·삭제", "미팅 정보 고치기", "PM 확인 필요 보기", "팀원 단계 확인 체크", "카톡 에이전트 (Windows, Mac)"];
  const CAN_MEMBER = ["할 일 만들기, 팀원에게 제안하기, 검토 요청까지 올리기", "막힘 표시", "제안 수락·넘기기", "메시지 (팀 대화방, 1:1)", "드라이브 올리기 (내 파일만 지우기)", "미팅 노트, 회의록 양식, 자동 정리", "주간 업데이트 제출", "내 지금 단계 바꾸기", "오늘 결정 바 (나만 보기)"];
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

    // 다른 기기에서 같은 사람으로 쓰기: 코드 계정에 이메일을 연결한다
    const link = APP.isAnon ? h("section", { class: "box" }, h("h2", {}, "이메일 연결", h("span", { class: "pill risk", text: "권장" })),
      h("p", { class: "sub", text: "지금은 이 기기에만 저장된 계정입니다. 이메일과 비밀번호를 연결하면 아이폰, 아이패드, 다른 PC에서도 '이메일로 로그인'으로 같은 사람으로 들어오고, 앱을 다시 깔아도 기록이 남습니다." }),
      h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); const f = e.target; if (f.lpw.value.length < 6) { S.flash.link = { ok: false, text: "비밀번호는 6자 이상입니다." }; render(); return; } if (f.lpw.value !== f.lpw2.value) { S.flash.link = { ok: false, text: "비밀번호 두 칸이 다릅니다." }; render(); return; } act("link", () => APP.linkEmail(f.lemail.value.trim(), f.lpw.value), "이메일을 연결했습니다. 다른 기기에서는 '이메일로 로그인'으로 들어오세요."); } },
        h("label", { class: "field" }, "이메일", h("input", { id: "lemail", name: "lemail", type: "email", autocomplete: "email", required: true })),
        h("label", { class: "field" }, "비밀번호 (6자 이상)", h("input", { id: "lpw", name: "lpw", type: "password", autocomplete: "new-password" })),
        h("label", { class: "field" }, "비밀번호 확인", h("input", { id: "lpw2", name: "lpw2", type: "password", autocomplete: "new-password" })),
        h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit", disabled: S.busy, text: "연결하기" }))),
      flashEl("link")) : null;

    const notifOn = lsGet("oddhr.notify") !== "0";
    const isWeb = !APP.platform || APP.platform === "web";
    const alerts = h("section", { class: "box" }, h("h2", {}, "알림"),
      h("div", { class: "setrow" },
        h("div", { class: "lab2", text: "화면 알림" }), h("span", { style: "display:flex;gap:8px;align-items:center;font-size:14px" }, h("input", { class: "toggle", type: "checkbox", id: "notifon", checked: notifOn, onchange: (e) => { lsSet("oddhr.notify", e.target.checked ? "1" : "0"); render(); } }), isWeb ? "앱이 열려 있을 때 새 제안, 수락·거절, 메시지, 주간 업데이트를 알립니다" : "새 제안, 수락·거절, 메시지, 주간 업데이트를 운영체제 알림으로도 띄웁니다"),
        h("div", { class: "lab2", text: "알리는 것" }), h("div", { class: "msg", style: "color:var(--muted)", text: "내게 온 할 일 제안 · 내 제안의 수락과 거절 · 완료 처리 · 1:1 메시지 · 오늘·내일 마감 · (PM) 검토 요청, 막힘, 주간 업데이트 제출 · 내 주간 업데이트 PM 확인" })));

    const mobile = APP.webUrl ? h("section", { class: "box" }, h("h2", {}, "아이폰 · 아이패드에서 쓰기"),
      h("p", { class: "sub", text: "Safari로 아래 주소를 열고 공유 버튼 → '홈 화면에 추가'를 누르면 앱처럼 쓸 수 있습니다. 코드로 들어왔다면 먼저 위 '이메일 연결'을 하고, 아이폰에서는 '이메일로 로그인'으로 들어오세요." }),
      h("div", { class: "codebox" }, h("span", { class: "code", style: "font-size:14px;letter-spacing:0", text: APP.webUrl }),
        h("button", { class: "btn small", type: "button", text: "주소 복사", onclick: async (e) => { try { await navigator.clipboard.writeText(APP.webUrl); e.target.textContent = "복사했습니다"; } catch (err) { e.target.textContent = "길게 눌러 선택하세요"; } } }))) : null;

    const account = h("section", { class: "box" }, h("h2", {}, "계정과 서버"),
      h("dl", { class: "kv" },
        h("dt", { text: "계정" }), h("dd", { text: APP.isAnon ? "코드로 들어온 계정 (이 기기에만 저장)" : APP.email || "" }),
        h("dt", { text: "서버" }), h("dd", { text: (APP.serverUrl || "").replace(/^https:\/\//, "") }),
        h("dt", { text: "실시간" }), h("dd", { text: APP.live ? "연결됨" : "다시 연결하는 중" }),
        h("dt", { text: "앱 버전" }), h("dd", { text: APP.version || "-" })),
      APP.isPMAny() && APP.connectionString() ? h("div", { class: "actions" }, h("button", { class: "btn small", type: "button", text: "서버 연결 문자열 복사", title: "설치 파일에 서버가 안 들어 있을 때, 팀원이 첫 화면에 붙여 넣습니다", onclick: async (e) => { try { await navigator.clipboard.writeText(APP.connectionString()); e.target.textContent = "복사했습니다. 팀원에게 코드와 함께 주세요"; } catch (err) { e.target.textContent = "복사하지 못했습니다"; } } })) : null,
      S.confirmLogout ? h("div", { class: "notice" }, APP.isAnon ? "코드로 들어온 계정은 로그아웃하면 다시 들어올 수 없습니다. 코드를 다시 넣으면 새 사람으로 들어가고, PM이 팀원 탭의 '기록 옮기기'로 이전 기록을 옮겨 줘야 합니다." : "로그아웃합니다. 이메일과 비밀번호로 다시 들어올 수 있습니다.",
        h("div", { class: "actions", style: "margin-top:8px" }, h("button", { class: "btn small danger", type: "button", text: "로그아웃", onclick: () => APP.signOut() }), h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.confirmLogout = false; render(); } })))
        : h("div", { class: "actions" }, h("button", { class: "btn", type: "button", text: "로그아웃", onclick: () => { S.confirmLogout = true; render(); } })));
    const NV = window.oddhr || {};
    const U = S.upd || (S.upd = {});
    const inst = NV.installState ? NV.installState() : { installed: true, inApplications: true };
    const updates = NV.updateCheck ? h("section", { class: "box" }, h("h2", {}, "업데이트"),
      h("div", { class: "setrow" },
        h("div", { class: "lab2", text: "지금 버전" }), h("div", { text: APP.version || "-" }),
        h("div", { class: "lab2", text: "상태" }), h("div", { id: "updtext", text: U.text || "앱을 켤 때마다 새 버전을 확인하고, 있으면 먼저 설치한 뒤 켭니다." })),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", disabled: !!U.busy, text: "지금 확인", onclick: async () => { U.busy = true; U.text = "확인 중…"; render(); const r = await NV.updateCheck(); U.busy = false; U.latest = r.latest; U.available = !!r.available; U.text = !r.ok ? `확인하지 못했습니다: ${r.error}` : r.available ? `새 버전 ${r.latest}이 있습니다.` : r.dev ? "개발용 실행이라 업데이트하지 않습니다." : `최신 버전입니다 (${r.current}).`; render(); } }),
        U.available ? h("button", { class: "btn primary", type: "button", disabled: !!U.busy, text: `${U.latest} 설치하고 다시 켜기`, onclick: async () => { U.busy = true; U.text = "받는 중…"; render(); const r = await NV.updateInstall(); if (!r.ok) { U.busy = false; U.text = `설치하지 못했습니다: ${r.error}`; render(); } } }) : null,
        h("button", { class: "btn", type: "button", text: "새 기능 보기", onclick: () => openWhatsNew(true) }),
        !inst.installed && NV.installProperly ? h("button", { class: "btn primary", type: "button", disabled: !!U.busy, text: "제대로 설치하기", title: "설치된 앱과 시작 메뉴에 등록하고 자동 업데이트를 켭니다", onclick: async () => { U.busy = true; U.text = "설치 파일을 받는 중…"; render(); const r = await NV.installProperly(); if (!r.ok) { U.busy = false; U.text = `설치하지 못했습니다: ${r.error}`; render(); } } }) : null),
      !inst.installed ? h("div", { class: "notice", text: "지금은 압축을 풀어 켠 상태라 Windows '설치된 앱'과 시작 메뉴에 없습니다. '제대로 설치하기'를 누르면 설치 프로그램으로 깔고 다시 켭니다. 기록은 그대로입니다." }) : null) : null;
    return [pageHead("설정", "화면 모드, 키 컬러, 알림은 이 기기에만 저장됩니다."), link, updates, looks, alerts, profile, projects, mobile, agentBox, account];
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
        if (f.macdir) { patch.mac_export_dir = f.macdir.value.trim() || c.mac_export_dir; patch.mac_live = !!(f.maclive && f.maclive.checked); }
        lsSet("oddhr.autoscan", f.auto.checked ? "1" : "0");
        appAct("settings", async () => { const r = await APP.agent(["config-set", JSON.stringify(patch)]); S.agentCfg = r.config; if (S.pc.status) S.pc.status.interval_sec = r.config.interval_sec; if (pullTimer) { clearInterval(pullTimer); pullTimer = null; } startAutoPull(); }, "카톡 에이전트 설정을 저장했습니다.");
      } },
        APP.platform === "darwin" ? h("div", { class: "notice wide" }, "Mac 카카오톡은 대화를 바깥 프로그램에 바로 내주지 않습니다. 대화방 → 메뉴(≡) → '대화 내용 내보내기' → '텍스트로 저장'한 파일을 아래 폴더에 넣어 두면 점검할 때마다 새 메시지만 읽어 할 일을 제안합니다. 같은 방을 다시 내보내 덮어써도 이미 본 메시지는 건너뜁니다.") : null,
        APP.platform === "darwin" ? h("label", { class: "field wide" }, "카톡 내보내기 폴더", h("span", { style: "display:flex;gap:8px" }, h("input", { id: "macdir", name: "macdir", value: c.mac_export_dir || "", style: "flex:1" }), h("button", { class: "btn small", type: "button", text: "폴더 열기", onclick: () => window.oddhr && window.oddhr.openFolder && window.oddhr.openFolder(($("macdir") || {}).value || c.mac_export_dir) }))) : null,
        APP.platform === "darwin" ? h("label", { class: "field wide" }, h("span", { text: "열린 대화방 창 직접 읽기 (실험)" }), h("span", { style: "display:flex;gap:8px;align-items:center;color:var(--ink);font-size:14px" }, h("input", { class: "toggle", type: "checkbox", id: "maclive", name: "maclive", checked: !!c.mac_live }), "점검할 때 카카오톡을 잠깐 앞으로 가져와 열린 창을 복사해 읽습니다. '손쉬운 사용' 권한이 필요하고, 그 순간 타자가 카톡으로 갈 수 있습니다.")) : null,
        h("label", { class: "field wide" }, APP.platform === "darwin" ? "감시할 대화방 (쉼표로 구분, 내보낸 파일 첫 줄이나 창 제목의 대화방 이름)" : "감시할 대화방 (쉼표로 구분, 카톡 창 제목 그대로)", h("input", { id: "rooms", name: "rooms", value: rooms.join(", "), placeholder: "예: 양천경찰서 영상팀, 공모전 팀방" })),
        rooms.map((r, i) => h("label", { class: "field" }, `'${r}' 방의 프로젝트`, h("select", { id: `rp-${i}`, name: `rp-${i}` }, pmProjects.map((p) => { const o = h("option", { value: p.name, text: p.name }); if ((c.room_projects || {})[r] === p.name) o.selected = true; return o; })))),
        h("label", { class: "field" }, "점검 간격", h("select", { id: "interval", name: "interval" }, [[60, "1분"], [180, "3분"], [300, "5분"], [600, "10분"], [1800, "30분"]].map(([v, l]) => { const o = h("option", { value: String(v), text: l }); if (Number(c.interval_sec || 180) === v) o.selected = true; return o; }))),
        h("label", { class: "field" }, h("span", { text: "자동 점검" }), h("span", { style: "display:flex;gap:8px;align-items:center;color:var(--ink);font-size:14px" }, h("input", { class: "toggle", type: "checkbox", id: "auto", name: "auto", checked: lsGet("oddhr.autoscan") !== "0" }), "앱이 켜져 있으면 간격마다 점검")),
        h("label", { class: "field wide" }, "팀원 카톡 이름=역할 (담당 역할을 맞히는 데 씀)", h("textarea", { id: "members", name: "members", style: "min-height:60px", value: membersText, placeholder: "홍길동=편집, 김철수=촬영" })),
        h("label", { class: "field wide" }, h("span", { text: "로컬 모델 (선택)" }), h("span", { style: "display:flex;gap:8px;align-items:center;color:var(--ink);font-size:14px" }, h("input", { class: "toggle", type: "checkbox", id: "llm", name: "llm", checked: !!(c.llm && c.llm.enabled) }), `애매한 메시지만 이 PC의 Ollama(${(c.llm && c.llm.model) || "exaone3.5:7.8b"})로 다시 판정`)),
        h("label", { class: "field wide" }, h("span", { text: "컴퓨터를 켤 때" }), h("span", { style: "display:flex;gap:8px;align-items:center;color:var(--ink);font-size:14px" }, h("input", { class: "toggle", type: "checkbox", id: "atlogin", checked: !!APP.openAtLogin, onchange: async (e) => { if (APP.setLoginItem) APP.openAtLogin = await APP.setLoginItem(e.target.checked); } }), APP.platform === "darwin" ? "로그인할 때 ODD HR을 창 없이 켜서 카톡 점검 시작" : "ODD HR을 창 없이 자동으로 켜서 카톡 점검 시작")),
        h("div", { class: "actions wide" }, h("button", { class: "btn primary", type: "submit", text: "저장" }), checkNowBtn())));
  }

  // ---------- 렌더 ----------
  function projOptions(cur) {
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
    const m = $("menu"); m.textContent = "";
    const counts = { tasks: proposals().length, todo: S.data.tasks.filter((r) => statusOf(r) === "검토 요청").length };
    if (APP && S.me) { counts.home = unreadNotifs().length; counts.messages = channels().reduce((n, c) => n + unreadIn(c.id), 0); }
    // 좁은 화면(아이폰)에서는 자주 쓰는 4개만 아래 막대에 두고 나머지는 '더보기'에 넣는다
    const PRIMARY = APP ? ["home", "todo", "messages", "drive"] : ["home", "tasks", "todo", "meetings"];
    const moreCount = VIEWS.filter(([k]) => !PRIMARY.includes(k)).reduce((n, [k]) => n + (counts[k] || 0), 0);
    const link = (k, l, cls) => h("a", { href: `#${k}`, class: cls, "aria-current": S.view === k ? "page" : null, onclick: () => { S.moreOpen = false; m.classList.remove("open"); } }, l, counts[k] ? h("span", { class: "badge", text: String(counts[k]) }) : null);
    VIEWS.forEach(([k, l]) => m.appendChild(link(k, l, PRIMARY.includes(k) ? "" : "more-item")));
    m.appendChild(h("button", { class: "more-btn", type: "button", "aria-expanded": String(!!S.moreOpen), "aria-current": !PRIMARY.includes(S.view) ? "page" : null, onclick: () => { S.moreOpen = !S.moreOpen; m.classList.toggle("open", S.moreOpen); const b = m.querySelector(".more-btn"); if (b) b.setAttribute("aria-expanded", String(S.moreOpen)); } }, "더보기", moreCount ? h("span", { class: "badge", text: String(moreCount) }) : null));
    m.appendChild(h("div", { class: "more-sheet", role: "menu" }, VIEWS.filter(([k]) => !PRIMARY.includes(k)).map(([k, l]) => link(k, l, "sheet-item"))));
    m.classList.toggle("open", !!S.moreOpen);
    $("dot").className = "dot" + (S.mode === "live" ? " live" : S.mode === "example" ? " example" : "");
    $("conn").textContent = S.mode === "live" ? `실시간 저장${S.canWrite === false ? " · 보기 전용" : ""}${S.note ? " · " + S.note : ""}` : S.mode === "example" ? `예시 데이터${S.note ? " · " + S.note : ""}` : "연결 확인 중";
  }
  function render() {
    renderMenu();
    const main = $("main");
    // 다시 그려도 저장 전 입력값은 남긴다 (같은 화면, 같은 선택일 때만)
    const scope = `${S.view}|${S.sel.task}|${S.sel.meeting}|${S.sel.goal}|${S.chat.ch}|${S.editTask}`;
    const keep = {};
    if (!S.clearDrafts && render.scope === scope) main.querySelectorAll("input[id], textarea[id], select[id]").forEach((el) => { if (!["file", "checkbox"].includes(el.type)) keep[el.id] = el.value; });
    S.clearDrafts = false; render.scope = scope;
    main.textContent = "";
    main.appendChild(topBar());
    if (S.view === "home" && typeof installNotice === "function") { const n = installNotice(); if (n) main.appendChild(n); }
    if (S.view === "tasks" && S.flash.pc) main.appendChild(flashEl("pc"));
    if (APP && APP.projects.length > 1) main.appendChild(h("div", { class: "mproj" }, h("span", { text: "기본 프로젝트" }), h("select", { "aria-label": "기본 프로젝트", onchange: (e) => APP.setCurrentProject(APP.projectId(e.target.value)) }, projSel(curProjName()))));
    if (S.mode === "example") main.appendChild(h("div", { class: "notice" }, "지금은 예시 데이터를 보여 주고 있습니다. 여기서 누른 버튼은 저장되지 않습니다. ", S.note ? S.note : ""));
    const v = { home: viewHome, tasks: viewTasks, todo: viewTodo, goals: viewGoals, meetings: viewMeetings, team: viewTeam, agents: viewAgents, settings: viewSettings, messages: viewMessages, drive: viewDrive, forms: viewForms }[S.view] || viewHome;
    [v()].flat(Infinity).forEach((n) => n && main.appendChild(n));
    for (const [id, val] of Object.entries(keep)) {
      const el = document.getElementById(id);
      if (!el || el.value === val) continue;
      if (el.__dpSet) el.__dpSet(val); else el.value = val;
    }
    if (S.drawer && !inLayer()) renderDrawer();
    if (APP && S.me && S.mode === "live" && !S.wnChecked) { S.wnChecked = true; setTimeout(() => openWhatsNew(), 300); }
  }
  function go(view) { if (location.hash !== `#${view}`) location.hash = view; else { S.view = view; render(); } }
  document.addEventListener("pointerdown", (e) => { if (S.moreOpen && !e.target.closest("#menu")) { S.moreOpen = false; renderMenu(); } });
  S.scroll = {}; S.navDepth = 0;
  function fromHash() {
    S.moreOpen = false;
    S.scroll[S.view] = window.scrollY;
    const k = location.hash.replace("#", ""), prev = S.view;
    S.view = VIEWS.some(([v]) => v === k) ? k : "home";
    // 뒤로 가기용 깊이: 기록마다 붙여 두고, 뒤로 가면 그 기록의 값을 읽는다
    try { if (!history.state || history.state.d === undefined) history.replaceState({ d: prev !== S.view ? S.navDepth + 1 : S.navDepth }, ""); S.navDepth = history.state.d; } catch (e) {}
    render(); window.scrollTo(0, S.scroll[S.view] || 0);
  }
  try { if (!history.state) history.replaceState({ d: 0 }, ""); } catch (e) {}
  window.addEventListener("hashchange", fromHash);

  $("refresh").addEventListener("click", () => {
    if (!S.db) { render(); return; }
    S.note = "다시 불러오는 중"; renderMenu(); subscribe(); subscribeExtra();
  });

  S.view = (VIEWS.find(([v]) => v === location.hash.replace("#", "")) || ["home"])[0];
  render();
  if (APP) APP.onChange(() => { syncProjects(); paint(); });
  if (window.oddhr && window.oddhr.onCheckNow) window.oddhr.onCheckNow(() => { go("agents"); pcSync(true, false); });

  const use = (n) => window.claude && typeof window.claude.use === "function" ? window.claude.use(n).catch(() => null) : Promise.resolve(null);
  use("sample").then((s) => { S.sample = s; if (S.view === "meetings") render(); });
  use("user").then(async (u) => {
    S.user = u;
    if (!u) return;
    try { S.canWrite = await u.can("data.write"); } catch (e) {}
    try { S.me = await u.id(); } catch (e) {}
    subscribeQuick();
    try { S.isOwner = !!(await u.isOwner()); } catch (e) {}
    try { S.isPM = S.isOwner || !!(await u.canEdit()); } catch (e) { S.isPM = S.isOwner; }
    maybeAutoSync();
    if (S.mode !== "pending") paint();
  });
  use("db").then((db) => {
    if (!db) { useExample("저장소를 쓸 수 없는 화면입니다 (로그인하지 않았거나 미리보기)"); return; }
    S.db = db;
    subscribe();
    subscribeFlags();
    subscribeQuick();
    subscribeExtra();
    maybeAutoSync();
  });
  use("mcp").then((m) => { S.mcp = m; maybeAutoSync(); });
  let autoTried = false;
  function maybeAutoSync() {
    // 이 기기에서 한 번이라도 PC 에이전트와 연결된 적이 있을 때만, Desk 주인 화면에서 조용히 가져온다
    if (autoTried || !S.db || !S.mcp || !S.isOwner) return;
    autoTried = true;
    pcSync(false, true).then(() => startAutoPull());
  }
})();
