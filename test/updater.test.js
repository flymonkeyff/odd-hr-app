// 자동 업데이트 시험: 버전 비교, 기기별 파일 고르기, 지문 목록 읽기, 받기와 지문 확인 (바뀐 파일은 거절)
//   node test/updater.test.js
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const u = require("../updater");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  O " + m); } else { fail++; console.log("  X " + m); } };

(async () => {
  console.log("버전 비교");
  ok(u.newer("0.3.0", "0.2.0"), "0.3.0 > 0.2.0");
  ok(u.newer("0.10.0", "0.9.9"), "0.10.0 > 0.9.9 (자릿수)");
  ok(u.newer("v1.0.0", "0.99.0"), "v 접두어");
  ok(!u.newer("0.2.0", "0.2.0"), "같으면 새 버전 아님");
  ok(!u.newer("0.1.9", "0.2.0"), "옛 버전은 아님");

  console.log("기기에 맞는 파일 고르기");
  const assets = ["ODD-HR-0.3.0-win.zip", "ODD-HR-Setup-0.3.0.exe", "ODD-HR-0.3.0-mac-apple-silicon.zip", "ODD-HR-0.3.0-mac-intel.zip", "ODD-HR-0.3.0-mac-apple-silicon.dmg", "SHA256SUMS.txt"].map((name) => ({ name }));
  ok(u.pickAsset(assets, "win32", "x64").name === "ODD-HR-Setup-0.3.0.exe", "Windows는 설치 파일");
  ok(u.pickAsset(assets, "darwin", "arm64").name === "ODD-HR-0.3.0-mac-apple-silicon.zip", "M 칩 Mac은 apple-silicon zip");
  ok(u.pickAsset(assets, "darwin", "x64").name === "ODD-HR-0.3.0-mac-intel.zip", "인텔 Mac은 intel zip");
  ok(!u.pickAsset(assets, "linux", "x64"), "다른 운영체제는 없음");

  console.log("지문 목록");
  const sums = u.parseSums("3b07a92f53445df9e8929512eb6b9dd1e3e1a701fc40ce71694b89f1429f8ec8  ODD-HR-0.2.0-win.zip\r\nnot a line\nAF6A35105C1CEA172E763BFCD0B67BD54F95DDEC66D2D82FD22DF69A1D2744F3 *ODD-HR-Setup-0.2.0.exe\n");
  ok(Object.keys(sums).length === 2 && sums["ODD-HR-Setup-0.2.0.exe"] === "af6a35105c1cea172e763bfcd0b67bd54f95ddec66d2d82fd22df69a1d2744f3", "두 줄을 읽고 대소문자·별표를 정리");

  console.log("받기와 지문 확인 (시험용 서버)");
  const good = crypto.randomBytes(300 * 1024), bad = Buffer.from(good); bad[100] ^= 1;
  const sha = crypto.createHash("sha256").update(good).digest("hex");
  let serveBad = false;
  const srv = http.createServer((req, res) => {
    if (req.url === "/SHA256SUMS.txt") { res.end(`${sha}  ODD-HR-Setup-9.9.9.exe\n`); return; }
    if (req.url === "/ODD-HR-Setup-9.9.9.exe") { const b = serveBad ? bad : good; res.writeHead(200, { "Content-Length": b.length }); res.end(b); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const info = { latest: "9.9.9", asset: { name: "ODD-HR-Setup-9.9.9.exe", browser_download_url: `${base}/ODD-HR-Setup-9.9.9.exe` }, sums: { browser_download_url: `${base}/SHA256SUMS.txt` } };
  let last = 0;
  const got = await u.fetchVerified(info, (g, t) => { last = Math.round((g / t) * 100); });
  ok(got.sha256 === sha && fs.statSync(got.file).size === good.length, "온전한 파일은 받고 지문이 맞는다");
  ok(last === 100, "진행률이 100%까지 간다");
  fs.rmSync(got.dir, { recursive: true, force: true });
  serveBad = true;
  let refused = null;
  try { await u.fetchVerified(info); } catch (e) { refused = e.message; }
  ok(refused && /지문이 다릅니다/.test(refused), "한 바이트라도 바뀐 파일은 설치하지 않는다");
  info.asset.name = "다른-파일.exe";
  refused = null;
  try { await u.fetchVerified(info); } catch (e) { refused = e.message; }
  ok(refused && /지문 목록에 이 파일이 없습니다/.test(refused), "지문 목록에 없는 파일은 설치하지 않는다");
  srv.close();

  console.log(`\n${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
