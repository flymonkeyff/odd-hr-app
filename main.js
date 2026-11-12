// ODD HR 데스크톱 앱 (Electron 메인 프로세스)
// - 창, 트레이, 로그인할 때 자동 시작
// - 팀 서버 설정 (설치 파일에 들어 있는 app-config.json, 없으면 첫 화면에서 입력)
// - 카톡 에이전트 실행 (Windows, Mac에 들어 있음, 화면이 부를 때만 돎)
// - 자동 업데이트: 켤 때 새 버전을 먼저 받아 지문을 확인하고 설치한 뒤 다시 켠다 (updater.js)
// - Windows: 설치하지 않고 압축본으로 켜면 '제대로 설치'를 권한다 (설치된 앱, 시작 메뉴에 등록)
// - Mac: 응용 프로그램 폴더 밖에서 켜면 옮기기를 권한다
"use strict";
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, nativeTheme, Notification, dialog } = require("electron");
const updater = require("./updater");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const START_HIDDEN = process.argv.includes("--hidden");
let win = null, tray = null, quitting = false;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => showWindow());
app.setAppUserModelId("kr.oddhr.app");

// ---------------------------------------------------------------- 설정
const userCfgPath = () => path.join(app.getPath("userData"), "server.json");
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }
function serverConfig() {
  const bundled = readJson(path.join(__dirname, "app-config.json")) || {};
  const user = readJson(userCfgPath()) || {};
  const pick = (k) => (user[k] || bundled[k] || process.env[k === "url" ? "ODDHR_SUPABASE_URL" : "ODDHR_SUPABASE_ANON_KEY"] || "").trim();
  return { url: pick("url"), anonKey: pick("anonKey"), webUrl: String(bundled.webUrl || "").trim() };
}

// ---------------------------------------------------------------- 카톡 에이전트
function agentCommand() {
  if (process.env.ODDHR_AGENT_CMD) {                       // 개발용: "python -m kakaotalk_mcp.oddhr_agent"
    const parts = process.env.ODDHR_AGENT_CMD.split(" ");
    return { file: parts[0], pre: parts.slice(1) };
  }
  if (!IS_WIN && !IS_MAC) return null;
  const exe = path.join(process.resourcesPath || "", "agent", IS_WIN ? "odd-hr-agent.exe" : "odd-hr-agent");
  return fs.existsSync(exe) ? { file: exe, pre: [] } : null;
}
const AGENT = agentCommand();
const ALLOWED = new Set(["status", "pending", "mark-synced", "scan", "config-get", "config-set"]);
let agentQueue = Promise.resolve();
function runAgent(args) {
  // 한 번에 하나씩 (카톡 창과 클립보드를 동시에 쓰지 않게)
  const job = () => new Promise((resolve) => {
    if (!AGENT) return resolve({ ok: false, error: "이 컴퓨터에는 카톡 에이전트가 없습니다 (Windows, Mac 앱에 들어 있음)." });
    if (!Array.isArray(args) || !ALLOWED.has(args[0]) || args.some((a) => typeof a !== "string" || a.length > 20000)) return resolve({ ok: false, error: "허용하지 않는 명령입니다." });
    execFile(AGENT.file, [...AGENT.pre, "--json", ...args], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } }, (err, stdout, stderr) => {
      const line = String(stdout || "").trim().split(/\r?\n/).pop() || "";
      try { return resolve(JSON.parse(line)); } catch (e) {}
      resolve({ ok: false, error: (err && err.killed) ? "카톡 점검이 2분 넘게 걸려 멈췄습니다." : String(stderr || (err && err.message) || "에이전트 응답을 읽지 못했습니다.").slice(-400) });
    });
  });
  const p = agentQueue.then(job, job);
  agentQueue = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------- 창
