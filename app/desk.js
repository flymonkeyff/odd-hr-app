(() => {
  // ---------- 설정 ----------
  const KEYS = ["tasks", "goals", "meetings"];
  const LINKS = { plan: "https://claude.ai/artifact/FXvnXtdmjQ1XKd1XSzbReR" };
  // 프로젝트와 마감은 서버의 내 프로젝트에서 온다 (앱 연결부가 알려 줄 때마다 다시 채운다)
  const APP = window.oddhrApp;
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
    ["home", "홈"], ["tasks", "작업"], ["todo", "할 일"], ["goals", "목표"], ["meetings", "미팅"], ["team", "팀원"], ["agents", "에이전트"], ["settings", "설정"]
  ];

  // ---------- 상태 ----------
  const S = {
    view: "home", mode: "pending", note: "", db: null, user: null, canWrite: null, sample: null, me: null, mcp: null, isOwner: false, isPM: false, confirmDel: null, editMeeting: null, quick: [], quickReady: false, flags: [], pc: { state: null, status: null }, weekly: null,
    data: { tasks: [], goals: [], meetings: [] },
    sel: { task: null, meeting: null }, flash: {},
    filter: { role: "전체", project: "전체", showDone: false },
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
  function autoSummarize(m, note) {
    const ref = String(m["일시"] || "").slice(0, 10) || ymd(new Date());
    const lines = String(note || "").split(/\n+|(?<=[.!?。])\s+/).map((l) => l.trim()).filter((l) => l.replace(/[-*•·\s]/g, "").length > 1);
    const safe = lines.filter((l) => !SENS.test(l));
    const decisions = safe.filter((l) => DECIDE.test(l)).map((l) => l.replace(/^\s*(?:[-*•·▶]|\d{1,2}[.)])\s+/, "").replace(/[.]+$/, "")).slice(0, 20);
    const actions = [];
    safe.forEach((l) => {
      if (!ACTION.test(l) || /(했어요|했습니다|완료|끝났)/.test(l) && !/기로/.test(l)) return;
      const title = titleOf(l);
      if (title.length < 3 || actions.some((a) => a.title === title)) return;
      actions.push({ title, role: roleOfText(l), due: dueOf(l, ref) });
    });
    const lead = safe.filter((l) => !actions.some((a) => a.title === titleOf(l))).slice(0, 2).join(" ");
    const summary = `${lead ? lead + " " : ""}결정 ${decisions.length}건, 액션 아이템 ${actions.length}건.${lines.length > safe.length ? " 민감할 수 있는 문장은 정리에서 뺐습니다." : ""}`;
    return { url: m.url, note, summary: summary.slice(0, 1500), decisions, actions: actions.slice(0, 30), engine: "자동 정리" };
  }
  function weeklyDraft(role, name) {
    const now = new Date(); const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
    const mine = S.data.tasks.filter((r) => (name ? (r["담당자"] || "") === name || (!r["담당자"] && r["담당 역할"] === role) : r["담당 역할"] === role));
    const touched = (r) => { const t = Date.parse(r["수정"] || r["생성"] || ""); return !isNaN(t) && t >= monday.getTime(); };
    const line = (r) => `- ${r["할 일"]}${r["프로젝트"] && r["프로젝트"] !== "미분류" ? ` (${r["프로젝트"]})` : ""}${r["마감"] ? ` · 마감 ${String(r["마감"]).slice(5).replace("-", "/")}` : ""}`;
    const done = mine.filter((r) => statusOf(r) === "완료" && touched(r));
    const doing = mine.filter((r) => ["진행", "검토 요청", "대기"].includes(statusOf(r)));
    const blocked = mine.filter((r) => statusOf(r) === "막힘");
    const sect = (title, rows, extra) => [title, ...(rows.length ? rows.slice(0, 6).map((r) => line(r) + (extra ? extra(r) : "")) : ["- 기록 없음"])].join("\n");
    return [
      "ODD HR 작성 초안. 고쳐서 제출하세요.",
      `${name || role} · ${monday.getMonth() + 1}/${monday.getDate()} 주`,
      "",
      sect("끝낸 것", done),
      "",
      sect("진행 중인 것", doing, (r) => ` · ${statusOf(r)}`),
      "",
      sect("막힌 것", blocked, () => " · 필요한 도움: (적어 주세요)")
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

  // 다른 사람이 저장해도 입력 중인 칸이 지워지지 않게, 입력 중엔 다시 그리기를 미룬다
  let deferred = false;
  const editing = () => {
    const a = document.activeElement;
    if (document.querySelector("#main .dp-pop:not([hidden])")) return true;
    return !!(a && a.closest && a.closest("#main") && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.closest("form, .dp")));
  };
  function paint() {
    if (editing()) { deferred = true; renderMenu(); return; }
    render();
  }
  document.addEventListener("focusout", () => setTimeout(() => { if (deferred && !editing()) { deferred = false; render(); } }, 0));

  function useExample(note) { S.data = exampleData(); S.mode = "example"; S.note = note || ""; render(); }
  const strip = (o) => { const c = { ...o }; delete c.url; return c; };

  async function updatePage(row, props) {
    if (S.mode !== "live" || !S.db) { Object.assign(row, props); return; }
    if (S.canWrite === false) throw { code: "invalid_argument" };
    await S.db.collection(S.keyOf(row)).doc(row.url).update({ ...strip(props), "수정": new Date().toISOString() });
    Object.assign(row, props);
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
    server_not_connected: "이 PC에는 카톡 에이전트가 없습니다. 카톡 점검은 PM의 Windows PC에 설치한 ODD HR 앱에서 돕니다.",
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
      S.flash[key] = { ok: true, text: S.mode === "live" ? okText : `${okText} (예시라 저장되지 않음)` };
      S.clearDrafts = true;
    } catch (e) {
      S.flash[key] = { ok: false, text: errText(e) };
    } finally { S.busy = false; render(); }
  }
  const flashEl = (key) => S.flash[key] ? h("div", { class: "msg " + (S.flash[key].ok ? "ok" : "err"), text: S.flash[key].text }) : null;

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
      h("p", { class: "sub", text: "긴급도 순입니다. 눌러서 작업 화면에서 처리하세요." }),
      props.length ? h("div", { class: "rows" }, props.slice(0, 5).map((r) => h("button", { class: "row", type: "button", onclick: () => { S.sel.task = r.url; go("tasks"); } },
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
      quickBox(),
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
    const list = proposals().filter(roleOk).filter(projOk);
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
        act("task", () => updatePage(cur, Object.assign({ "상태": "진행" }, isRisk ? { "승인 이유": reason.trim() } : {})), "작업을 시작했습니다. 할 일에서 이어서 볼 수 있습니다.");
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
          h("dt", { text: "확신도" }), h("dd", { text: cur["확신도"] || "—" })),
        h("div", { class: "field" }, "제안 이유", h("div", { class: "quote", text: cur["근거 메시지"] || "근거 메시지가 없습니다." })),
        S.risk === cur.url ? h("label", { class: "field" }, "승인 이유 (외부 발송, 일정 변경, 범위 축소는 이유를 남깁니다)", h("input", { id: "riskReason", placeholder: "예: 교수님 확인 끝난 시사본이라 보내도 됨" })) : null,
        S.dismiss === cur.url ? h("label", { class: "field" }, "내 일이 아닌 이유 (같은 유형이 반복되면 카톡 점검 규칙에 반영합니다)", h("input", { id: "dismissReason", placeholder: "예: 잡담에서 나온 말" })) : null,
        h("div", { class: "actions" },
          S.dismiss === cur.url
            ? [h("button", { class: "btn primary", type: "button", disabled: S.busy, text: "내 일 아님으로 넘기기", onclick: () => { const v = ($("dismissReason") || {}).value || ""; act("task", () => updatePage(cur, { "상태": "기각", "기각 사유": v.trim() || "사유 없음" }), "내 일 아님으로 넘겼습니다."); S.dismiss = null; } }),
               h("button", { class: "btn", type: "button", text: "취소", onclick: () => { S.dismiss = null; render(); } })]
            : [h("button", { class: "btn accent", type: "button", disabled: S.busy, text: S.risk === cur.url ? "이유 적고 작업 시작" : "작업 시작", onclick: startTask }),
               h("button", { class: "btn", type: "button", disabled: S.busy, text: "이미 처리함", onclick: () => act("task", () => updatePage(cur, { "상태": "완료" }), "완료로 기록했습니다.") }),
               h("button", { class: "btn danger", type: "button", disabled: S.busy, text: "내 일 아님", onclick: () => { S.dismiss = cur.url; S.risk = null; render(); } })],
          null),
        flashEl("task"));
    }

    const create = h("section", { class: "box" },
      h("h2", {}, "직접 작업 만들기"),
      h("form", { class: "form", onsubmit: (e) => {
        e.preventDefault();
        const f = e.target, title = f.ntitle.value.trim();
        if (!title) { S.flash.create = { ok: false, text: "할 일을 적어 주세요." }; render(); return; }
        const p = { "할 일": title, "상태": "대기", "프로젝트": f.nproj.value, "담당 역할": f.nrole.value, "긴급도": f.nlvl.value, "출처": "직접 입력", "작성": "사람 작성" };
        if (f.ndue.value) { p["마감"] = f.ndue.value }
        act("create", () => createPages("tasks", [p]), "할 일로 추가했습니다.");
      } },
        h("label", { class: "field wide" }, "할 일", h("input", { id: "ntitle", name: "ntitle", placeholder: "예: 촬영 장비 대여 신청하기" })),
        h("label", { class: "field" }, "프로젝트", h("select", { id: "nproj", name: "nproj" }, projOptions())),
        h("label", { class: "field" }, "담당 역할", h("select", { id: "nrole", name: "nrole" }, ROLES.map((p) => h("option", { value: p, text: p })))),
        h("label", { class: "field" }, "긴급도", h("select", { id: "nlvl", name: "nlvl" }, LEVELS.map((p) => { const o = h("option", { value: p, text: p }); if (p === "보통") o.selected = true; return o; }))),
        dateField("ndue", "마감", { placeholder: "마감 없음" }),
        h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit", disabled: S.busy, text: "추가" }))),
      flashEl("create"));

    const routines = h("section", { class: "box" }, h("h2", {}, "반복 작업"),
      h("p", { class: "sub", text: "추가 비용이 들지 않습니다. 카톡 점검은 PM의 Windows PC에서 ODD HR 앱이 돌리고, 나머지는 앱이 바로 계산합니다." }),
      h("div", { class: "rows" },
        [["3분마다", "카톡 점검", "PM PC가 지정 대화방을 읽고 할 일 후보를 골라 둡니다. Desk를 열어 두면 자동으로 가져옵니다"], ["언제든", "주간 업데이트 초안", "할 일 화면 아래에서 역할을 고르면 바로 만들어집니다"]].map((x) =>
          h("div", { class: "row" }, h("span", { class: "dday", text: x[0] }), h("div", {}, h("div", { class: "t", text: x[1] }), h("div", { class: "m", text: x[2] })), h("span")))));

    return [pageHead("작업", "ODD HR이 찾은 일입니다. 작업 시작, 이미 처리함, 내 일 아님 중 하나를 고르세요.", checkNowBtn()), h("div", { class: "split" }, left, right), h("div", { class: "grid2" }, create, routines)];
  }

  // ---------- 할 일 ----------
  const NEXT = { "대기": "진행", "진행": "검토 요청", "검토 요청": "완료", "막힘": "진행", "완료": "진행" };
  const CHECK = { "대기": "", "진행": "진행", "검토 요청": "검토", "막힘": "막힘", "완료": "완료" };
  function viewTodo() {
    const groups = ["막힘", "검토 요청", "진행", "대기"].concat(S.filter.showDone ? ["완료"] : []);
    const all = S.data.tasks.filter((r) => groups.includes(statusOf(r))).filter(roleOk).filter(projOk)
      .sort((a, b) => (dday(a["마감"]) ?? 999) - (dday(b["마감"]) ?? 999));
    const box = h("section", { class: "box" }, filterBar(true));
    if (!all.length) box.appendChild(h("div", { class: "empty", text: "조건에 맞는 할 일이 없습니다. 작업 화면에서 제안을 시작하면 여기에 들어옵니다." }));
    groups.forEach((g) => {
      const items = all.filter((r) => statusOf(r) === g);
      if (!items.length) return;
      box.appendChild(h("div", { class: "group-title" }, g, h("span", { text: String(items.length) })));
      box.appendChild(h("div", { class: "rows" }, items.map((r) => {
        // 팀원은 '검토 요청'까지만 올린다. 완료 처리, 다시 열기, 삭제는 PM만 한다.
        const next = NEXT[g];
        const canMove = S.isPM || (next !== "완료" && g !== "완료");
        const delAsk = S.confirmDel === r.url;
        return h("div", { class: "row" + (delAsk ? " confirm" : "") },
          h("button", { class: "check " + CHECK[g], type: "button", disabled: S.busy || !canMove,
            title: canMove ? `${g}에서 ${next}(으)로` : "PM 승인 대기 중", "aria-label": canMove ? `${r["할 일"]}: ${g}에서 ${next}(으)로 바꾸기` : `${r["할 일"]}: PM 승인 대기 중`,
            onclick: () => act("todo", () => updatePage(r, { "상태": next, ...(next === "완료" ? { "완료 처리": "PM", "완료일": new Date().toISOString() } : {}) }), `${next}(으)로 바꿨습니다.`) }),
          h("div", {}, h("div", { class: "t", text: r["할 일"] || "(제목 없음)" }), taskMeta(r),
            delAsk ? h("div", { class: "msg err", text: "삭제하면 되돌릴 수 없습니다. 끝난 일이면 삭제 대신 완료 처리를 권합니다." }) : null),
          h("div", { class: "actions" },
            delAsk ? [
              h("button", { class: "btn small danger", type: "button", disabled: S.busy, text: "삭제", onclick: () => { S.confirmDel = null; act("todo", () => removeTask(r), "삭제했습니다."); } }),
              h("button", { class: "btn small", type: "button", text: "취소", onclick: () => { S.confirmDel = null; render(); } })
            ] : [
              S.isPM && g !== "완료" ? h("button", { class: "btn small primary", type: "button", disabled: S.busy, text: g === "검토 요청" ? "승인" : "완료", title: "PM만 완료 처리할 수 있습니다",
                onclick: () => act("todo", () => updatePage(r, { "상태": "완료", "완료 처리": "PM", "완료일": new Date().toISOString() }), g === "검토 요청" ? "승인해 완료했습니다." : "완료 처리했습니다.") }) : null,
              !S.isPM && g === "검토 요청" ? h("span", { class: "pill", text: "PM 승인 대기" }) : null,
              g !== "막힘" && g !== "완료" ? h("button", { class: "btn small", type: "button", disabled: S.busy, text: "막힘", onclick: () => act("todo", () => updatePage(r, { "상태": "막힘" }), "막힘으로 표시했습니다. PM 홈의 불씨에 올라갑니다.") }) : null,
              S.isPM && g === "완료" ? h("button", { class: "btn small", type: "button", disabled: S.busy, text: "다시 열기", onclick: () => act("todo", () => updatePage(r, { "상태": "진행" }), "다시 진행 중으로 바꿨습니다.") }) : null,
              S.isPM ? h("button", { class: "btn small danger", type: "button", disabled: S.busy, text: "삭제", "aria-label": `${r["할 일"]} 삭제`, onclick: () => { S.confirmDel = r.url; render(); } }) : null
            ]));
      })));
    });
    const fl = flashEl("todo"); if (fl) box.appendChild(fl);
    const wk = S.weekly || { role: S.filter.role !== "전체" ? S.filter.role : "편집", name: "", text: "" };
    const weekly = h("section", { class: "box" },
      h("h2", {}, "주간 업데이트 초안"),
      h("p", { class: "sub", text: "이번 주 상태 변화로 초안을 만듭니다. 본인이 고쳐서 제출하세요." }),
      h("div", { class: "form" },
        h("label", { class: "field" }, "역할", h("select", { id: "wkrole", onchange: (e) => { S.weekly = { ...wk, role: e.target.value }; } }, ROLES.filter((r) => r !== "미정").map((r) => { const o = h("option", { value: r, text: r }); if (r === wk.role) o.selected = true; return o; }))),
        h("label", { class: "field" }, "이름 (비우면 역할 전체)", h("input", { id: "wkname", value: wk.name, placeholder: "예: 홍길동" })),
        h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", text: "초안 만들기", onclick: () => { const role = $("wkrole").value, name = $("wkname").value.trim(); S.weekly = { role, name, text: weeklyDraft(role, name) }; render(); } }))),
      wk.text ? h("label", { class: "field" }, "초안", h("textarea", { id: "wktext", value: wk.text, style: "min-height:220px" })) : null,
      wk.text ? h("div", { class: "actions" }, h("button", { class: "btn", type: "button", text: "복사", onclick: async (e) => {
        const ta = $("wktext"); try { await navigator.clipboard.writeText(ta.value); e.target.textContent = "복사했습니다"; } catch (err) { ta.focus(); ta.select(); e.target.textContent = "선택했습니다. Ctrl+C로 복사하세요"; }
      } })) : null);
    return [pageHead("할 일", S.isPM ? "동그라미를 누르면 대기, 진행, 검토 요청, 완료 순으로 넘어갑니다. 완료 처리와 삭제는 PM만 보입니다." : "동그라미를 누르면 대기, 진행, 검토 요청 순으로 넘어갑니다. 완료 처리는 PM이 합니다."), box, weekly];
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
              const props = { "진행률": v, "상태": v >= 1 ? "완료" : (g["상태"] === "보류" ? "보류" : "진행 중") };
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
        h("label", { class: "field" }, "노트", h("textarea", { id: "mnote", placeholder: "회의 중 나온 말을 한 줄에 하나씩 적으세요. 예: 엔딩 10초 줄이기로 함 (편집) / 폰트 라이선스 금요일까지 확인 (디자인)", value: cur["노트"] || "" })),
        h("div", { class: "actions" },
          h("button", { class: "btn", type: "button", disabled: S.busy, text: "노트 저장", onclick: () => act("meet", () => updatePage(cur, { "노트": $("mnote").value }), "노트를 저장했습니다.") }),
          h("button", { class: "btn accent", type: "button", disabled: S.busy, text: "자동 정리", title: "규칙으로 결정 사항과 액션 아이템을 고릅니다. 추가 비용이 들지 않습니다.", onclick: () => { const v = $("mnote").value; if (!v.trim()) { S.aiState = "노트가 비어 있습니다. 먼저 노트를 적어 주세요."; render(); return; } S.ai = autoSummarize(cur, v); S.aiState = "done"; render(); } }),
          S.sample ? h("button", { class: "btn", type: "button", disabled: S.busy || S.aiState === "thinking", text: S.aiState === "thinking" ? "요약하는 중" : "AI 요약 (Claude 사용)", onclick: () => summarize(cur, $("mnote").value) }) : null),
        h("div", { class: "msg", style: "color:var(--muted)", text: "자동 정리는 노트 문장에서 결정 사항과 액션 아이템을 골라 줍니다. 고른 것은 작업 제안으로 올릴 수 있습니다." }),
        S.aiState && S.aiState !== "thinking" && S.aiState !== "done" ? h("div", { class: "msg err", text: S.aiState }) : null,
        ai ? h("div", { class: "detail" },
          h("div", { class: "field" }, ai.engine === "자동 정리" ? "자동 정리 (노트 문장을 골라 붙인 것)" : "AI 요약", h("div", { class: "quote", text: ai.summary || "—" })),
          ai.decisions.length ? h("div", { class: "field" }, "결정 사항", h("ul", { style: "margin:0;padding-left:18px" }, ai.decisions.map((d) => h("li", { text: d })))) : null,
          h("div", { class: "field" }, "액션 아이템 (체크한 것을 작업 제안으로 올립니다)",
            ai.actions.length ? h("div", { class: "rows" }, ai.actions.map((a, i) => h("label", { class: "row" },
              h("input", { type: "checkbox", id: `act-${i}`, checked: true }),
              h("div", {}, h("div", { class: "t", text: a.title }), h("div", { class: "m" }, h("span", { class: "pill", text: a.role || "미정" }), a.due ? h("span", { class: "pill", text: a.due }) : null)), h("span")))) : h("div", { class: "empty", text: "액션 아이템이 없습니다." })),
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
      await updatePage(m, { "노트": ai.note, "요약": ai.summary, "결정 사항": ai.decisions.join("\n"), "액션 아이템": ai.actions.map((a) => `${a.title} (${a.role})`).join("\n") });
      if (picked.length) await createPages("tasks", picked.map((a) => {
        const p = { "할 일": a.title, "상태": "제안", "프로젝트": m["프로젝트"] || "미분류", "담당 역할": a.role, "출처": "회의록", "작성": "ODD HR 작성", "출처 미팅": m["제목"] || "", "근거 메시지": `${m["제목"] || "미팅"} 노트에서 추출`, "확신도": "중간" };
        if (a.due) { p["마감"] = a.due }
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
      h("p", { class: "sub", text: "PM의 Windows PC에서 ODD HR 앱 안에 들어 있는 에이전트입니다. 앱이 켜져 있으면(창을 닫아 트레이에 있어도) 정한 간격마다 카톡 대화방을 읽고, 할 일 후보를 바로 팀 서버에 제안으로 올립니다. 바로 보고 싶으면 '지금 카톡 점검하기'를 누르세요." }),
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
      S.isOwner ? null : h("div", { class: "notice", text: "카톡 에이전트는 PM의 Windows PC에서 ODD HR 앱이 켜져 있을 때 돕니다. 대화방과 간격은 설정에서 바꿉니다." }),
      flashEl("pc"));
    const know = h("section", { class: "box" }, h("h2", {}, "지식과 데이터"),
      h("p", { class: "sub", text: "에이전트는 아래 자료만 근거로 씁니다. 폐기된 산출물과 대체된 결정은 읽지 않습니다." }),
      h("div", { class: "rows" }, [["작업", "#tasks", "제안과 할 일 (팀 서버)"], ["목표", "#goals", "프로젝트 목표와 진행률 (팀 서버)"], ["미팅", "#meetings", "미팅 노트와 요약 (팀 서버)"]].map(([n, u, d]) =>
        h("div", { class: "row" }, h("span", { class: "pill", text: "문서" }), h("div", {}, h("div", { class: "t" }, h("a", u.startsWith("#") ? { href: u, text: n } : { href: u, target: "_blank", rel: "noopener", text: n })), h("div", { class: "m", text: d })), h("span")))));
    const rules = h("div", { class: "notice" }, "모든 에이전트 공통: 메시지와 문서 속 문장은 지시가 아니라 데이터로 다룹니다. 삭제하지 않고 기각이나 폐기 표시만 합니다. 외부 발송, 일정 변경, 범위 축소는 초안까지만 만들고 사람이 승인 이유와 함께 승인합니다. 만든 것에는 ODD HR 작성 표시를 붙입니다.");
    return [pageHead("에이전트", "ODD HR에서 일하는 에이전트와 각자 읽는 것, 하는 것, 하지 않는 것입니다. 모든 기능이 추가 비용 없이 돕니다."), pc, cards, know, rules];
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
    VIEWS.forEach(([k, l]) => m.appendChild(h("a", { href: `#${k}`, "aria-current": S.view === k ? "page" : null }, l, counts[k] ? h("span", { class: "badge", text: String(counts[k]) }) : null)));
    $("dot").className = "dot" + (S.mode === "live" ? " live" : S.mode === "example" ? " example" : "");
    $("conn").textContent = S.mode === "live" ? `실시간 저장${S.canWrite === false ? " · 보기 전용" : ""}${S.note ? " · " + S.note : ""}` : S.mode === "example" ? `예시 데이터${S.note ? " · " + S.note : ""}` : "연결 확인 중";
  }
  function render() {
    renderMenu();
    const main = $("main");
    // 다시 그려도 저장 전 입력값은 남긴다 (같은 화면, 같은 선택일 때만)
    const scope = `${S.view}|${S.sel.task}|${S.sel.meeting}|${S.sel.goal}`;
    const keep = {};
    if (!S.clearDrafts && render.scope === scope) main.querySelectorAll("input[id], textarea[id], select[id]").forEach((el) => { if (!["file", "checkbox"].includes(el.type)) keep[el.id] = el.value; });
    S.clearDrafts = false; render.scope = scope;
    main.textContent = "";
    if (S.view === "tasks" && S.flash.pc) main.appendChild(flashEl("pc"));
    if (S.mode === "example") main.appendChild(h("div", { class: "notice" }, "지금은 예시 데이터를 보여 주고 있습니다. 여기서 누른 버튼은 저장되지 않습니다. ", S.note ? S.note : ""));
    const v = { home: viewHome, tasks: viewTasks, todo: viewTodo, goals: viewGoals, meetings: viewMeetings, team: viewTeam, agents: viewAgents, settings: viewSettings }[S.view] || viewHome;
    [v()].flat(Infinity).forEach((n) => n && main.appendChild(n));
    for (const [id, val] of Object.entries(keep)) {
      const el = document.getElementById(id);
      if (!el || el.value === val) continue;
      if (el.__dpSet) el.__dpSet(val); else el.value = val;
    }
  }
  function go(view) { if (location.hash !== `#${view}`) location.hash = view; else { S.view = view; render(); } }
  function fromHash() { const k = location.hash.replace("#", ""); S.view = VIEWS.some(([v]) => v === k) ? k : "home"; render(); window.scrollTo(0, 0); }
  window.addEventListener("hashchange", fromHash);

  $("refresh").addEventListener("click", () => {
    if (!S.db) { render(); return; }
    S.note = "다시 불러오는 중"; renderMenu(); subscribe();
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
