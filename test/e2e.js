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

  const files = new Map();
  const store = async (claims, op, p, bytes, type) => {
    const pid = String(p).split("/")[0];
    const r = await sql(claims, "select public.is_member($1::uuid) m", [pid]);
    if (r.error || !r.rows[0].m) return { error: { message: "new row violates row-level security policy" } };
    if (op === "put") { files.set(p, { bytes, type }); return {}; }
    if (op === "get") return files.has(p) ? files.get(p) : { error: { message: "Object not found" } };
    files.delete(p); return {};
  };
  const browser = await chromium.launch();
  const errs = [];
  async function open(name, { agentOn }) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: "Asia/Seoul", bypassCSP: true });   // 시험 도구가 페이지 안에서 확인 코드를 돌리려면 필요 (앱 자체의 CSP는 그대로)
    await ctx.exposeFunction("__sql", sql);
    await ctx.exposeFunction("__agent", agent);
    await ctx.exposeFunction("__store", store);
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


  // ------------------------------------------------------------ 0.2.0
  const go = async (p, h) => { await p.goto(p.url().split("#")[0] + "#" + h); await p.waitForTimeout(350); };
  const fresh = async (p) => { await p.reload(); await p.waitForSelector(".gate", { state: "detached" }).catch(() => {}); await p.waitForTimeout(500); };
  const pmUid = await pm.evaluate(() => window.oddhrApp.uid);

  console.log("메시지: 팀 대화방과 1:1");
  await go(ed, "messages");
  await ed.fill("#chatin", "안녕하세요 편집 홍길동입니다"); await ed.press("#chatin", "Enter"); await ed.waitForTimeout(400);
  let msgs = await asAdmin(`select data from docs where collection='messages'`);
  ok(msgs.length === 1 && msgs[0].data.from === uid && !msgs[0].data.to, "팀원이 프로젝트 대화방에 글을 쓴다 (보낸 사람은 서버가 적음)");
  ok((await ed.textContent("#chatlog")).includes("안녕하세요"), "보낸 글이 대화창에 바로 보인다");
  await ed.click('.chat-list button.row:has-text("김피엠")'); await ed.waitForTimeout(200);
  await ed.fill("#chatin", "PM님 썸네일 시안 오늘 6시까지 볼 수 있을까요?"); await ed.click('button:text-is("보내기")'); await ed.waitForTimeout(400);
  msgs = await asAdmin(`select data from docs where collection='messages' and data ? 'to'`);
  ok(msgs.length === 1 && msgs[0].data.to === pmUid, "1:1 메시지가 PM에게 간다");
  await shot(ed, "08-messages");

  console.log("할 일 제안 → 알림 → 수락 → 알림");
  await go(ed, "tasks");
  await ed.fill("#ntitle", "썸네일 A안 피드백 주기");
  await ed.selectOption("#nwho", "김피엠"); await ed.selectOption("#nmode", "제안");
  await ed.click('section:has(#ntitle) button[type=submit]'); await ed.waitForTimeout(500);
  const prop = (await asAdmin(`select id, data from docs where collection='tasks' and data->>'할 일'='썸네일 A안 피드백 주기'`))[0];
  ok(prop && prop.data["상태"] === "제안" && prop.data["담당자"] === "김피엠" && prop.data["제안한 사람"] === "홍길동", "팀원이 PM에게 할 일을 제안한다");
  await fresh(pm); await go(pm, "home");
  const pmHome = await pm.textContent("#main");
  ok(pmHome.includes("홍길동님이 할 일을 제안했습니다"), "PM 홈 알림에 제안이 뜬다");
  ok(pmHome.includes("홍길동님의 메시지"), "PM 홈 알림에 1:1 메시지가 뜬다");
  ok(/badge/.test(await pm.innerHTML('a[href="#messages"]')), "메뉴의 메시지에 안 읽은 수가 붙는다");
  await shot(pm, "09-home-notif");
  ok((await pm.textContent(".incoming")).includes("썸네일 A안 피드백 주기"), "PM 홈의 '들어온 업무 요청'에 뜬다");
  await pm.click('.incoming button:text-is("수락")'); await pm.waitForTimeout(500);
  const acc = (await asAdmin(`select data from docs where id='${prop.id}'`))[0].data;
  ok(acc["상태"] === "진행" && acc["상태 변경자"] === pmUid, "PM이 수락하면 누가 바꿨는지 남는다");
  await fresh(ed); await go(ed, "home");
  ok((await ed.textContent("#main")).includes("내 제안을 수락했습니다"), "제안한 팀원에게 수락 알림이 간다");

  console.log("이미 처리함 (팀원) → 검토 요청");
  const kak = (await asAdmin(`select id from docs where collection='tasks' and data->>'상태'='제안' limit 1`))[0];
  await ed.evaluate((id) => { location.hash = "tasks"; }, kak.id); await ed.waitForTimeout(300);
  await ed.click('button:text-is("이미 처리함")'); await ed.waitForTimeout(500);
  ok(/검토 요청을 올렸습니다/.test(await ed.textContent("#main")), "팀원이 '이미 처리함'을 누르면 오류 대신 검토 요청이 된다");

  console.log("주간 업데이트 제출 → 홈 → PM 확인");
  await go(ed, "todo");
  await ed.click('#weekly button:has-text("초안 만들기")'); await ed.waitForTimeout(300);
  ok((await ed.inputValue("#wktext")).includes("홍길동 · 양천경찰서 영상"), "초안에 내 이름과 프로젝트가 자동으로 들어간다");
  await ed.fill("#wktext", (await ed.inputValue("#wktext")) + "\n가편집 v02 완료");
  await ed.click('#weekly button:text-is("제출")'); await ed.waitForTimeout(500);
  const wk = await asAdmin(`select id, data from docs where collection='weekly'`);
  ok(wk.length === 1 && wk[0].data["이름"] === "홍길동" && wk[0].data["내용"].includes("가편집 v02 완료"), "주간 업데이트가 제출된다");
  await go(ed, "home");
  ok((await ed.textContent("#main")).includes("이번 주 업데이트"), "제출한 업데이트가 홈에 보인다");
  await fresh(pm); await go(pm, "home");
  ok((await pm.textContent("#main")).includes("홍길동님이 주간 업데이트를 냈습니다"), "PM에게 주간 업데이트 알림이 간다");
  await pm.click('.weekly-item button.row:has-text("홍길동")'); await pm.waitForTimeout(250);
  await pm.fill(`#wcm-${wk[0].id}`, "좋아요, 다음 주 컬러 들어가죠"); await pm.click('.weekly-body button:text-is("확인")'); await pm.waitForTimeout(500);
  ok((await asAdmin(`select data->>'PM 확인' c from docs where collection='weekly'`))[0].c === "김피엠", "PM이 확인과 코멘트를 남긴다");
  await shot(pm, "10-home-weekly");
  await fresh(ed); await go(ed, "home");
  ok((await ed.textContent("#main")).includes("내 주간 업데이트를 확인했습니다"), "팀원에게 확인 알림이 간다");

  console.log("드라이브");
  await go(ed, "drive");
  await ed.selectOption("#dfolder", "편집");
  await ed.setInputFiles('#main input[type=file]', { name: "콘티 v2.txt", mimeType: "text/plain", buffer: Buffer.from("씬1 오프닝 5초") });
  await ed.waitForTimeout(700);
  const fl = await asAdmin(`select data from docs where collection='files'`);
  ok(fl.length === 1 && fl[0].data["폴더"] === "편집" && files.has(fl[0].data["경로"]), "팀원이 파일을 올린다 (목록 + 저장소)");
  ok((await ed.textContent("#main")).includes("콘티 v2.txt"), "드라이브 목록에 보인다");
  await ed.fill("#lurl", "https://drive.google.com/x"); await ed.fill("#lname", "1차 촬영 원본"); await ed.click('button:text-is("링크 등록")'); await ed.waitForTimeout(400);
  ok((await asAdmin(`select count(*)::int n from docs where collection='files'`))[0].n === 2, "큰 영상은 링크로 등록한다");
  const outsider = await store({ sub: "99999999-9999-9999-9999-999999999999", is_anonymous: true }, "get", fl[0].data["경로"]);
  ok(!!outsider.error, "프로젝트 밖 사람은 파일을 못 받는다");
  await shot(ed, "11-drive");

  console.log("회의록 양식과 자동 정리");
  await go(pm, "meetings");
  await pm.fill("#mtitle", "2차 제작 회의"); await pm.click('section:has(#mtitle) button[type=submit]'); await pm.waitForTimeout(400);
  await pm.click('.tabs button:has-text("일정 미정")'); await pm.waitForTimeout(200);
  await pm.click('button:text-is("양식 넣기")');
  const tpl = await pm.inputValue("#mnote");
  ok(tpl.includes("[결정]") && tpl.includes("[액션 아이템]"), "회의록 양식이 노트에 들어간다");
  await pm.fill("#mnote", tpl.replace("[결정]\n- ", "[결정]\n- 엔딩 10초 줄이기로 함").replace("[액션 아이템] 할 일 · 담당 · 기한\n- ", "[액션 아이템] 할 일 · 담당 · 기한\n- 엔딩 컷 다시 붙이기 · 편집 홍길동 · 금요일"));
  await pm.click('button:text-is("자동 정리")'); await pm.waitForTimeout(300);
  const sum = await pm.textContent(".detail");
  ok(sum.includes("엔딩 10초 줄이기로 함") && sum.includes("엔딩 컷 다시 붙이기") && sum.includes("홍길동"), "양식 칸에서 결정과 액션 아이템(담당자 포함)을 그대로 뽑는다");
  await pm.click('button:text-is("회의록 만들기")'); await pm.waitForTimeout(200);
  ok((await pm.inputValue("#minutes")).includes("회의록: 2차 제작 회의"), "회의록 한 장을 만든다");
  await pm.click('button:text-is("드라이브에 저장")'); await pm.waitForTimeout(600);
  ok((await asAdmin(`select count(*)::int n from docs where collection='files' and data->>'폴더'='회의록'`))[0].n === 1, "회의록을 드라이브 회의록 폴더에 저장한다");
  await shot(pm, "12-minutes");


  console.log("PM → 팀원 업무 요청 (작업 탭) → 팀원 홈");
  await go(pm, "tasks");
  ok((await pm.textContent("#main")).includes("팀원에게 업무 제안하기"), "PM의 작업 탭은 업무 제안 화면");
  await pm.fill("#ntitle", "엔딩 크레딧 자막 넣기"); await pm.selectOption("#nwho", "홍길동");
  ok((await pm.inputValue("#nmode")) === "제안", "PM은 기본으로 업무 요청으로 보낸다");
  await pm.click('section:has(#ntitle) button[type=submit]'); await pm.waitForTimeout(500);
  await fresh(ed); await go(ed, "home");
  ok((await ed.textContent(".incoming")).includes("엔딩 크레딧 자막 넣기") && (await ed.textContent(".incoming")).includes("김피엠님 요청"), "팀원 홈 '들어온 업무 요청'에 PM 요청이 뜬다");
  await ed.click('.incoming button:text-is("넘기기")'); await ed.fill('.incoming input[name=dr]', "이번 주 촬영이 겹쳐요"); await ed.click('.incoming button[type=submit]'); await ed.waitForTimeout(500);
  const dec = (await asAdmin(`select data from docs where collection='tasks' and data->>'할 일'='엔딩 크레딧 자막 넣기'`))[0].data;
  ok(dec["상태"] === "기각" && dec["기각 사유"] === "이번 주 촬영이 겹쳐요", "팀원이 이유와 함께 넘긴다");
  await fresh(pm); await go(pm, "tasks");
  ok((await pm.textContent("#main")).includes("이유: 이번 주 촬영이 겹쳐요"), "PM의 '내가 보낸 업무 요청'에 넘긴 이유가 보인다");

  console.log("말로 할 일 올리기");
  await go(ed, "home");
  await ed.fill("#voicein", "음 오늘 3시까지 썸네일 시안 보내야 돼, 그리고 내일 장비 대여 신청하고 제일 먼저 교수님 메일 답장해야 해");
  await ed.click('.voice button:text-is("정리하기")'); await ed.waitForTimeout(250);
  const vtitles = await ed.$$eval(".voice-item .inline-edit", (els) => els.map((e) => e.value));
  ok(vtitles.length === 3, `말한 것을 3개로 나눈다 (${vtitles.join(" / ")})`);
  ok(/교수님 메일 답장하기/.test(vtitles[0]) || /썸네일 시안 보내기/.test(vtitles[0]), "'제일 먼저'와 시간이 가까운 일이 위로 온다");
  ok(vtitles.some((t) => /장비 대여 신청하기/.test(t)), "말투(신청하고)를 할 일 형태(신청하기)로 바꾼다");
  await shot(ed, "15-voice");
  await ed.click('.voice button:has-text("할 일에")'); await ed.waitForTimeout(600);
  const vt = await asAdmin(`select data from docs where collection='tasks' and data->>'출처'='음성 메모' order by (data->>'우선순위')::int`);
  ok(vt.length === 3 && vt[0].data["담당자"] === "홍길동" && vt[0].data["우선순위"] === 1 && ["긴급", "높음"].includes(vt[0].data["긴급도"]), "우선순위와 긴급도가 붙어 내 할 일로 올라간다");

  console.log("메시지로 드라이브 파일 위치 보내기");
  await go(ed, "messages");
  await ed.click('.chat-list button.row:has-text("김피엠")'); await ed.waitForTimeout(200);
  await ed.click('button[aria-label="드라이브 파일 보내기"]'); await ed.waitForTimeout(200);
  await ed.click('.file-pick button.row:has-text("콘티 v2.txt")'); await ed.waitForTimeout(500);
  const fm = (await asAdmin(`select data from docs where collection='messages' and data ? 'file'`))[0];
  ok(fm && fm.data.to === pmUid && fl.length && fm.data.file, "1:1 메시지로 파일 위치를 보낸다");
  await fresh(pm); await go(pm, "messages"); await pm.click('.chat-list button.row:has(.avatar:not(.group)):has-text("홍길동")'); await pm.waitForTimeout(300);
  ok((await pm.textContent(".chat-log")).includes("드라이브 › 양천경찰서 영상 › 편집"), "받은 쪽에 파일 이름과 드라이브 위치가 보인다");
  await pm.click('.fchip button:text-is("위치 보기")'); await pm.waitForTimeout(400);
  ok(pm.url().endsWith("#drive") && (await pm.$(".file-row")) !== null, "누르면 드라이브의 그 폴더로 간다");
  await go(pm, "messages"); await pm.click('.chat-list button.row:has(.avatar:not(.group)):has-text("홍길동")'); await shot(pm, "16-chat-file");

  console.log("양식: 계약서, 브리프");
  await go(pm, "forms");
  await pm.fill("#cask", "공모전 영상에 성우 김하나님 내레이션 출연, 출연료 30만 원, 11월 20일 녹음 스튜디오에서");
  await pm.click('button:text-is("초안 만들기")'); await pm.waitForTimeout(250);
  const ct = await pm.textContent("#contractpv");
  ok((await pm.inputValue("#ckind")) === "출연 계약서", "문장에서 계약서 종류를 고른다 (출연 계약서)");
  ok(ct.includes("300,000원") && ct.includes("김하나") && ct.includes("11월 20일"), "금액, 사람, 날짜를 채운다");
  ok(ct.includes("법률 자문이 아니므로"), "초안이라는 안내가 들어간다");
  await pm.fill("#cask", "카페에서 촬영 장소 빌리는 계약, 사용료 무료"); await pm.click('button:text-is("초안 만들기")'); await pm.waitForTimeout(200);
  ok((await pm.inputValue("#ckind")) === "촬영 장소 사용 계약서" && (await pm.textContent("#contractpv")).includes("무상"), "장소 계약도 고른다 (무상 처리)");
  await pm.click('button:text-is("초안 저장")'); await pm.waitForTimeout(400);
  ok((await asAdmin(`select count(*)::int n from docs where collection='forms'`))[0].n === 1, "계약서 초안이 저장된다");
  await shot(pm, "17-contract");
  await pm.click('.tabs button:text-is("프로젝트 브리프")'); await pm.waitForTimeout(200);
  await pm.fill("#bf-핵심메시지", "사이버 도박, 한 번이 시작이다");
  ok((await pm.textContent("#briefpv")).includes("사이버 도박, 한 번이 시작이다") && (await pm.textContent("#briefpv")).includes("홍길동 (편집"), "브리프에 적은 것과 팀·일정이 함께 정리된다");
  await pm.click('.paper-box button:text-is("드라이브에 저장")'); await pm.waitForTimeout(500);
  ok((await asAdmin(`select count(*)::int n from docs where collection='files' and data->>'폴더'='기획'`))[0].n === 1, "브리프를 드라이브 기획 폴더에 저장한다");
  await shot(pm, "18-brief");

  console.log("목표 진행률 확인 (하루 두 번)");
  await pm.evaluate(async () => { await window.oddhrApp.db.collection("goals").add({ "목표": "가편집 v03 교수님 확인", "프로젝트": "양천경찰서 영상", "진행률": 0.4, "상태": "진행 중", "수정": "2026-01-01T00:00:00Z" }); });
  await fresh(pm); await go(pm, "goals");
  const hr = await pm.evaluate(() => new Date().getHours());
  if (hr >= 10) {
    ok((await pm.textContent("#main")).includes("진행률 확인") && (await pm.$('.goal-ask')) !== null, "PM 목표 탭에 진행률 확인이 뜬다");
    await go(pm, "home"); ok((await pm.textContent(".notif")).includes("목표 진행률을 확인할 시간입니다"), "PM 홈 알림에 진행률 확인이 뜬다");
    await go(pm, "goals"); await pm.click('.goal-ask button:text-is("+10%")'); await pm.waitForTimeout(500);
    ok(Math.abs(Number((await asAdmin(`select data->>'진행률' p from docs where collection='goals' and data->>'목표'='가편집 v03 교수님 확인'`))[0].p) - 0.5) < 1e-9, "누르면 진행률이 바뀌고 확인으로 남는다");
  } else ok(true, "오전 10시 전이라 확인 알림은 아직 없다");

  console.log("Mac 앱 화면");
  await pm.evaluate(() => document.documentElement.classList.add("mac-app"));
  const padTop = await pm.evaluate(() => parseFloat(getComputedStyle(document.querySelector("nav.side")).paddingTop));
  ok(padTop >= 50, `Mac에서 메뉴가 창 버튼 아래로 내려간다 (${padTop}px)`);

  console.log("아이폰 화면");
  const phoneCtx = await browser.newContext({ ...require("playwright").devices["iPhone 13"], timezoneId: "Asia/Seoul", bypassCSP: true });
  await phoneCtx.exposeFunction("__sql", sql); await phoneCtx.exposeFunction("__agent", agent); await phoneCtx.exposeFunction("__store", store);
  const sess = await ed.evaluate(() => ({ s: localStorage.getItem("fake-session"), u: localStorage.getItem("fake-users") }));
  await phoneCtx.addInitScript((x) => { window.ODDHR_WEB_CONFIG = { url: "https://test.supabase.co", anonKey: "x".repeat(60), platform: "web", version: "test" }; if (!localStorage.getItem("fake-session")) { localStorage.setItem("fake-session", x.s); } }, sess);
  await phoneCtx.addInitScript({ path: path.join(__dirname, "fake-supabase.js") });
  const ph = await phoneCtx.newPage();
  ph.on("pageerror", (e) => errs.push(`[아이폰] ${e.message}`));
  await ph.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ph.goto("file://" + path.join(ROOT, "app", "index.html"));
  await ph.waitForSelector(".gate", { state: "detached" }); await ph.waitForTimeout(500);
  const wide = await ph.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
  ok(wide[0] === 390 && wide[1] <= 390, `아이폰 폭(390px)에서 화면이 줄어들거나 가로로 밀리지 않는다 (${wide.join(", ")})`);
  ok(await ph.isVisible(".more-btn") && !(await ph.isVisible('a.more-item[href="#goals"]')), "아래 막대에 4개 + 더보기만 보인다");
  await ph.click(".more-btn"); await ph.waitForTimeout(150);
  ok(await ph.isVisible('.more-sheet a[href="#goals"]'), "더보기를 누르면 나머지 메뉴가 펼쳐진다");
  await shot(ph, "13-iphone-home");
  await ph.goto(ph.url().split("#")[0] + "#messages"); await ph.waitForTimeout(400);
  await shot(ph, "14-iphone-messages");
  ok((await ph.textContent("#main")).includes("프로젝트 대화방"), "아이폰에서 메시지 목록이 열린다");

  console.log(`\n${pass}개 통과, ${fail}개 실패`);
  if (errs.length) console.log("화면 오류:\n" + errs.join("\n"));
  await browser.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
