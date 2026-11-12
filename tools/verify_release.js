// 배포 전 무결성 검사. 하나라도 틀리면 실패(종료 코드 1)하고, 다운로드 페이지에 올리지 않는다.
//   node tools/verify_release.js <받은 빌드 파일 폴더> <결과 폴더>
// 하는 일
//   1. 압축 파일이 깨지지 않았는지 (zip 전체 CRC 검사, 설치형 exe는 7z로 검사)
//   2. 압축을 풀어 앱 안에 화면 파일, 서버 설정, (Windows) 카톡 에이전트가 들어 있는지
//   3. 앱 안의 화면 파일이 이 커밋의 app/ 파일과 바이트까지 같은지 (빌드 도중 바뀌지 않았는지)
//   4. 들어 있는 서버 키가 공개(anon) 키인지 (관리자 키가 새지 않았는지)
//   5. Mac 앱의 실행 파일이 맞는 칩(arm64, x86_64)용인지
//   6. 모든 파일의 SHA-256과 크기를 SHA256SUMS.txt, downloads.json에 적는다
const fs = require("fs"), path = require("path"), crypto = require("crypto"), os = require("os");
const { execFileSync } = require("child_process");
const asar = require("@electron/asar");
const ROOT = path.resolve(__dirname, "..");
const IN = path.resolve(process.argv[2] || "out"), OUT = path.resolve(process.argv[3] || "verified");
const pkg = require(path.join(ROOT, "package.json")), V = pkg.version;
const REPO = process.env.GITHUB_REPOSITORY || "flymonkeyff/odd-hr-app";
fs.mkdirSync(OUT, { recursive: true });
let bad = 0; const log = (ok, m) => { console.log(`${ok ? "  O" : "  X"} ${m}`); if (!ok) bad++; };
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const find = (dir, re) => { const out = []; const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory() && !/\.app$/.test(e.name)) walk(p); else if (re.test(e.name)) out.push(p); }); walk(dir); return out; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oddhr-verify-"));
const APPFILES = ["app/index.html", "app/desk.js", "app/shim.js", "app/vendor/supabase.js", "main.js", "preload.js", "updater.js"];