function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 940, minHeight: 620,
    title: "ODD HR",
    show: !START_HIDDEN,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff",
    titleBarStyle: IS_MAC ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,         // 창을 내려 둬도 3분 점검이 돈다
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, "app", "index.html"));
  // 바깥 링크는 기본 브라우저로, 앱 안에서는 다른 페이지로 못 넘어가게
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.on("close", (e) => {
    // 카톡 에이전트가 있는 PC는 닫기를 눌러도 트레이에 남아 점검을 계속한다
    if (!quitting && (AGENT || IS_MAC)) {
      e.preventDefault(); win.hide();
      if (AGENT && !app.__toldTray && Notification.isSupported()) { app.__toldTray = true; new Notification({ title: "ODD HR", body: "창을 닫아도 트레이에서 카톡 점검을 계속합니다. 완전히 끄려면 트레이 아이콘에서 '종료'를 누르세요." }).show(); }
    }
  });
}
function showWindow() { if (!win) createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "build", IS_MAC ? "trayTemplate.png" : "tray.png"));
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")).resize({ width: 16, height: 16 }) : img);
  tray.setToolTip("ODD HR");
  const items = [{ label: "ODD HR 열기", click: showWindow }];
  if (AGENT) items.push({ label: "지금 카톡 점검", click: () => { showWindow(); win.webContents.send("oddhr:check-now"); } });
  items.push({ type: "separator" }, { label: "종료", click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.on("click", showWindow);
}

// ---------------------------------------------------------------- 화면과 주고받기
ipcMain.on("oddhr:config", (e) => {
  const s = serverConfig();
  e.returnValue = { ...s, platform: process.platform, version: app.getVersion(), agentAvailable: !!AGENT, openAtLogin: app.getLoginItemSettings().openAtLogin };
});
ipcMain.on("oddhr:save-config", (e, c) => {
  try {
    const url = String((c && c.url) || "").trim(), anonKey = String((c && c.anonKey) || "").trim();
    if (!/^https:\/\/[^\s/]+$/.test(url) || anonKey.length < 40) { e.returnValue = false; return; }
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(userCfgPath(), JSON.stringify({ url, anonKey }, null, 2));
    e.returnValue = true;
  } catch (err) { e.returnValue = false; }
});
ipcMain.handle("oddhr:agent", (e, args) => runAgent(args));
ipcMain.handle("oddhr:set-login", (e, on) => { app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"] }); return app.getLoginItemSettings().openAtLogin; });
// 구글 로그인(Gmail 연결): 앱 안의 작은 창에서 구글 화면을 열고, 돌아오는 주소(코드)만 화면에 돌려준다.
// 창에는 preload가 없고, 구글·Supabase 주소 밖으로는 못 나간다.
ipcMain.handle("oddhr:oauth", (e, { url, back }) => new Promise((resolve) => {
  const okStart = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/auth\/v1\/authorize\?/.test(String(url || ""));
  if (!okStart || !/^https:\/\//.test(String(back || ""))) return resolve({ ok: false, error: "허용하지 않는 로그인 주소입니다." });
  const w = new BrowserWindow({ width: 520, height: 720, parent: win || undefined, modal: !!win, title: "Google 로그인", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: "oddhr-oauth" } });
  let done = false;
  const finish = (r) => { if (done) return; done = true; resolve(r); if (!w.isDestroyed()) w.close(); };
  const watch = (ev, u) => {
    if (String(u).startsWith(back)) { ev.preventDefault(); finish({ ok: true, url: String(u) }); return; }
    if (!/^https:\/\/(accounts\.google\.com|[a-z0-9-]+\.supabase\.(co|in)|accounts\.youtube\.com|www\.google\.com)\//.test(String(u))) { ev.preventDefault(); }
  };
  w.webContents.on("will-redirect", watch);
  w.webContents.on("will-navigate", watch);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.on("closed", () => finish({ ok: false, error: "로그인 창을 닫았습니다." }));
  w.loadURL(url);
}));
// Mac 카톡 내보내기 폴더 열기 (홈 폴더 안만)
ipcMain.handle("oddhr:open-folder", async (e, dir) => {
  const p = path.resolve(String(dir || "").replace(/^~(?=\/|$)/, app.getPath("home")));
  if (!p.startsWith(app.getPath("home"))) return false;
  fs.mkdirSync(p, { recursive: true });
  return (await shell.openPath(p)) === "";
});
ipcMain.on("oddhr:set-theme", (e, t) => { nativeTheme.themeSource = ["light", "dark"].includes(t) ? t : "system"; });
ipcMain.handle("oddhr:notify", (e, { title, body }) => { if (Notification.isSupported()) new Notification({ title: String(title || "ODD HR").slice(0, 80), body: String(body || "").slice(0, 240) }).show(); });

// ---------------------------------------------------------------- 업데이트
const NO_UPDATE = !app.isPackaged || process.env.ODDHR_NO_UPDATE === "1";
const appBundle = () => (IS_MAC ? path.resolve(process.execPath, "..", "..", "..") : "");
// Windows에서 설치 프로그램으로 깔린 앱인가 (압축을 풀어 켠 것은 '설치된 앱'에 안 뜬다)
const installedOnWin = () => {
  if (!IS_WIN) return true;
  const exe = process.execPath.toLowerCase();
  const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"), process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((x) => x.toLowerCase());
  return roots.some((r) => exe.startsWith(r)) && fs.existsSync(path.join(path.dirname(process.execPath), "Uninstall ODD HR.exe"));
};
let splash = null;
function showSplash(text) {
  if (START_HIDDEN) return;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;font:14px -apple-system,"Segoe UI","Malgun Gothic",sans-serif;background:#fff;color:#1d1d1f;display:grid;place-items:center;height:100vh;-webkit-app-region:drag;user-select:none}
    @media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}}
    .w{width:300px;display:grid;gap:12px;text-align:center}svg{height:28px;fill:#F15524;margin:0 auto}
    .bar{height:6px;border-radius:3px;background:rgba(120,120,128,.2);overflow:hidden}.bar i{display:block;height:100%;width:0;background:#F15524;transition:width .2s}
    .s{font-size:12px;opacity:.65}</style>
    <div class="w"><svg viewBox="0 0 201 128"><circle cx="64" cy="64" r="64"/><path d="M106 0A64 64 0 0 1 106 128Z"/><path d="M169 8.57A64 64 0 0 1 169 119.43Z"/></svg>
    <div id="t">${text}</div><div class="bar"><i id="b"></i></div><div class="s" id="s"></div></div>
    <script>window.set=(t,p,s)=>{document.getElementById("t").textContent=t;document.getElementById("b").style.width=(p||0)+"%";document.getElementById("s").textContent=s||""}</script>`;
  splash = new BrowserWindow({ width: 380, height: 210, frame: false, resizable: false, show: true, center: true, alwaysOnTop: false, skipTaskbar: false, backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: true } });
  splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}
const splashSet = (t, p, sub) => { if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(`window.set && window.set(${JSON.stringify(t)}, ${Number(p) || 0}, ${JSON.stringify(sub || "")})`).catch(() => {}); };
const closeSplash = () => { if (splash && !splash.isDestroyed()) splash.close(); splash = null; };
const sendUpdate = (msg) => { if (win && !win.isDestroyed()) win.webContents.send("oddhr:update", msg); };
let updating = false;
async function updateNow(info, from) {
  if (updating) return { ok: false, error: "이미 업데이트 중입니다." };
  updating = true;
  try {
    const mb = (n) => (n / 1048576).toFixed(0);
    const prog = (got, total) => { const p = total ? Math.round((got / total) * 100) : 0; const sub = total ? `${mb(got)} / ${mb(total)}MB` : `${mb(got)}MB`; splashSet(`새 버전 ${info.latest} 받는 중`, p, sub); sendUpdate({ state: "downloading", percent: p, text: sub }); };
    const got = await updater.fetchVerified(info, prog);
    splashSet("지문 확인 완료 · 설치하는 중", 100, "잠시 뒤 다시 켜집니다");
    sendUpdate({ state: "installing" });
    const r = updater.install(got.file, process.platform, { appBundle: appBundle() });
    if (!r.ok) throw new Error(r.error);
    try { fs.writeFileSync(path.join(app.getPath("userData"), "updated-from"), app.getVersion()); } catch (e) {}
    quitting = true;
    setTimeout(() => app.exit(0), 400);
    return { ok: true };
  } catch (e) {
    updating = false;
    sendUpdate({ state: "error", text: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
}
async function startupUpdate() {
  if (NO_UPDATE) return false;
  showSplash("업데이트 확인 중");
  try {
    const info = await updater.check(app.getVersion(), process.platform, process.arch);
    if (!info.available) return false;
    const r = await updateNow(info, "startup");
    return r.ok;
  } catch (e) {
    return false;               // 인터넷이 없거나 서버가 응답하지 않으면 지금 버전으로 켠다
  }
}
ipcMain.handle("oddhr:update-check", async () => {
  if (NO_UPDATE) return { ok: true, current: app.getVersion(), latest: app.getVersion(), available: false, dev: true };
  try { const i = await updater.check(app.getVersion(), process.platform, process.arch); return { ok: true, current: i.current, latest: i.latest, available: i.available }; }
  catch (e) { return { ok: false, current: app.getVersion(), error: String(e.message || e) }; }
});
ipcMain.handle("oddhr:update-install", async () => {
  try { const i = await updater.check(app.getVersion(), process.platform, process.arch); if (!i.available) return { ok: false, error: "이미 최신 버전입니다." }; return await updateNow(i, "settings"); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
// Windows 압축본 → 설치 프로그램으로 제대로 설치 (설치된 앱, 시작 메뉴 등록, 자동 업데이트)
ipcMain.handle("oddhr:install-properly", async () => {
  if (!IS_WIN || installedOnWin()) return { ok: false, error: "이미 설치된 앱입니다." };
  try {
    const i = await updater.check("0.0.0", process.platform, process.arch);
    if (!i.asset) return { ok: false, error: "설치 파일을 찾지 못했습니다." };
    return await updateNow(i, "install");
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.on("oddhr:install-state", (e) => { e.returnValue = { installed: installedOnWin(), inApplications: IS_MAC ? app.isInApplicationsFolder() : true }; });

app.whenReady().then(async () => {
  // Mac: 응용 프로그램 폴더 밖(다운로드 폴더 등)에서 켰으면 옮기기를 권한다 → Launchpad와 응용 프로그램에 뜬다
  if (IS_MAC && app.isPackaged && !app.isInApplicationsFolder()) {
    const r = dialog.showMessageBoxSync({ type: "question", buttons: ["응용 프로그램 폴더로 옮기기", "나중에"], defaultId: 0, cancelId: 1,
      message: "ODD HR을 응용 프로그램 폴더로 옮길까요?", detail: "옮기면 Launchpad와 응용 프로그램에 뜨고, 자동 업데이트가 됩니다." });
    if (r === 0) { try { if (app.moveToApplicationsFolder()) return; } catch (e) { dialog.showErrorBox("옮기지 못했습니다", String(e.message || e)); } }
  }
  if (await startupUpdate()) return;          // 새 버전을 설치하러 간다 (앱은 곧 다시 켜진다)
  createWindow();
  closeSplash();
  createTray();
  // 카톡 에이전트가 있는 PC는 처음 한 번 로그인할 때 자동 시작을 켠다 (설정에서 끌 수 있음)
  const flag = path.join(app.getPath("userData"), "login-item-set");
  if (AGENT && IS_WIN && !fs.existsSync(flag)) { app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] }); try { fs.writeFileSync(flag, "1"); } catch (e) {} }
  app.on("activate", showWindow);
});
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (!IS_MAC && !AGENT) app.quit(); });
