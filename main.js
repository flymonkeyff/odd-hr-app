// ODD HR 데스크톱 앱 (Electron 메인 프로세스)
// - 창, 트레이, 로그인할 때 자동 시작
// - 팀 서버 설정 (설치 파일에 들어 있는 app-config.json, 없으면 첫 화면에서 입력)
// - 카톡 에이전트 실행 (Windows에만 들어 있음, 화면이 부를 때만 돎)
"use strict";
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, nativeTheme, Notification } = require("electron");
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

app.whenReady().then(() => {
  createWindow();
  createTray();
  // 카톡 에이전트가 있는 PC는 처음 한 번 로그인할 때 자동 시작을 켠다 (설정에서 끌 수 있음)
  const flag = path.join(app.getPath("userData"), "login-item-set");
  if (AGENT && IS_WIN && !fs.existsSync(flag)) { app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] }); try { fs.writeFileSync(flag, "1"); } catch (e) {} }
  app.on("activate", showWindow);
});
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (!IS_MAC && !AGENT) app.quit(); });
