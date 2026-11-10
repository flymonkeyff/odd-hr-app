// supabase-js 브라우저 번들을 app/vendor/에 복사한다 (앱은 인터넷에서 스크립트를 받지 않는다)
const fs = require("fs"), path = require("path");
const src = require.resolve("@supabase/supabase-js/dist/umd/supabase.js");
const dst = path.join(__dirname, "..", "app", "vendor", "supabase.js");
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
// app-config.json이 없으면 빈 것을 만든다 (첫 실행 때 서버 연결 화면이 나온다)
const cfg = path.join(__dirname, "..", "app-config.json");
if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ url: process.env.ODDHR_SUPABASE_URL || "", anonKey: process.env.ODDHR_SUPABASE_ANON_KEY || "" }, null, 2));
console.log("vendor/supabase.js 준비됨");
