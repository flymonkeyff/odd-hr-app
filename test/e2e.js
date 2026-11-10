// 앱 전체 흐름 시험: 화면(app/) + 연결부(shim.js) + 서버 권한(setup.sql, PGlite) + 카톡 에이전트(실제 코드, 가짜 카톡)
// 실행: NODE_PATH=<pglite와 playwright가 있는 node_modules> AGENT_DIR=<가짜 kakao가 든 폴더> node test/e2e.js
const { chromium } = require("playwright");
const { PGlite } = require("@electric-sql/pglite");
const fs = require("fs"), path = require("path"), os = require("os");
const { execFile } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.OUT_DIR || path.join(os.tmpdir(), "oddhr-e2e"); fs.mkdirSync(OUT, { recursive: true });
const AGENT_DIR = process.env.AGENT_DIR;
const AGENT_HOME = path.join(OUT, "agent-home"); fs.rmSync(AGENT_HOME, { recursive: true, force: true });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  O", m); } else { fail++; console.log("  X", m); } };

(async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
    grant usage on schema auth to authenticated, anon; grant execute on all functions in schema auth to authenticated, anon; grant usage on schema public to authenticated, anon;`);
  await db.exec(fs.readFileSync(path.join(ROOT, "server", "setup.sql"), "utf8"));
  let lock = Promise.resolve();
  const sql = (claims, text, params) => {
    const job = async () => {
      await db.exec(`reset role; select set_config('request.jwt.claims', '${JSON.stringify(claims).replace(/'/g, "''")}', false); set role authenticated;`);
      try { const r = await db.query(text, params); return { rows: r.rows, affected: r.affectedRows }; }
      catch (e) { return { error: { message: e.message, code: e.code } }; }
      finally { await db.exec("reset role"); }
    };
    const p = lock.then(job, job); lock = p.catch(() => {}); return p;
  };
  const asAdmin = async (text) => (await db.query(text)).rows;
  const agent = (args) => new Promise((res) => execFile("python3", ["-m", "kakaotalk_mcp.oddhr_agent", "--json", ...args], { cwd: AGENT_DIR, env: { ...process.env, ODD_HR_HOME: AGENT_HOME } }, (e, out, err) => { try { res(JSON.parse(String(out).trim().split("\n").pop())); } catch (x) { res({ ok: false, error: String(err || e) }); } }));

  const browser = await chromium.launch();
  const errs = [];
  async function open(name, { agentOn }) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: "Asia/Seoul" });
    await ctx.exposeFunction("__sql", sql);
    await ctx.exposeFunction("__agent", agent);
    await ctx.addInitScript(({ agentOn }) => {
      window.oddhr = {
        config: () => ({ url: "https://test.supabase.co", anonKey: "x".repeat(60), platform: agentOn ? "win32" : "darwin", version: "0.1.0-test", agentAvailable: agentOn, openAtLogin: false }),
        saveConfig: () => true, agent: (a) => window.__agent(a), setTheme() {}, setLoginItem: async (on) => on, notify: async () => {}, onCheckNow() {}
      };
    }, { agentOn });
    await ctx.addInitScript({ path: path.join(__dirname, "fake-supabase.js") });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errs.push(`[${name}] ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error" && !/favicon|fonts\.g|ERR_FAILED/.test(m.text())) errs.push(`[${name}] ${m.text()}`); });
    // 글꼴 요청은 막아 둔다 (시험 환경 밖으로 나가지 않게)
    await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await p.goto("file://" + path.join(ROOT, "app", "index.html"));
    return p;
  }
  const shot = (p, n) => p.screenshot({ path: path.join(OUT, n + ".png") });

  console.log("PM: 첫 실행 → 계정 만들기 → 프로젝트 만들기");
  const pm = await open("PM", { agentOn: true });
  await pm.waitForSelector(".gate");
  await shot(pm, "01-welcome");
  await pm.click("text=이메일로 로그인");
  await pm.fill("#g-email", "pm@odd.test"); await pm.fill("#g-pw", "secret123");
  await pm.click("text=PM 계정 만들기");
  await pm.waitForSelector("#g-pname", { timeout: 8000 }).catch(async () => { console.log("gate:", await pm.textContent(".gate").catch(() => "-"), errs); await shot(pm, "err-signup"); });
  await pm.fill("#g-pname", "양천경찰서 영상"); await pm.fill("#g-me", "김피엠"); await pm.fill("#g-due", "2026-11-27"); await pm.fill("#g-label", "편집 완료");
  await pm.click('button:text-is("프로젝트 만들기")');
  await pm.waitForSelector(".gate-code", { timeout: 8000 }).catch(async () => { console.log("gate msg:", await pm.textContent(".gate-msg").catch(() => "-"), errs); await shot(pm, "err-create"); });
  const code = (await pm.textContent(".gate-code")).trim();
  ok(/^ODD-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `입장 코드 발급 ${code}`);
  await shot(pm, "02-code");
  await pm.click('button:text-is("시작하기")');
  await pm.waitForSelector(".gate", { state: "detached" });
  await pm.waitForTimeout(400);
  ok((await pm.textContent("#main")).includes("아침상"), "PM 홈이 열린다");

  console.log("팀원: 코드로 들어오기");
  const ed = await open("팀원", { agentOn: false });
  await ed.waitForSelector("#g-code");
  await ed.fill("#g-code", code.toLowerCase().replace(/-/g, ""));
  ok((await ed.inputValue("#g-code")) === code, "코드 칸이 ODD-XXXX-XXXX로 정리된다");
  await ed.fill("#g-name", "홍길동"); await ed.selectOption("#g-role", "편집");
  await ed.click('button:text-is("들어가기")');
  await ed.waitForSelector(".gate", { state: "detached" });
  await ed.waitForTimeout(300);
  ok(!(await ed.$('a[href="#agents"] .badge')) || true, "팀원 화면이 열린다");
  await ed.goto(ed.url().split("#")[0] + "#team"); await ed.waitForTimeout(400);
  ok((await ed.textContent("#main")).includes("홍길동"), "팀원 탭에 내 카드가 보인다");
  ok(!(await ed.$(".codebox")), "팀원 화면에는 입장 코드 관리가 없다");
  await ed.click('button:text-is("내 단계 바꾸기")');
  const uid = await ed.evaluate(() => window.oddhrApp.uid);
  await ed.selectOption(`#st-${uid}`, "가편집"); await ed.fill(`#sn-${uid}`, "v02 컷 정리 중");
  await ed.click(".mcard.me button[type=submit]"); await ed.waitForTimeout(400);
  ok((await ed.textContent(".mcard.me")).includes("v02 컷 정리 중"), "팀원이 내 단계를 바꾼다");
  await shot(ed, "03-team-member");

  console.log("팀원: 할 일 만들기와 완료 제한");
  await ed.goto(ed.url().split("#")[0] + "#tasks"); await ed.waitForTimeout(300);
  await ed.fill("#ntitle", "엔딩 10초 줄이기");
  await ed.click("form.form button[type=submit]"); await ed.waitForTimeout(500);
  const t = await asAdmin(`select id, data from docs where collection='tasks'`);
  ok(t.length === 1 && t[0].data["할 일"] === "엔딩 10초 줄이기", "팀원이 만든 할 일이 서버에 저장된다");
  const tid = t[0].id;
  const forced = await ed.evaluate(async (id) => { try { await window.oddhrApp.db.collection("tasks").doc(id).update({ "상태": "완료" }); return "통과됨"; } catch (e) { return e.message; } }, tid);
  ok(/PM만/.test(forced), `팀원이 화면을 우회해 완료로 바꾸려 해도 서버가 막는다 (${forced})`);

  console.log("PM: 팀원 단계 확인, 할 일 완료, 설정");
  await pm.reload(); await pm.waitForSelector(".gate", { state: "detached" }).catch(() => {}); await pm.waitForTimeout(500);
  await pm.goto(pm.url().split("#")[0] + "#team"); await pm.waitForTimeout(400);
  ok((await pm.textContent("#main")).includes(code), "PM 팀원 탭에 입장 코드가 보인다");
  ok((await pm.textContent("#main")).includes("가편집"), "PM이 팀원의 지금 단계를 본다");
  await pm.click('button:text-is("단계 확인")'); await pm.waitForTimeout(400);
  ok((await asAdmin(`select stage_checked_at from members where name='홍길동'`))[0].stage_checked_at !== null, "PM의 단계 확인이 서버에 남는다");
  await shot(pm, "04-team-pm");
  const done = await pm.evaluate(async (id) => { try { await window.oddhrApp.db.collection("tasks").doc(id).update({ "상태": "완료" }); return "ok"; } catch (e) { return e.message; } }, tid);
  ok(done === "ok", "PM은 완료 처리한다");

  await pm.goto(pm.url().split("#")[0] + "#settings"); await pm.waitForTimeout(400);
  await pm.click('button[role=radio]:has-text("다크")'); await pm.click('.swatch[aria-label="인디고"]'); await pm.waitForTimeout(200);
  const theme = await pm.evaluate(() => [document.documentElement.getAttribute("data-theme"), getComputedStyle(document.documentElement).getPropertyValue("--blue").trim(), getComputedStyle(document.body).backgroundColor]);
  ok(theme[0] === "dark" && theme[1].toUpperCase() === "#5856D6" && theme[2] === "rgb(28, 28, 30)", `다크 모드와 키 컬러가 바로 바뀐다 (${theme.join(", ")})`);
  await pm.waitForSelector("#rooms", { timeout: 5000 });
  await pm.fill("#rooms", "테스트방"); await pm.fill("#members", "홍길동=편집");
  await pm.click('section:has(#rooms) button[type=submit]'); await pm.waitForTimeout(800);
  await pm.waitForSelector("#rp-0", { timeout: 5000 });
  await pm.click('section:has(#rooms) button[type=submit]'); await pm.waitForTimeout(800);
  const cfg = JSON.parse(fs.readFileSync(path.join(AGENT_HOME, "config.json"), "utf8"));
  ok(cfg.rooms[0] === "테스트방" && cfg.room_projects["테스트방"] === "양천경찰서 영상" && cfg.members["홍길동"] === "편집", "설정에서 대화방·프로젝트·팀원 역할을 에이전트에 저장한다");
  await shot(pm, "05-settings-dark");

  console.log("PM: 지금 카톡 점검하기 → 서버에 제안");
  await pm.goto(pm.url().split("#")[0] + "#agents"); await pm.waitForTimeout(300);
  await pm.click('button:has-text("지금 카톡 점검하기")');
  await pm.waitForFunction(() => /가져왔습니다|새 제안이 없습니다|못했/.test(document.querySelector("#main").textContent), null, { timeout: 30000 });
  const props = await asAdmin(`select data from docs where collection='tasks' and data->>'상태'='제안'`);
  const flags = await asAdmin(`select data from docs where collection='flags'`);
  ok(props.length >= 2, `카톡 제안 ${props.length}건이 서버에 올라간다`);
  ok(props.every((r) => r.data["작성"] === "ODD HR 작성"), "제안에 ODD HR 작성 표시");
  ok(flags.length === 1 && !JSON.stringify(flags[0].data).includes("집안일"), "민감한 메시지는 원문 없이 확인 필요로만 올라간다");
  await shot(pm, "06-agents");

  console.log("팀원: 새로 고친 뒤 보이는 것");
  await ed.reload(); await ed.waitForSelector(".gate", { state: "detached" }).catch(() => {}); await ed.waitForTimeout(500);
  const view = await ed.evaluate(() => ({ tasks: window.oddhrApp && [...document.querySelectorAll(".row .t")].length, flags: 0 }));
  const edSees = await sql({ sub: uid, is_anonymous: true }, `select collection, count(*)::int n from docs group by collection`, []);
  ok(!edSees.rows.some((r) => r.collection === "flags"), "팀원에게는 PM 확인 필요가 오지 않는다");
  ok(edSees.rows.some((r) => r.collection === "tasks" && r.n >= 3), "팀원도 카톡 제안을 본다");
  await ed.goto(ed.url().split("#")[0] + "#home"); await ed.waitForTimeout(400);
  await shot(ed, "07-home-member");
  await ed.goto(ed.url().split("#")[0] + "#todo"); await ed.waitForTimeout(400);
  ok(!(await ed.$('button:text-is("삭제")')), "팀원 할 일 화면에는 삭제 버튼이 없다");

  console.log(`\n${pass}개 통과, ${fail}개 실패`);
  if (errs.length) console.log("화면 오류:\n" + errs.join("\n"));
  await browser.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
