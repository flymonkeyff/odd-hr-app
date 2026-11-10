// Supabase 흉내: auth 스키마와 역할을 만들고 setup.sql을 그대로 실행한 뒤 권한을 시험한다
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs'); const path = require('path');
const SQL = fs.readFileSync(path.join(__dirname, '..', 'setup.sql'), 'utf8');
const PM = '11111111-1111-1111-1111-111111111111', EDIT = '22222222-2222-2222-2222-222222222222', OUT = '33333333-3333-3333-3333-333333333333', PM2 = '44444444-4444-4444-4444-444444444444';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  O', m); } else { fail++; console.log('  X', m); } };
(async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
    grant usage on schema auth to authenticated, anon; grant execute on all functions in schema auth to authenticated, anon;
    grant usage on schema public to authenticated, anon;
  `);
  await db.exec(SQL);
  await db.exec(SQL); // 두 번 실행해도 안전한지
  const as = async (uid, anon, fn) => {
    await db.exec(`reset role; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, is_anonymous: anon, role: 'authenticated' })}', false); set role authenticated;`);
    try { return await fn(); } finally { await db.exec('reset role'); }
  };
  const q = (sql, params) => db.query(sql, params);
  const tryq = async (sql, params) => { try { await q(sql, params); return null; } catch (e) { return e.message; } };

  console.log('프로젝트 만들기와 코드');
  let created = await as(PM, false, () => q(`select public.create_project('양천경찰서 영상','PM 나','2026-11-27','편집 완료') as r`));
  const { project_id: P, code } = created.rows[0].r;
  ok(/^ODD-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `코드 형식 ${code}`);
  ok(await as(EDIT, true, () => tryq(`select public.create_project('몰래','x')`)) !== null, '코드로 들어온 익명 계정은 프로젝트를 못 만든다');
  const P2 = (await as(PM2, false, () => q(`select public.create_project('다른 팀','남') as r`))).rows[0].r.project_id;

  console.log('코드로 들어오기');
  ok(await as(EDIT, true, () => tryq(`select public.join_project('ODD-AAAA-AAAA','편집이','편집')`)) !== null, '틀린 코드는 거절');
  const j = await as(EDIT, true, () => q(`select public.join_project($1,'편집이','편집') as r`, [code.toLowerCase().replace(/-/g, ' ')]));
  ok(j.rows[0].r.name === '양천경찰서 영상', '소문자·띄어쓰기로 쳐도 들어온다');
  const mem = await as(EDIT, true, () => q(`select role, is_pm from members where project_id=$1 and user_id=$2`, [P, EDIT]));
  ok(mem.rows[0].role === '편집' && mem.rows[0].is_pm === false, '팀원은 PM 권한 없이 들어온다');
  ok((await as(EDIT, true, () => q(`select count(*)::int n from projects`))).rows[0].n === 1, '팀원은 자기 프로젝트만 본다 (다른 팀 안 보임)');
  ok((await as(OUT, true, () => q(`select count(*)::int n from docs`))).rows[0].n === 0 && (await as(OUT, true, () => q(`select count(*)::int n from projects`))).rows[0].n === 0, '멤버가 아니면 아무것도 못 본다');
  ok((await as(EDIT, true, () => q(`select count(*)::int n from project_codes`))).rows[0].n === 0, '팀원은 코드를 못 본다');

  console.log('할 일');
  ok(await as(EDIT, true, () => tryq(`insert into docs(id,project_id,collection,data) values('t1',$1,'tasks','{"할 일":"엔딩 줄이기","상태":"진행"}')`, [P])) === null, '팀원이 할 일을 만든다');
  ok(await as(EDIT, true, () => tryq(`update docs set data = data || '{"상태":"검토 요청"}' where id='t1'`)) === null, '팀원이 검토 요청까지 올린다');
  const r1 = await as(EDIT, true, () => tryq(`update docs set data = data || '{"상태":"완료"}' where id='t1'`));
  ok(r1 && r1.includes('PM만'), `팀원은 완료 처리 못 함 (${r1})`);
  ok(await as(EDIT, true, () => tryq(`insert into docs(id,project_id,collection,data) values('t2',$1,'tasks','{"할 일":"몰래 완료","상태":"완료"}')`, [P])) !== null, '팀원은 완료 상태로 새로 만들지도 못 함');
  ok(await as(PM, false, () => tryq(`update docs set data = data || '{"상태":"완료"}' where id='t1'`)) === null, 'PM은 완료 처리한다');
  const del1 = await as(EDIT, true, () => q(`delete from docs where id='t1'`));
  ok(del1.affectedRows === 0, '팀원은 삭제 못 함');
  ok(await as(OUT, true, () => tryq(`insert into docs(id,project_id,collection,data) values('x1',$1,'tasks','{}')`, [P])) !== null, '멤버 아닌 사람은 못 쓴다');
  ok(await as(EDIT, true, () => tryq(`update docs set project_id=$1 where id='t1'`, [P2])) !== null, '팀원은 다른 프로젝트로 못 옮긴다');

  console.log('부분 수정 (patch_doc)');
  ok(await as(EDIT, true, () => tryq(`select public.patch_doc('t1', '{"메모":"a"}')`)) === null, '팀원이 일부 칸만 고친다');
  const r3 = await as(EDIT, true, () => tryq(`select public.patch_doc('t1', '{"상태":"진행"}')`));
  ok(r3 && r3.includes('PM만'), 'patch_doc로도 완료를 되돌리지 못한다');
  ok((await as(PM, false, () => q(`select data->>'메모' m, data->>'할 일' t from docs where id='t1'`))).rows[0].t === '엔딩 줄이기', '다른 칸은 그대로 남는다');
  ok(await as(OUT, true, () => tryq(`select public.patch_doc('t1', '{"x":1}')`)) !== null, '멤버 아닌 사람은 patch_doc 못 함');
  console.log('미팅');
  await as(PM, false, () => q(`insert into docs(id,project_id,collection,data) values('m1',$1,'meetings','{"제목":"주간 회의","일시":"2026-11-12T14:00"}')`, [P]));
  ok(await as(EDIT, true, () => tryq(`update docs set data = data || '{"노트":"엔딩 10초 줄이기로 함"}' where id='m1'`)) === null, '팀원은 노트를 적는다');
  const r2 = await as(EDIT, true, () => tryq(`update docs set data = data || '{"제목":"바꿈"}' where id='m1'`));
  ok(r2 && r2.includes('PM만'), '팀원은 미팅 정보를 못 고친다');
  ok(await as(PM, false, () => tryq(`update docs set data = data || '{"제목":"2차 회의","일시":"2026-11-16T16:30"}' where id='m1'`)) === null, 'PM은 미팅 정보를 고친다');

  console.log('PM 확인 필요와 개인 메모');
  ok(await as(PM, false, () => tryq(`insert into docs(id,project_id,collection,data) values('flag-1',$1,'flags','{"대화방":"팀방"}')`, [P])) === null, 'PM은 확인 필요를 쓴다');
  ok((await as(EDIT, true, () => q(`select count(*)::int n from docs where collection='flags'`))).rows[0].n === 0, '팀원은 확인 필요를 못 본다');
  ok(await as(EDIT, true, () => tryq(`insert into docs(id,project_id,collection,data) values('flag-2',$1,'flags','{}')`, [P])) !== null, '팀원은 확인 필요를 못 쓴다');
  await as(EDIT, true, () => q(`insert into docs(id,project_id,collection,data) values('q-1',$1,'quick','{"text":"내 메모"}')`, [P]));
  ok((await as(PM, false, () => q(`select count(*)::int n from docs where collection='quick'`))).rows[0].n === 0, 'PM도 팀원의 개인 메모는 못 본다');
  ok((await as(EDIT, true, () => q(`delete from docs where id='q-1'`))).affectedRows === 1, '본인 메모는 본인이 지운다');
  ok(await as(EDIT, true, () => tryq(`insert into docs(id,project_id,collection,data,owner) values('t9',$1,'tasks','{}',$2)`, [P, PM])) !== null, '남의 이름으로 문서를 만들 수 없다');

  console.log('팀원 단계와 역할');
  ok(await as(EDIT, true, () => tryq(`update members set stage='가편', stage_note='v02' where project_id=$1 and user_id=$2`, [P, EDIT])) === null, '팀원은 자기 단계를 바꾼다');
  ok(await as(EDIT, true, () => tryq(`update members set role='PM' where project_id=$1 and user_id=$2`, [P, EDIT])) !== null, '팀원은 자기 역할을 못 바꾼다');
  ok(await as(EDIT, true, () => tryq(`update members set is_pm=true where project_id=$1 and user_id=$2`, [P, EDIT])) !== null, '팀원은 스스로 PM이 못 된다');
  ok((await as(EDIT, true, () => q(`update members set stage='x' where project_id=$1 and user_id=$2`, [P, PM]))).affectedRows === 0, '팀원은 남의 단계를 못 바꾼다');
  ok(await as(PM, false, () => tryq(`update members set stage_checked_at=now(), stage_checked_by=$3 where project_id=$1 and user_id=$2`, [P, EDIT, PM])) === null, 'PM은 단계 확인을 체크한다');
  await as(EDIT, true, () => q(`update members set stage='수정' where project_id=$1 and user_id=$2`, [P, EDIT]));
  ok((await as(PM, false, () => q(`select stage_checked_at from members where project_id=$1 and user_id=$2`, [P, EDIT]))).rows[0].stage_checked_at === null, '팀원이 단계를 바꾸면 PM 확인이 풀린다');
  ok(await as(PM, false, () => tryq(`update members set role='촬영' where project_id=$1 and user_id=$2`, [P, EDIT])) === null, 'PM은 역할을 바꾼다');
  ok(await as(PM, false, () => tryq(`update members set is_pm=false where project_id=$1 and user_id=$2`, [P, PM])) !== null, '마지막 PM은 PM을 내려놓지 못한다');

  console.log('코드 다시 발급과 내보내기');
  ok(await as(EDIT, true, () => tryq(`select public.new_project_code($1)`, [P])) !== null, '팀원은 코드를 못 만든다');
  const c2 = (await as(PM, false, () => q(`select public.new_project_code($1) c`, [P]))).rows[0].c;
  ok(await as(OUT, true, () => tryq(`select public.join_project($1,'늦게','기획')`, [code])) !== null, '옛 코드는 막힌다');
  ok(await as(OUT, true, () => tryq(`select public.join_project($1,'늦게','기획')`, [c2])) === null, '새 코드로 들어온다');
  ok((await as(EDIT, true, () => q(`select count(*)::int n from members where project_id=$1 and user_id=$2`, [P, EDIT]))).rows[0].n === 1, '코드를 바꿔도 기존 멤버는 그대로');
  ok(await as(EDIT, true, () => tryq(`select public.remove_member($1,$2)`, [P, OUT])) !== null, '팀원은 남을 내보내지 못한다');
  ok(await as(PM, false, () => tryq(`select public.transfer_member($1,$2,$3)`, [P, EDIT, OUT])) === null, 'PM은 다시 깐 팀원에게 기록을 옮긴다');
  ok((await as(PM, false, () => q(`select owner from docs where id='t1'`))).rows[0].owner === OUT, '옮긴 뒤 문서 주인이 새 계정');
  ok(await as(PM, false, () => tryq(`select public.remove_member($1,$2)`, [P, OUT])) === null, 'PM은 멤버를 내보낸다');
  ok(await as(PM, false, () => tryq(`select public.remove_member($1,$2)`, [P, PM])) !== null, '마지막 PM은 나갈 수 없다');

  console.log(`\n${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
