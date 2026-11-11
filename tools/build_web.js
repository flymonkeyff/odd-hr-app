// 아이폰·아이패드(그리고 모든 브라우저)용 웹 앱을 web/ 폴더에 만든다.
// 같은 화면(app/), 같은 팀 서버. 홈 화면에 추가하면 앱처럼 열린다 (PWA).
// 무결성: 모든 스크립트에 SRI(sha384) 해시를 붙이고, 파일 목록과 SHA-256을 web/SHA256SUMS.txt에 적는다.
//   실행: node tools/build_web.js   (먼저 npm run ui, npm run vendor)
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "app"), OUT = path.join(ROOT, "web");
const pkg = require(path.join(ROOT, "package.json"));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "app-config.json"), "utf8"));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "vendor"), { recursive: true });
fs.mkdirSync(path.join(OUT, "icons"), { recursive: true });

const copy = (from, to) => fs.copyFileSync(path.join(APP, from), path.join(OUT, to || from));
["shim.js", "desk.js", "vendor/supabase.js"].forEach((f) => copy(f));
// 서버 주소와 공개(anon) 키만 넣는다. 관리자 키는 절대 넣지 않는다.
if (!/^https:\/\//.test(cfg.url || "") || !cfg.anonKey) throw new Error("app-config.json에 url과 anonKey가 필요합니다");
const role = JSON.parse(Buffer.from(cfg.anonKey.split(".")[1], "base64url").toString()).role;
if (role !== "anon") throw new Error(`공개 키가 아닙니다 (role=${role}). anon public 키만 넣으세요.`);
fs.writeFileSync(path.join(OUT, "config.js"), `window.ODDHR_WEB_CONFIG = ${JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey, webUrl: cfg.webUrl || "", platform: "web", version: pkg.version })};\n`);

// 아이콘: build/icon.png(1024)에서 줄인다 (sharp 없으면 Electron 빌드용 원본을 그대로)
const icon = path.join(ROOT, "build", "icon.png");
let sharp = null; try { sharp = require("sharp"); } catch (e) {}
const icons = [["icon-180.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]];

const manifest = {
  name: "ODD HR", short_name: "ODD HR", lang: "ko", start_url: "./", scope: "./", display: "standalone",
  background_color: "#ffffff", theme_color: "#F15524", orientation: "any",
  icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }]
};
fs.writeFileSync(path.join(OUT, "manifest.webmanifest"), JSON.stringify(manifest, null, 2));

const sri = (f) => "sha384-" + crypto.createHash("sha384").update(fs.readFileSync(path.join(OUT, f))).digest("base64");
let html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
const rep = (a, b) => { if (!html.includes(a)) throw new Error("index.html에 없음: " + a.slice(0, 60)); html = html.replace(a, b); };
rep('<meta name="viewport" content="width=device-width, initial-scale=1">', `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="ODD HR">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1c1e" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<link rel="icon" href="icons/icon-192.png">`);
rep("connect-src 'self'", "manifest-src 'self'; worker-src 'self'; connect-src 'self'");
for (const f of ["vendor/supabase.js", "shim.js", "desk.js"]) rep(`<script src="${f}"></script>`, `<script src="${f}" integrity="${sri(f)}" crossorigin="anonymous"></script>`);
rep('<script src="vendor/supabase.js"', `<script src="config.js" integrity="${sri("config.js")}" crossorigin="anonymous"></script>\n<script src="vendor/supabase.js"`);
html = html.replace("</body>", `<script src="sw-register.js"></script>\n</body>`);
fs.writeFileSync(path.join(OUT, "sw-register.js"), `if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});\n`);
fs.writeFileSync(path.join(OUT, "index.html"), html);

(async () => {
  for (const [n, size] of icons) {
    const pre = path.join(ROOT, "build", "web", n);   // 미리 줄여 둔 아이콘 (흰 바탕, iOS용)
    if (fs.existsSync(pre)) fs.copyFileSync(pre, path.join(OUT, "icons", n));
    else if (sharp) await sharp(icon).resize(size, size).png().toFile(path.join(OUT, "icons", n));
    else fs.copyFileSync(icon, path.join(OUT, "icons", n));
  }
  // 서비스 워커: 앱 화면 파일만 저장해 두고(오프라인에서도 열림), 서버 데이터는 늘 인터넷에서 받는다.
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(OUT, p).split(path.sep).join("/")); });
  walk(OUT);
  const shell = ["./", ...files.filter((f) => !/SHA256SUMS/.test(f))];
  const hash = crypto.createHash("sha256"); files.sort().forEach((f) => hash.update(f).update(fs.readFileSync(path.join(OUT, f))));
  const ver = `oddhr-${pkg.version}-${hash.digest("hex").slice(0, 12)}`;
  fs.writeFileSync(path.join(OUT, "sw.js"), `// ${ver}
const CACHE = ${JSON.stringify(ver)};
const SHELL = ${JSON.stringify(shell)};
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // 팀 서버 요청은 건드리지 않는다
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("./"))));
});
`);
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
  // 다운로드 페이지와, CI의 무결성 검사가 만든 파일 목록 (있을 때만)
  fs.copyFileSync(path.join(__dirname, "download-page.html"), path.join(OUT, "download.html"));
  const dl = process.env.DOWNLOADS_DIR;
  if (dl && fs.existsSync(path.join(dl, "downloads.json"))) {
    fs.copyFileSync(path.join(dl, "downloads.json"), path.join(OUT, "downloads.json"));
    fs.copyFileSync(path.join(dl, "SHA256SUMS.txt"), path.join(OUT, "SHA256SUMS-release.txt"));
  }
  const all = []; walk2(OUT, all);
  function walk2(d, acc) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk2(p, acc); else acc.push(p); }); }
  const sums = all.filter((p) => !/SHA256SUMS|\.nojekyll/.test(p)).sort().map((p) => `${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}  ${path.relative(OUT, p).split(path.sep).join("/")}`);
  fs.writeFileSync(path.join(OUT, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  console.log(`web/ 만듦 (${sums.length}개 파일, ${ver})`);
})().catch((e) => { console.error(e); process.exit(1); });
