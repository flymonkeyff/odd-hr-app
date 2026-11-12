// ODD HR 자동 업데이트
// 앱을 켤 때 GitHub Releases의 최신 버전을 보고, 새 버전이면
//   1. 이 기기에 맞는 파일을 받는다 (Windows: 설치 파일, Mac: 칩에 맞는 zip)
//   2. 같은 릴리스의 SHA256SUMS.txt와 지문을 비교한다. 다르면 설치하지 않는다.
//   3. 설치하고 앱을 다시 켠다.
// 앱이 직접 받은 파일에는 '인터넷에서 받은 파일' 표시가 붙지 않아서, 첫 설치 뒤로는
// Windows SmartScreen이나 Mac Gatekeeper 경고가 다시 뜨지 않는다.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const REPO = "flymonkeyff/odd-hr-app";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

// "0.10.2" > "0.9.9"
function newer(a, b) {
  const pa = String(a || "").replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// 이 기기에 맞는 설치 파일
function pickAsset(assets, platform, arch) {
  const list = Array.isArray(assets) ? assets : [];
  const find = (re) => list.find((a) => re.test(a.name));
  if (platform === "win32") return find(/^ODD-HR-Setup-[\d.]+\.exe$/);
  if (platform === "darwin") return find(arch === "arm64" ? /^ODD-HR-[\d.]+-mac-apple-silicon\.zip$/ : /^ODD-HR-[\d.]+-mac-intel\.zip$/);
  return null;
}

// "지문  파일이름" 줄들 → { 파일이름: 지문 }
function parseSums(text) {
  const out = {};
  String(text || "").split(/\r?\n/).forEach((line) => {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  });
  return out;
}

const sha256File = (p) => new Promise((resolve, reject) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(p).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 6000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "ODD-HR-updater", Accept: "application/vnd.github+json" } });
    if (r.status === 404) throw new Error("릴리스를 찾지 못했습니다 (저장소가 비공개이거나 아직 배포 전).");
    if (!r.ok) throw new Error(`업데이트 서버 응답 ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchText(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "ODD-HR-updater" }, redirect: "follow" });
    if (!r.ok) throw new Error(`지문 목록을 받지 못했습니다 (${r.status})`);
    return await r.text();
  } finally { clearTimeout(t); }
}

// 받으면서 진행률을 알린다
async function download(url, dest, onProgress, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 15 * 60 * 1000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "ODD-HR-updater" }, redirect: "follow" });
    if (!r.ok || !r.body) throw new Error(`파일을 받지 못했습니다 (${r.status})`);
    const total = Number(r.headers.get("content-length")) || 0;
    const out = fs.createWriteStream(dest);
    let got = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once("drain", res));
      if (onProgress) onProgress(got, total);
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (total && got !== total) throw new Error("파일이 덜 받아졌습니다.");
    return got;
  } finally { clearTimeout(t); }
}

// 최신 버전 확인
async function check(current, platform, arch) {
  const rel = await fetchJson(API);
  const latest = String(rel.tag_name || "").replace(/^v/, "");
  const asset = pickAsset(rel.assets, platform, arch);
  const sums = (rel.assets || []).find((a) => a.name === "SHA256SUMS.txt");
  return { current, latest, available: !!latest && newer(latest, current) && !!asset && !!sums, asset, sums, notes: rel.body || "" };
}

// 받고, 지문 확인
async function fetchVerified(info, onProgress) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oddhr-update-"));
  const file = path.join(dir, info.asset.name);
  const sums = parseSums(await fetchText(info.sums.browser_download_url));
  const want = sums[info.asset.name];
  if (!want) throw new Error("지문 목록에 이 파일이 없습니다. 설치하지 않습니다.");
  await download(info.asset.browser_download_url, file, onProgress);
  const got = await sha256File(file);
  if (got !== want) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} throw new Error("받은 파일의 지문이 다릅니다. 설치하지 않습니다."); }
  return { dir, file, sha256: got };
}

// 설치하고 다시 켜기. 이 함수가 돌아오면 앱을 바로 끈다.
function install(file, platform, opts) {
  opts = opts || {};
  if (platform === "win32") {
    // 설치 파일이 지금 앱이 꺼지기를 기다렸다가 조용히 설치하고 다시 켠다 (--force-run)
    const args = ["/S", "--force-run"];
    const cmd = `ping -n 3 127.0.0.1 >nul & start "" "${file}" ${args.join(" ")}`;
    spawn("cmd.exe", ["/d", "/s", "/c", cmd], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return { ok: true };
  }
  if (platform === "darwin") {
    // 지금 앱 묶음(…/ODD HR.app)을 새것으로 바꾼다. 실패하면 원래 것을 되돌려 놓는다.
    const target = opts.appBundle;
    if (!target || !/\.app$/.test(target)) return { ok: false, error: "앱 위치를 찾지 못했습니다." };
    const work = path.join(path.dirname(file), "x");
    fs.mkdirSync(work, { recursive: true });
    const un = spawnSync("ditto", ["-x", "-k", file, work]);
    if (un.status !== 0) return { ok: false, error: "압축을 풀지 못했습니다." };
    const fresh = fs.readdirSync(work).map((n) => path.join(work, n)).find((p) => /\.app$/.test(p));
    if (!fresh) return { ok: false, error: "새 앱을 찾지 못했습니다." };
    const sh = path.join(path.dirname(file), "swap.sh");
    fs.writeFileSync(sh, [
      "#!/bin/bash",
      `PID=${process.pid}`,
      `T=${JSON.stringify(target)}`,
      `N=${JSON.stringify(fresh)}`,
      "for i in $(seq 1 100); do kill -0 $PID 2>/dev/null || break; sleep 0.2; done",
      'rm -rf "$T.old"',
      'if mv "$T" "$T.old" && mv "$N" "$T"; then rm -rf "$T.old"; else [ -d "$T.old" ] && [ ! -d "$T" ] && mv "$T.old" "$T"; fi',
      'xattr -dr com.apple.quarantine "$T" 2>/dev/null',
      'open "$T" --args --updated',
      ""
    ].join("\n"), { mode: 0o755 });
    spawn("/bin/bash", [sh], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  }
  return { ok: false, error: "이 운영체제는 자동 업데이트를 지원하지 않습니다." };
}

module.exports = { newer, pickAsset, parseSums, sha256File, check, fetchVerified, install, download, REPO };
