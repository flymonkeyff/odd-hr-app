/* ODD HR 앱 연결부
 *  - 팀 서버(Supabase) 연결, 첫 실행 코드 입력, PM 로그인과 프로젝트 만들기
 *  - 화면(desk.js)이 쓰는 저장소 인터페이스를 서버 위에 구현 (claude.use("db") 형태 유지)
 *  - PC 카톡 에이전트 연결 (Windows PM)
 *  - 화면 설정 (라이트/다크, 키 컬러)
 */
(() => {
  "use strict";
  const native = window.oddhr || {};
  // 데스크톱 앱은 메인 프로세스가, 웹(아이폰·아이패드)은 config.js가 서버 정보를 준다
  const cfg = (native.config && native.config()) || window.ODDHR_WEB_CONFIG || {};
  const ROLES_JOIN = ["기획", "디자인", "촬영", "편집", "PM"];

  // ---------------------------------------------------------------- 화면 설정
  const PREF_KEY = "oddhr.prefs";
  const PRESETS = [["ODD 주황", "#F15524"], ["블루", "#007AFF"], ["인디고", "#5856D6"], ["그린", "#34C759"], ["핑크", "#FF2D55"], ["틸", "#30B0C7"], ["그래파이트", "#636366"]];
  const readPrefs = () => { try { return { theme: "system", accent: "#F15524", ...(JSON.parse(localStorage.getItem(PREF_KEY) || "{}")) }; } catch (e) { return { theme: "system", accent: "#F15524" }; } };
  let prefs = readPrefs();
  const validHex = (v) => /^#[0-9a-fA-F]{6}$/.test(v || "");
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function applyPrefs() {
    const root = document.documentElement;
    if (prefs.theme === "light" || prefs.theme === "dark") root.setAttribute("data-theme", prefs.theme); else root.removeAttribute("data-theme");
    const accent = validHex(prefs.accent) ? prefs.accent : "#F15524";
    root.style.setProperty("--blue", accent);
    // 강조색 위 글자: 밝은 색이면 검정, 어두우면 흰색
    root.style.setProperty("--on-accent", luminance(accent) > 0.45 ? "#111111" : "#ffffff");
    if (native.setTheme) native.setTheme(prefs.theme);
  }
  applyPrefs();
  // Mac 앱: 창 왼쪽 위 신호등 버튼(닫기·최소화·확대) 자리만큼 메뉴를 내리고, 위쪽을 잡아 끌 수 있게
  if (cfg.platform === "darwin") document.documentElement.classList.add("mac-app");

  // ---------------------------------------------------------------- 서버
  const hasSdk = typeof window.supabase !== "undefined" && window.supabase.createClient;
  const sb = cfg.url && cfg.anonKey && hasSdk ? window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "oddhr-auth", flowType: "pkce", detectSessionInUrl: true },
    realtime: { params: { eventsPerSecond: 10 } }
  }) : null;

  const App = {
    ready: null, session: null, uid: null, isAnon: false, email: null,
    projects: [], members: [], codes: {}, currentProject: null,
    listeners: new Set(),
    presets: PRESETS,
    get prefs() { return { ...prefs }; },
    setPrefs(p) { prefs = { ...prefs, ...p }; try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} applyPrefs(); App.emit(); },
    onChange(fn) { App.listeners.add(fn); return () => App.listeners.delete(fn); },
    emit() { App.listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); },
    platform: cfg.platform || "", version: cfg.version || "", serverUrl: cfg.url || "",
    agentAvailable: !!cfg.agentAvailable,
    webUrl: cfg.webUrl || "",
    openAtLogin: !!cfg.openAtLogin,
    setLoginItem: native.setLoginItem ? (on) => native.setLoginItem(on) : null
  };
  window.oddhrApp = App;

  const friendly = (e) => {
    const msg = (e && (e.message || e.error_description || e.msg)) || String(e || "");
    if (/Failed to fetch|NetworkError|fetch failed|ENOTFOUND/i.test(msg)) return "서버에 닿지 않습니다. 인터넷 연결을 확인하세요.";
    if (/Invalid login credentials/i.test(msg)) return "이메일이나 비밀번호가 맞지 않습니다.";
    if (/Email not confirmed/i.test(msg)) return "메일함에서 확인 링크를 누른 뒤 다시 로그인하세요.";
    if (/Anonymous sign-ins are disabled/i.test(msg)) return "서버에서 '익명 로그인'이 꺼져 있습니다. PM에게 설정 안내의 2단계를 확인해 달라고 하세요.";
    if (/User already registered/i.test(msg)) return "이미 있는 계정입니다. 로그인을 누르세요.";
    if (/Password should be/i.test(msg)) return "비밀번호는 6자 이상이어야 합니다.";
    if (/docs_collection_check|Bucket not found/i.test(msg)) return "팀 서버가 예전 버전입니다. PM이 서버 업데이트를 한 번 실행해야 합니다 (설치 안내의 '서버 업데이트').";
    if (/maximum allowed size|Payload too large|too large/i.test(msg)) return "50MB가 넘는 파일은 올릴 수 없습니다. 구글 드라이브 등에 올리고 링크로 등록하세요.";
    if (/already been registered|already registered/i.test(msg)) return "이미 쓰는 이메일입니다.";
    if (/row-level security/i.test(msg)) return "권한이 없습니다.";
    return msg.replace(/^.*?:\s*/, "") || "알 수 없는 오류가 났습니다.";
  };
  const asErr = (e) => ({ code: "local", message: friendly(e) });
  const isPM = (pid) => App.members.some((m) => m.project_id === pid && m.user_id === App.uid && m.is_pm);
  App.isPM = isPM;
  App.isPMAny = () => App.members.some((m) => m.user_id === App.uid && m.is_pm);
  App.myMember = (pid) => App.members.find((m) => m.project_id === pid && m.user_id === App.uid) || null;
  App.projectName = (pid) => (App.projects.find((p) => p.id === pid) || {}).name || "";
  App.projectId = (name) => (App.projects.find((p) => p.name === name) || {}).id || null;

  async function loadProjects() {
    const [{ data: ps, error: e1 }, { data: ms, error: e2 }] = await Promise.all([
      sb.from("projects").select("*").order("created_at"),
      sb.from("members").select("*")
    ]);
    if (e1 || e2) throw e1 || e2;
    App.projects = (ps || []).filter((p) => !p.archived);
    App.members = ms || [];
    const saved = localStorage.getItem("oddhr.project");
    App.currentProject = App.projects.some((p) => p.id === saved) ? saved : (App.projects[0] || {}).id || null;
    const pmProjects = App.projects.filter((p) => isPM(p.id));
    App.codes = {};
    if (pmProjects.length) {
      const { data: cs } = await sb.from("project_codes").select("*").eq("revoked", false);
      (cs || []).forEach((c) => { App.codes[c.project_id] = c.code; });
    }
  }
  App.setCurrentProject = (pid) => { App.currentProject = pid; try { localStorage.setItem("oddhr.project", pid); } catch (e) {} App.emit(); };

  // ---------------------------------------------------------------- 프로젝트·멤버 기능
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw asErr(error); return data; };
  App.createProject = async ({ name, myName, deadline, label }) => {
    const r = await rpc("create_project", { p_name: name, p_my_name: myName, p_deadline: deadline || null, p_label: label || null });
    await loadProjects(); App.setCurrentProject(r.project_id); return r;
  };
  App.joinProject = async ({ code, name, role }) => {
    const r = await rpc("join_project", { p_code: code, p_name: name, p_role: role });
    await loadProjects(); App.setCurrentProject(r.project_id); return r;
  };
  App.newCode = async (pid) => { const c = await rpc("new_project_code", { p_project: pid }); App.codes[pid] = c; App.emit(); return c; };
  App.closeCode = async (pid) => { await rpc("close_project_code", { p_project: pid }); delete App.codes[pid]; App.emit(); };
  App.removeMember = async (pid, uid) => { await rpc("remove_member", { p_project: pid, p_user: uid }); await loadProjects(); App.emit(); };
  App.transferMember = async (pid, from, to) => { await rpc("transfer_member", { p_project: pid, p_from: from, p_to: to }); await loadProjects(); App.emit(); };
  App.updateMember = async (pid, uid, patch) => {
    const { data, error } = await sb.from("members").update(patch).eq("project_id", pid).eq("user_id", uid).select();
    if (error) throw asErr(error);
    if (!data || !data.length) throw { code: "local", message: "고칠 권한이 없습니다." };
    const i = App.members.findIndex((m) => m.project_id === pid && m.user_id === uid);
    if (i >= 0) App.members[i] = data[0];
    App.emit();
  };
  App.updateProject = async (pid, patch) => {
    const { data, error } = await sb.from("projects").update(patch).eq("id", pid).select();
    if (error) throw asErr(error);
    if (!data || !data.length) throw { code: "local", message: "PM만 프로젝트를 고칠 수 있습니다." };
    const i = App.projects.findIndex((p) => p.id === pid); if (i >= 0) App.projects[i] = data[0];
    App.emit();
  };
  App.signOut = async () => { await sb.auth.signOut(); try { localStorage.removeItem("oddhr.project"); } catch (e) {} location.reload(); };
  App.saveServer = (url, anonKey) => native.saveConfig ? native.saveConfig({ url, anonKey }) : false;
  // 서버 주소와 공개 키를 한 줄로 (설치 파일에 서버가 안 들어 있을 때 PM이 팀원에게 같이 준다)
  App.connectionString = () => cfg.url && cfg.anonKey ? "ODDHR1." + btoa(unescape(encodeURIComponent(JSON.stringify({ u: cfg.url, k: cfg.anonKey })))).replace(/=+$/, "") : "";
  const parseConnection = (s) => { try { const m = String(s || "").trim().match(/^ODDHR1\.([A-Za-z0-9+/_-]+)$/); if (!m) return null; const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))))); return j.u && j.k ? { url: j.u, anonKey: j.k } : null; } catch (e) { return null; } };

  // ---------------------------------------------------------------- 저장소 (desk.js가 쓰는 모양)
  const rows = new Map();               // id → {id, project_id, collection, data, owner}
  const subs = [];                      // {collection, fn}
  const colName = (path) => (/^data\/users\//.test(path) ? "quick" : path);
  const ALL_COLS = ["tasks", "goals", "meetings", "flags", "quick", "messages", "files", "weekly"];
  const snap = (collection) => ({
    docs: [...rows.values()].filter((r) => r.collection === collection).map((r) => ({
      id: r.id, exists: true, metadata: { fromCache: false },
      data: () => ({ ...r.data, "프로젝트": App.projectName(r.project_id) || r.data["프로젝트"] || "", _owner: r.owner, _pid: r.project_id, _at: r.created_at })
    })),
    metadata: { fromCache: false }
  });
  let emitTimer = null;
  const pending = new Set();
  function emitCol(collection) {
    pending.add(collection);
    clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      const cols = [...pending]; pending.clear();
      subs.forEach((s) => { if (cols.includes(s.collection)) { try { s.fn(snap(s.collection)); } catch (e) { console.error(e); } } });
    }, 30);
  }
  const strip = (data) => { const d = { ...data }; delete d["프로젝트"]; delete d.url; Object.keys(d).forEach((k) => { if (k[0] === "_") delete d[k]; }); return d; };
  const pickProject = (data, fallback) => App.projectId(data && data["프로젝트"]) || fallback || App.currentProject || (App.projects[0] || {}).id;
  const newId = () => "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const cleanId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);

  async function loadDocs() {
    rows.clear();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("docs").select("id,project_id,collection,data,owner,updated_at").range(from, from + 999);
      if (error) throw error;
      (data || []).forEach((r) => rows.set(r.id, r));
      if (!data || data.length < 1000) break;
    }
    ALL_COLS.forEach(emitCol);
  }
  let channel = null;
  function listen() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("oddhr-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (p) => {
        if (p.eventType === "DELETE") { const old = rows.get(p.old.id); rows.delete(p.old.id); if (old) emitCol(old.collection); return; }
        const r = p.new; if (!r || !r.id) return;
        if (!App.projects.some((x) => x.id === r.project_id)) return;
        rows.set(r.id, r); emitCol(r.collection);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "members" }, async () => { try { await loadProjects(); App.emit(); } catch (e) {} })
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, async () => { try { await loadProjects(); App.emit(); } catch (e) {} })
      .subscribe((status) => { App.live = status === "SUBSCRIBED"; App.emit(); });
  }
  App.reload = async () => { await loadProjects(); await loadDocs(); App.emit(); };

  const db = {
    collection(path) {
      const collection = colName(path);
      return {
        onSnapshot(fn, onErr) {
          const s = { collection, fn }; subs.push(s);
          setTimeout(() => fn(snap(collection)), 0);
          return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
        },
        async add(data) { const id = newId(); await this.doc(id).set(data); return { id }; },
        doc(rawId) {
          const id = cleanId(rawId);
          return {
            id,
            async get() { const r = rows.get(id); return { id, exists: !!r, data: () => (r ? { ...r.data } : undefined) }; },
            async set(data) {
              const existing = rows.get(id);
              if (existing) {
                const { error } = await sb.from("docs").update({ data: strip(data) }).eq("id", id);
                if (error) throw asErr(error);
                return;
              }
              const row = { id, project_id: pickProject(data), collection, data: strip(data) };
              if (!row.project_id) throw { code: "local", message: "들어간 프로젝트가 없습니다. 설정에서 프로젝트 코드를 넣으세요." };
              const { data: got, error } = await sb.from("docs").insert(row).select();
              if (error) throw asErr(/duplicate key/i.test(error.message) ? { message: "이미 있는 문서입니다." } : error);
              if (got && got[0]) { rows.set(id, got[0]); emitCol(collection); }
            },
            async update(patch) {
              const r = rows.get(id);
              if (!r) throw { code: "local", message: "문서를 찾지 못했습니다." };
              let moveTo = null;
              if (patch && patch["프로젝트"] !== undefined) { const pid = App.projectId(patch["프로젝트"]); if (pid && pid !== r.project_id) moveTo = pid; }
              const p = strip(patch || {});
              const { error } = await sb.rpc("patch_doc", { p_id: id, p_patch: p, p_project: moveTo });
              if (error) throw asErr(error);
              rows.set(id, { ...r, project_id: moveTo || r.project_id, data: { ...r.data, ...p } }); emitCol(collection);
            },
            async delete() {
              const r = rows.get(id);
              const { data, error } = await sb.from("docs").delete().eq("id", id).select("id");
              if (error) throw asErr(error);
              if (!data || !data.length) throw { code: "local", message: "지울 권한이 없습니다 (PM만 지울 수 있습니다)." };
              rows.delete(id); if (r) emitCol(r.collection);
            }
          };
        }
      };
    }
  };
  App.db = db;

  // ---------------------------------------------------------------- 드라이브 파일 (저장소 버킷 oddhr, 경로: <프로젝트>/<문서 id>.<확장자>)
  const BUCKET = "oddhr";
  App.files = {
    max: 50 * 1024 * 1024,
    async upload(pid, path, file) {
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (error) throw asErr(error);
    },
    async blob(path) {
      const { data, error } = await sb.storage.from(BUCKET).download(path);
      if (error) throw asErr(error);
      return data;
    },
    async remove(path) {
      const { error } = await sb.storage.from(BUCKET).remove([path]);
      if (error) throw asErr(error);
    }
  };
  // 알림 (데스크톱 앱은 운영체제 알림, 웹은 화면 안 알림만)
  App.notify = (title, body) => {
    try {
      if (native.notify) { native.notify(title, body); return; }
      // 웹: 브라우저가 알림을 허용했을 때만 (아이폰 Safari는 화면 안 배지와 알림 칸으로만 보인다)
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState === "hidden") new Notification(title, { body, icon: "icons/icon-192.png" });
    } catch (e) {}
  };
  // ---------------------------------------------------------------- 구글 로그인과 Gmail (읽기 전용)
  // Supabase에 Google 로그인이 켜져 있어야 한다 (설치-안내.md의 'Google 연결'). 돌아올 주소는 웹 앱 주소.
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
  const back = () => (cfg.webUrl || (location.protocol === "https:" ? location.origin + location.pathname : "")).replace(/#.*$/, "");
  App.gmailAvailable = !!(cfg.url && (cfg.webUrl || location.protocol === "https:"));
  const GKEY = "oddhr.gmail";
  const keepToken = (session) => {
    if (!session || !session.provider_token) return;
    const exp = Date.now() + 55 * 60 * 1000;
    const ids = (session.user && session.user.identities) || [];
    const g = ids.find((i) => i.provider === "google");
    try { localStorage.setItem(GKEY, JSON.stringify({ t: session.provider_token, exp, email: (g && g.identity_data && g.identity_data.email) || "" })); } catch (e) {}
  };
  const readG = () => { try { const g = JSON.parse(localStorage.getItem(GKEY) || "null"); return g && g.exp > Date.now() ? g : null; } catch (e) { return null; } };
  App.gmailToken = () => (readG() || {}).t || "";
  App.gmailEmail = () => (readG() || {}).email || "";
  App.gmailForget = () => { try { localStorage.removeItem(GKEY); } catch (e) {} App.emit(); };
  async function oauthRun(getUrl) {
    const redirectTo = back();
    if (!redirectTo) throw { code: "local", message: "돌아올 웹 주소가 설정되지 않았습니다." };
    const { data, error } = await getUrl(redirectTo);
    if (error) throw asErr(/not enabled|Unsupported provider/i.test(error.message || "") ? { message: "팀 서버에서 Google 로그인이 아직 꺼져 있습니다. PM이 설치 안내의 'Google 연결'을 한 번 해야 합니다." } : /Manual linking is disabled/i.test(error.message || "") ? { message: "팀 서버에서 계정 연결(Manual linking)이 꺼져 있습니다. 설치 안내의 'Google 연결' 3단계를 확인하세요." } : error);
    if (!native.oauth) { location.href = data.url; return new Promise(() => {}); }        // 웹: 구글로 갔다가 돌아오면 아래 onAuthStateChange가 이어 받는다
    const r = await native.oauth(data.url, redirectTo);
    if (!r || !r.ok) throw { code: "local", message: (r && r.error) || "로그인하지 못했습니다." };
    const u = new URL(r.url), code = u.searchParams.get("code"), err = u.searchParams.get("error_description") || new URLSearchParams(u.hash.slice(1)).get("error_description");
    if (err) throw { code: "local", message: friendly({ message: err }) };
    if (!code) throw { code: "local", message: "구글에서 돌아온 값이 없습니다. 다시 시도하세요." };
    const { data: d2, error: e2 } = await sb.auth.exchangeCodeForSession(code);
    if (e2) throw asErr(e2);
    keepToken(d2.session);
    return d2.session;
  }
  App.gmailConnect = async () => {
    const opts = (redirectTo) => ({ provider: "google", options: { redirectTo, scopes: GMAIL_SCOPE, skipBrowserRedirect: true, queryParams: { access_type: "offline", prompt: "consent" } } });
    const ids = ((App.session && App.session.user && App.session.user.identities) || []).map((i) => i.provider);
    // 이미 구글로 들어온 계정이면 다시 로그인만, 아니면 지금 계정에 구글을 연결한다 (같은 사람으로 남는다)
    await oauthRun((redirectTo) => ids.includes("google") ? sb.auth.signInWithOAuth(opts(redirectTo)) : sb.auth.linkIdentity(opts(redirectTo)));
    App.emit();
  };
  App.googleLogin = async () => {
    const s2 = await oauthRun((redirectTo) => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo, scopes: GMAIL_SCOPE, skipBrowserRedirect: true } }));
    if (s2) { App.session = s2; await start(); }
  };
  if (sb && sb.auth.onAuthStateChange) sb.auth.onAuthStateChange((ev, session) => { if (session && session.provider_token) { keepToken(session); App.emit(); } });
  App.askNotify = async () => { try { if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission(); } catch (e) {} };
  // 코드로 들어온 계정에 이메일을 연결하면 다른 기기(아이폰, 아이패드, 다른 PC)에서 같은 사람으로 로그인할 수 있다
  App.linkEmail = async (email, password) => {
    const { data, error } = await sb.auth.updateUser({ email, password });
    if (error) throw asErr(error);
    const u = (data && data.user) || {};
    App.email = u.email || email; App.isAnon = false; App.emit();
  };

  // ---------------------------------------------------------------- claude.use 모양 (desk.js 호환)
  const user = {
    async id() { return App.uid; },
    async me() { return { id: App.uid, name: (App.myMember(App.currentProject) || {}).name || "" }; },
    async isOwner() { return App.isPMAny() && App.agentAvailable; },   // PC 에이전트를 쓰는 PM
    async canEdit() { return App.isPMAny(); },
    async can() { return true; },
    async profiles(ids) { const o = {}; ids.forEach((i) => { const m = App.members.find((x) => x.user_id === i); o[i] = { name: m ? m.name : "" }; }); return o; }
  };
  const mcp = App.agentAvailable ? {
    async callTool(server, tool, args) {
      const map = { odd_hr_status: ["status"], odd_hr_pending: ["pending", String((args && args.limit) || 200)], odd_hr_mark_synced: ["mark-synced", ...((args && args.ids) || [])], odd_hr_scan_now: ["scan", "앱"] };
      const cmd = map[tool]; if (!cmd) throw { code: "tool_error", message: "모르는 명령" };
      const out = await native.agent(cmd);
      if (!out || !out.ok) throw { code: "tool_error", message: (out && out.error) || "에이전트 오류" };
      return { payload: out.result };
    }
  } : null;
  App.agent = async (cmd) => { if (!App.agentAvailable) throw { code: "local", message: "이 PC에는 카톡 에이전트가 없습니다 (Windows PM 전용)." }; const out = await native.agent(cmd); if (!out || !out.ok) throw { code: "local", message: (out && out.error) || "에이전트 오류" }; return out.result; };

  let resolveReady;
  App.ready = new Promise((r) => { resolveReady = r; });
  window.claude = {
    use: async (name) => {
      if (name === "sample") return null;            // 앱에서는 Claude를 부르지 않는다
      await App.ready;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "mcp") return mcp;
      return null;
    }
  };

  // ---------------------------------------------------------------- 첫 화면 (게이트)
  const gate = document.createElement("div");
  gate.className = "gate";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-modal", "true");
  gate.setAttribute("aria-label", "ODD HR 시작");
  const el = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { if (v == null || v === false) return; if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v); });
    kids.flat().forEach((c) => c != null && c !== false && e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return e;
  };
  const LOGO = '<svg viewBox="0 0 201 128" aria-hidden="true"><circle cx="64" cy="64" r="64"/><path d="M106 0A64 64 0 0 1 106 128Z"/><path d="M169 8.57A64 64 0 0 1 169 119.43Z"/></svg>';
  function frame(title, sub, ...body) {
    gate.textContent = "";
    const logo = el("div", { class: "gate-logo" }); logo.innerHTML = LOGO + '<span>HR</span>';
    gate.appendChild(el("div", { class: "gate-card" }, logo, el("h1", { text: title }), sub ? el("p", { class: "gate-sub", text: sub }) : null, ...body));
    if (!gate.isConnected) document.body.appendChild(gate);
    const f = gate.querySelector("input, select, button"); if (f) f.focus();
  }
  const field = (label, input) => el("label", { class: "gate-field" }, el("span", { text: label }), input);
  const msgBox = () => el("p", { class: "gate-msg", role: "status", "aria-live": "polite" });
  const busy = (btn, on, text) => { btn.disabled = on; if (text) btn.textContent = text; };
  const roleSelect = (id) => el("select", { id }, ROLES_JOIN.map((r) => el("option", { value: r, text: r === "PM" ? "PM (보조)" : r })));

  function screenServer(note) {
    const url = el("input", { id: "g-url", placeholder: "https://abcd1234.supabase.co 또는 ODDHR1.로 시작하는 연결 문자열", value: cfg.url || "", autocomplete: "off", spellcheck: "false" });
    const key = el("input", { id: "g-key", placeholder: "eyJhbGciOi... (anon public 키)", value: cfg.anonKey || "", autocomplete: "off", spellcheck: "false" });
    const m = msgBox();
    const save = el("button", { class: "btn primary", type: "submit", text: "연결하기" });
    frame("팀 서버 연결", note || "PM에게 받은 연결 문자열(ODDHR1.…)을 첫 칸에 붙여 넣으세요. PM이라면 Supabase의 주소와 공개 키를 넣습니다. 설치 파일에 서버가 들어 있으면 이 화면은 나오지 않습니다.",
      el("form", { class: "gate-form", onsubmit: async (e) => {
        e.preventDefault();
        const conn = parseConnection(url.value);
        const u = conn ? conn.url : url.value.trim().replace(/\/+$/, ""), k = conn ? conn.anonKey : key.value.trim();
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(u) && !/^https:\/\/[^\s/]+$/.test(u)) { m.textContent = "주소는 https://로 시작해야 합니다."; return; }
        if (k.length < 40) { m.textContent = "공개 키가 너무 짧습니다. Supabase의 Project Settings → API의 anon public 키를 붙여 넣으세요."; return; }
        busy(save, true, "확인 중");
        try {
          const r = await fetch(u + "/auth/v1/settings", { headers: { apikey: k } });
          if (!r.ok) throw new Error(`서버가 응답하지 않습니다 (${r.status})`);
          App.saveServer(u, k); location.reload();
        } catch (err) { m.textContent = friendly(err); busy(save, false, "연결하기"); }
      } }, field("연결 문자열 또는 서버 주소", url), field("공개 키 (연결 문자열을 넣었으면 비워 두세요)", key), m, el("div", { class: "gate-actions" }, save)));
  }

  function screenWelcome() {
    const code = el("input", { id: "g-code", placeholder: "ODD-XXXX-XXXX", autocomplete: "off", spellcheck: "false", maxlength: "20" });
    code.addEventListener("input", () => { const raw = code.value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^ODD/, "").slice(0, 8); code.value = raw ? "ODD-" + raw.slice(0, 4) + (raw.length > 4 ? "-" + raw.slice(4) : "") : ""; });
    const name = el("input", { id: "g-name", placeholder: "예: 홍길동", autocomplete: "name", maxlength: "40" });
    const role = roleSelect("g-role");
    const m = msgBox();
    const go = el("button", { class: "btn primary", type: "submit", text: "들어가기" });
    frame("프로젝트 코드로 시작", "PM에게 받은 코드를 넣으면 그 프로젝트로 바로 들어갑니다.",
      el("form", { class: "gate-form", onsubmit: async (e) => {
        e.preventDefault();
        if (code.value.replace(/[^A-Z0-9]/g, "").length < 11) { m.textContent = "코드 8자리를 모두 넣으세요 (ODD-XXXX-XXXX)."; return; }
        if (!name.value.trim()) { m.textContent = "이름을 넣으세요. 팀원 탭과 할 일에 이 이름이 보입니다."; return; }
        busy(go, true, "들어가는 중");
        try {
          if (!App.session) {
            const { data, error } = await sb.auth.signInAnonymously();
            if (error) throw error;
            App.session = data.session;
          }
          await App.joinProject({ code: code.value, name: name.value.trim(), role: role.value });
          await start();
        } catch (err) { m.textContent = (err && err.message) ? friendly(err) : "들어가지 못했습니다."; busy(go, false, "들어가기"); }
      } }, field("프로젝트 코드", code), field("내 이름", name), field("내 역할", role), m, el("div", { class: "gate-actions" }, go)),
      el("div", { class: "gate-alt" }, el("span", { text: "PM이거나 이미 계정이 있나요?" }), el("button", { class: "linkish", type: "button", text: "이메일로 로그인", onclick: screenPmLogin })));
  }

  function screenPmLogin() {
    const email = el("input", { id: "g-email", type: "email", placeholder: "pm@example.com", autocomplete: "email" });
    const pw = el("input", { id: "g-pw", type: "password", placeholder: "6자 이상", autocomplete: "current-password" });
    const m = msgBox();
    const login = el("button", { class: "btn primary", type: "submit", text: "로그인" });
    const signup = el("button", { class: "btn", type: "button", text: "PM 계정 만들기" });
    signup.addEventListener("click", async () => {
      if (!email.value || pw.value.length < 6) { m.textContent = "이메일과 6자 이상 비밀번호를 넣으세요."; return; }
      busy(signup, true, "만드는 중");
      try {
        const { data, error } = await sb.auth.signUp({ email: email.value.trim(), password: pw.value });
        if (error) throw error;
        if (!data.session) { m.textContent = "확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 여기서 로그인하세요."; busy(signup, false, "PM 계정 만들기"); return; }
        App.session = data.session; await start();
      } catch (err) { m.textContent = friendly(err); busy(signup, false, "PM 계정 만들기"); }
    });
    frame("이메일로 로그인", "PM 계정이거나, 설정에서 이메일을 연결해 둔 팀원 계정으로 들어갑니다. 처음인 팀원은 이메일 없이 코드로 들어오면 됩니다.",
      el("form", { class: "gate-form", onsubmit: async (e) => {
        e.preventDefault();
        busy(login, true, "로그인 중");
        try {
          const { data, error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
          if (error) throw error;
          App.session = data.session; await start();
        } catch (err) { m.textContent = friendly(err); busy(login, false, "로그인"); }
      } }, field("이메일", email), field("비밀번호", pw), m, el("div", { class: "gate-actions" }, login, signup)),
      App.gmailAvailable ? el("div", { class: "gate-actions" }, el("button", { class: "btn google", type: "button", text: "Google로 계속", onclick: async (e) => { const b = e.currentTarget; busy(b, true, "구글 로그인 중"); try { await App.googleLogin(); } catch (err) { m.textContent = (err && err.message) || "로그인하지 못했습니다."; busy(b, false, "Google로 계속"); } } })) : null,
      el("div", { class: "gate-alt" }, el("button", { class: "linkish", type: "button", text: "← 코드로 시작하기", onclick: screenWelcome })));
  }

  function screenCreateProject(first) {
    const name = el("input", { id: "g-pname", placeholder: "예: 양천경찰서 영상", maxlength: "80" });
    const me = el("input", { id: "g-me", placeholder: "팀원에게 보일 이름", maxlength: "40" });
    const due = el("input", { id: "g-due", type: "date" });
    const label = el("input", { id: "g-label", placeholder: "예: 편집 완료, 접수 마감", maxlength: "40" });
    const m = msgBox();
    const go = el("button", { class: "btn primary", type: "submit", text: "프로젝트 만들기" });
    frame(first ? "첫 프로젝트 만들기" : "새 프로젝트", "만들면 팀원에게 나눠 줄 입장 코드가 바로 나옵니다.",
      el("form", { class: "gate-form", onsubmit: async (e) => {
        e.preventDefault();
        if (!name.value.trim() || !me.value.trim()) { m.textContent = "프로젝트 이름과 내 이름을 넣으세요."; return; }
        busy(go, true, "만드는 중");
        try { const r = await App.createProject({ name: name.value.trim(), myName: me.value.trim(), deadline: due.value, label: label.value.trim() }); screenCode(r.code, name.value.trim()); }
        catch (err) { m.textContent = (err && err.message) || "만들지 못했습니다."; busy(go, false, "프로젝트 만들기"); }
      } }, field("프로젝트 이름", name), field("내 이름", me), el("div", { class: "gate-row" }, field("마감일 (선택)", due), field("마감 이름 (선택)", label)), m, el("div", { class: "gate-actions" }, go)),
      el("div", { class: "gate-alt" }, el("button", { class: "linkish", type: "button", text: "로그아웃", onclick: () => App.signOut() })));
  }

  function screenCode(code, pname) {
    const copy = el("button", { class: "btn", type: "button", text: "코드 복사" });
    copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(code); copy.textContent = "복사했습니다"; } catch (e) { copy.textContent = "길게 눌러 선택하세요"; } });
    frame("팀원에게 코드를 나눠 주세요", `${pname} 입장 코드입니다. 팀원은 ODD HR을 설치하고 이 코드를 넣으면 들어옵니다. 설정의 팀원 탭에서 언제든 다시 보고 새로 발급할 수 있습니다.`,
      el("div", { class: "gate-code", text: code }),
      el("div", { class: "gate-actions" }, copy, el("button", { class: "btn primary", type: "button", text: "시작하기", onclick: () => start() })));
  }

  function screenError(text) {
    frame("연결하지 못했습니다", text, el("div", { class: "gate-actions" },
      el("button", { class: "btn primary", type: "button", text: "다시 시도", onclick: () => location.reload() }),
      el("button", { class: "btn", type: "button", text: "서버 바꾸기", onclick: () => screenServer() })));
  }

  async function start() {
    const { data: { session } } = await sb.auth.getSession();
    App.session = session;
    if (!session) { screenWelcome(); return; }
    App.uid = session.user.id;
    App.isAnon = !!session.user.is_anonymous;
    App.email = session.user.email || null;
    try { await loadProjects(); } catch (e) { screenError(friendly(e)); return; }
    if (!App.projects.length) { if (App.isAnon) screenWelcome(); else screenCreateProject(true); return; }
    try { await loadDocs(); } catch (e) { screenError(friendly(e)); return; }
    listen();
    gate.remove();
    resolveReady();
    App.emit();
  }
  App.showCreateProject = () => screenCreateProject(false);
  App.showCode = screenCode;

  // 처음 실행
  if (!hasSdk) { document.addEventListener("DOMContentLoaded", () => screenError("앱 파일 일부가 빠졌습니다. 다시 설치하세요.")); return; }
  const boot = () => { if (!sb) screenServer(); else start().catch((e) => screenError(friendly(e))); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