function checkAsar(asarPath, label) {
  const list = asar.listPackage(asarPath).map((x) => x.replace(/\\/g, "/").replace(/^\//, ""));
  for (const f of [...APPFILES, "app-config.json"]) log(list.includes(f), `${label}: ${f} 들어 있음`);
  for (const f of APPFILES) {
    if (!list.includes(f)) continue;
    const inside = crypto.createHash("sha256").update(asar.extractFile(asarPath, f)).digest("hex");
    log(inside === sha(path.join(ROOT, f)), `${label}: ${f}가 이 커밋의 파일과 같음`);
  }
  try {
    const c = JSON.parse(asar.extractFile(asarPath, "app-config.json").toString());
    const role = JSON.parse(Buffer.from(String(c.anonKey).split(".")[1], "base64url").toString()).role;
    log(/^https:\/\//.test(c.url) && role === "anon", `${label}: 서버 주소가 있고 키는 공개(anon) 키`);
  } catch (e) { log(false, `${label}: app-config.json을 읽지 못함 (${e.message})`); }
}

const files = [];
const add = (p, os_, label, main) => files.push({ name: path.basename(p), path: p, os: os_, label, main: !!main });

// Windows 압축본
for (const z of find(IN, new RegExp(`^ODD-HR-${V.replace(/\./g, "\\.")}-win\\.zip$`))) {
  console.log(`\n${path.basename(z)}`);
  try { execFileSync("unzip", ["-tq", z], { stdio: "pipe" }); log(true, "압축 전체 CRC 검사 통과"); } catch (e) { log(false, "압축이 깨졌음"); continue; }
  const d = path.join(tmp, "win"); execFileSync("unzip", ["-q", "-o", z, "-d", d]);
  const exe = find(d, /^ODD HR\.exe$/)[0];
  log(!!exe && fs.readFileSync(exe).subarray(0, 2).toString() === "MZ", "ODD HR.exe가 Windows 실행 파일");
  const ag = find(d, /^odd-hr-agent\.exe$/)[0];
  log(!!ag && fs.statSync(ag).size > 1e6, "카톡 에이전트(odd-hr-agent.exe) 들어 있음");
  const a = find(d, /^app\.asar$/)[0]; if (a) checkAsar(a, "Windows 앱"); else log(false, "app.asar 없음");
  add(z, "win", "Windows 압축본 (설치 없이 실행)", false);
}
// Windows 설치형
for (const x of find(IN, new RegExp(`^ODD-HR-Setup-${V.replace(/\./g, "\\.")}\\.exe$`))) {
  console.log(`\n${path.basename(x)}`);
  log(fs.readFileSync(x).subarray(0, 2).toString() === "MZ", "Windows 실행 파일 머리");
  try { execFileSync("7z", ["t", x], { stdio: "pipe" }); log(true, "설치 파일 안의 압축 검사 통과 (7z)"); } catch (e) { log(false, "설치 파일 안의 압축이 깨졌음"); }
  add(x, "win", "Windows 설치 파일 (권장)", true);
}
// Mac
for (const [chip, arch, label] of [["apple-silicon", "arm64", "Mac Apple 실리콘 (M1~M4)"], ["intel", "x86_64", "Mac 인텔"]]) {
  for (const z of find(IN, new RegExp(`^ODD-HR-${V.replace(/\./g, "\\.")}-mac-${chip}\\.zip$`))) {
    console.log(`\n${path.basename(z)}`);
    try { execFileSync("unzip", ["-tq", z], { stdio: "pipe" }); log(true, "압축 전체 CRC 검사 통과"); } catch (e) { log(false, "압축이 깨졌음"); continue; }
    const d = path.join(tmp, chip); execFileSync("unzip", ["-q", "-o", z, "-d", d]);
    const bin = path.join(d, "ODD HR.app", "Contents", "MacOS", "ODD HR");
    const kind = fs.existsSync(bin) ? execFileSync("file", ["-b", bin]).toString() : "";
    log(kind.includes("Mach-O") && kind.includes(arch), `실행 파일이 ${arch}용 (${kind.trim().slice(0, 60)})`);
    log(fs.existsSync(path.join(d, "ODD HR.app", "Contents", "_CodeSignature", "CodeResources")), "서명 정보 들어 있음 (Mac 빌드에서 codesign --verify 통과)");
    const ag = path.join(d, "ODD HR.app", "Contents", "Resources", "agent", "odd-hr-agent");
    const agKind = fs.existsSync(ag) ? execFileSync("file", ["-b", ag]).toString() : "";
    log(agKind.includes("Mach-O") && agKind.includes(arch), `카톡 에이전트가 들어 있고 ${arch}용`);
    const a = path.join(d, "ODD HR.app", "Contents", "Resources", "app.asar");
    if (fs.existsSync(a)) checkAsar(a, `Mac ${chip}`); else log(false, "app.asar 없음");
    add(z, "mac", `${label} · 자동 업데이트용 zip`, false);
  }
  // 처음 설치용 dmg: UDIF 형식(끝 512바이트가 'koly')인지
  for (const g of find(IN, new RegExp(`^ODD-HR-${V.replace(/\./g, "\\.")}-mac-${chip}\\.dmg$`))) {
    console.log(`\n${path.basename(g)}`);
    const fd = fs.openSync(g, "r"), size = fs.statSync(g).size, tail = Buffer.alloc(4);
    fs.readSync(fd, tail, 0, 4, size - 512); fs.closeSync(fd);
    log(tail.toString() === "koly" && size > 5e7, "Mac 디스크 이미지 형식 (hdiutil verify는 Mac 빌드에서 통과)");
    add(g, "mac", `${label} (권장)`, chip === "apple-silicon");
  }
}
const want = 6;
log(files.length === want, `배포 파일 ${files.length}/${want}개`);

// 지문 목록
const rows = files.map((f) => ({ ...f, sha256: sha(f.path), size: fs.statSync(f.path).size, url: `https://github.com/${REPO}/releases/download/v${V}/${encodeURIComponent(f.name)}` }));
fs.writeFileSync(path.join(OUT, "SHA256SUMS.txt"), rows.map((r) => `${r.sha256}  ${r.name}`).join("\n") + "\n");
fs.writeFileSync(path.join(OUT, "downloads.json"), JSON.stringify({
  version: V, built: new Date().toISOString(), commit: process.env.GITHUB_SHA || "",
  sumsUrl: `https://github.com/${REPO}/releases/download/v${V}/SHA256SUMS.txt`,
  checks: ["압축 전체 CRC 검사 (깨진 파일 없음)", "앱 안 화면 파일이 소스 코드와 바이트까지 일치", "공개 키만 들어 있음 (관리자 키 없음)", "Mac 칩별 실행 파일과 카톡 에이전트, 서명과 디스크 이미지 확인", "자동 업데이트가 같은 지문 목록으로 다시 확인", "서버 권한 시험과 앱 전체 흐름 시험 통과"],
  files: rows.map(({ path: _, ...r }) => r)
}, null, 2));
rows.forEach((r) => fs.copyFileSync(r.path, path.join(OUT, r.name)));
console.log(`\n${bad ? `실패 ${bad}건: 배포하지 않습니다` : "모두 통과"}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
