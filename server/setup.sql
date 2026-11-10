-- ============================================================================
-- ODD HR 팀 서버 설정 (Supabase)
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여 넣고 Run.
-- 여러 번 실행해도 안전하다 (있는 것은 건너뛰거나 다시 만든다).
--
-- 만드는 것
--   projects       프로젝트 (이름, 마감)
--   members        프로젝트 멤버 (이름, 역할, PM 여부, 지금 단계)
--   project_codes  프로젝트 입장 코드 (PM이 발급)
--   docs           업무 데이터 (작업, 목표, 미팅, PM 확인 필요, 개인 메모)
--
-- 권한은 서버가 강제한다
--   - 멤버만 그 프로젝트를 본다. 코드로만 들어온다.
--   - 할 일 완료 처리와 되돌리기, 삭제, 미팅 정보 수정, 코드 발급, 역할 변경은 PM만.
--   - "PM 확인 필요"는 PM만 읽는다. 개인 메모(quick)는 본인만 읽는다.
-- ============================================================================

-- ---------------------------------------------------------------- 테이블
create table if not exists public.projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 80),
  deadline      date,
  deadline_label text check (deadline_label is null or char_length(deadline_label) <= 40),
  created_by    uuid not null default auth.uid(),
  created_at    timestamptz not null default now(),
  archived      boolean not null default false
);

create table if not exists public.members (
  project_id        uuid not null references public.projects(id) on delete cascade,
  user_id           uuid not null,
  name              text not null check (char_length(name) between 1 and 40),
  role              text not null check (role in ('PM','기획','디자인','촬영','편집')),
  is_pm             boolean not null default false,
  stage             text check (stage is null or char_length(stage) <= 40),
  stage_note        text check (stage_note is null or char_length(stage_note) <= 200),
  stage_updated_at  timestamptz,
  stage_checked_at  timestamptz,
  stage_checked_by  uuid,
  joined_at         timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.project_codes (
  code        text primary key,
  project_id  uuid not null references public.projects(id) on delete cascade,
  created_by  uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  revoked     boolean not null default false,
  uses        integer not null default 0
);

create table if not exists public.docs (
  id          text primary key check (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  project_id  uuid not null references public.projects(id) on delete cascade,
  collection  text not null check (collection in ('tasks','goals','meetings','flags','quick')),
  data        jsonb not null default '{}'::jsonb check (pg_column_size(data) < 65536),
  owner       uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists docs_project_idx on public.docs (project_id, collection);
create index if not exists members_user_idx on public.members (user_id);

-- ---------------------------------------------------------------- 권한 도우미
create or replace function public.is_member(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where project_id = p and user_id = auth.uid());
$$;

create or replace function public.is_pm(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where project_id = p and user_id = auth.uid() and is_pm);
$$;

create or replace function public.is_anon() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

create or replace function public.new_code_text() returns text
language plpgsql volatile as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 헷갈리는 0 O 1 I 제외
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');  -- 무작위 바이트 (확장 없이)
  s text := '';
begin
  for i in 0..7 loop
    s := s || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return 'ODD-' || substr(s, 1, 4) || '-' || substr(s, 5, 4);
end $$;

-- ---------------------------------------------------------------- 행 단위 권한
alter table public.projects      enable row level security;
alter table public.members       enable row level security;
alter table public.project_codes enable row level security;
alter table public.docs          enable row level security;

drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select using (public.is_member(id));
drop policy if exists projects_pm_update on public.projects;
create policy projects_pm_update on public.projects for update using (public.is_pm(id)) with check (public.is_pm(id));

drop policy if exists members_read on public.members;
create policy members_read on public.members for select using (public.is_member(project_id));
drop policy if exists members_update on public.members;
create policy members_update on public.members for update
  using (user_id = auth.uid() or public.is_pm(project_id))
  with check (user_id = auth.uid() or public.is_pm(project_id));

drop policy if exists codes_pm_read on public.project_codes;
create policy codes_pm_read on public.project_codes for select using (public.is_pm(project_id));

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select using (
  public.is_member(project_id)
  and (collection <> 'flags' or public.is_pm(project_id))
  and (collection <> 'quick' or owner = auth.uid())
);
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert with check (
  public.is_member(project_id)
  and owner = auth.uid()
  and (collection <> 'flags' or public.is_pm(project_id))
);
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update
  using (public.is_member(project_id) and (collection <> 'flags' or public.is_pm(project_id)) and (collection <> 'quick' or owner = auth.uid()))
  with check (public.is_member(project_id) and (collection <> 'flags' or public.is_pm(project_id)) and (collection <> 'quick' or owner = auth.uid()));
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete using (
  public.is_pm(project_id) or (collection = 'quick' and owner = auth.uid())
);

-- ---------------------------------------------------------------- 규칙 트리거
-- 할 일 완료·되돌리기는 PM만, 미팅 정보는 PM만, 프로젝트 옮기기는 양쪽 PM만, 컬렉션·주인은 못 바꿈
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pm boolean := public.is_pm(new.project_id);
  k text;
begin
  if tg_op = 'INSERT' then
    if new.collection = 'tasks' and new.data ->> '상태' = '완료' and not pm then
      raise exception 'PM만 완료 처리할 수 있습니다' using errcode = '42501';
    end if;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  -- UPDATE
  if new.collection <> old.collection or new.id <> old.id then
    raise exception '문서의 종류는 바꿀 수 없습니다' using errcode = '42501';
  end if;
  if new.owner <> old.owner and not pm then
    raise exception '문서 주인은 PM만 바꿀 수 있습니다' using errcode = '42501';
  end if;
  if new.project_id <> old.project_id and not (public.is_pm(old.project_id) and pm) then
    raise exception '다른 프로젝트로 옮기는 것은 두 프로젝트의 PM만 할 수 있습니다' using errcode = '42501';
  end if;
  if new.collection = 'tasks' and not pm
     and (coalesce(new.data ->> '상태', '') = '완료') <> (coalesce(old.data ->> '상태', '') = '완료') then
    raise exception 'PM만 완료 처리하거나 되돌릴 수 있습니다' using errcode = '42501';
  end if;
  if new.collection = 'meetings' and not pm then
    foreach k in array array['제목','종류','프로젝트','일시','참석자','아젠다'] loop
      if (new.data -> k) is distinct from (old.data -> k) then
        raise exception 'PM만 미팅 정보를 고칠 수 있습니다' using errcode = '42501';
      end if;
    end loop;
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs for each row execute function public.docs_guard();

-- 멤버: 본인은 이름과 단계만, 역할·PM·단계 확인은 PM만
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.project_id <> old.project_id or new.user_id <> old.user_id then
    raise exception '프로젝트나 사람은 바꿀 수 없습니다' using errcode = '42501';
  end if;
  if not public.is_pm(old.project_id) then
    if new.role <> old.role or new.is_pm <> old.is_pm
       or new.stage_checked_at is distinct from old.stage_checked_at
       or new.stage_checked_by is distinct from old.stage_checked_by then
      raise exception '역할과 확인 표시는 PM만 바꿀 수 있습니다' using errcode = '42501';
    end if;
  end if;
  if old.is_pm and not new.is_pm
     and not exists (select 1 from members where project_id = old.project_id and is_pm and user_id <> old.user_id) then
    raise exception '마지막 PM은 PM 권한을 내려놓을 수 없습니다' using errcode = '42501';
  end if;
  if new.stage is distinct from old.stage or new.stage_note is distinct from old.stage_note then
    new.stage_updated_at := now();
    if not public.is_pm(old.project_id) then
      new.stage_checked_at := null; new.stage_checked_by := null;  -- 단계를 바꾸면 PM 확인을 다시 받는다
    end if;
  end if;
  return new;
end $$;
drop trigger if exists members_guard on public.members;
create trigger members_guard before update on public.members for each row execute function public.members_guard();

-- ---------------------------------------------------------------- 기능 (RPC)
-- PM이 프로젝트를 만든다. 이메일 계정만 (코드로 들어온 익명 계정은 못 만듦)
create or replace function public.create_project(p_name text, p_my_name text, p_deadline date default null, p_label text default null)
returns json language plpgsql security definer set search_path = public as $$
declare pid uuid; c text;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다' using errcode = '42501'; end if;
  if public.is_anon() then raise exception '프로젝트는 PM 계정(이메일)으로만 만들 수 있습니다' using errcode = '42501'; end if;
  insert into projects (name, deadline, deadline_label, created_by) values (trim(p_name), p_deadline, nullif(trim(coalesce(p_label, '')), ''), auth.uid()) returning id into pid;
  insert into members (project_id, user_id, name, role, is_pm) values (pid, auth.uid(), trim(p_my_name), 'PM', true);
  loop
    c := public.new_code_text();
    exit when not exists (select 1 from project_codes where code = c);
  end loop;
  insert into project_codes (code, project_id, created_by) values (c, pid, auth.uid());
  return json_build_object('project_id', pid, 'code', c);
end $$;

-- 코드로 들어온다. 같은 사람이 다시 넣으면 이름과 역할만 고친다 (PM이 정한 역할은 유지)
create or replace function public.join_project(p_code text, p_name text, p_role text)
returns json language plpgsql security definer set search_path = public as $$
declare pid uuid; pname text; norm text;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다' using errcode = '42501'; end if;
  if p_role not in ('기획','디자인','촬영','편집','PM') then raise exception '역할이 올바르지 않습니다' using errcode = '22023'; end if;
  norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if norm like 'ODD%' then norm := substr(norm, 4); end if;
  if char_length(norm) <> 8 then raise exception '코드를 찾지 못했습니다' using errcode = 'P0002'; end if;
  select pc.project_id, p.name into pid, pname
    from project_codes pc join projects p on p.id = pc.project_id
   where pc.code = 'ODD-' || substr(norm, 1, 4) || '-' || substr(norm, 5, 4) and not pc.revoked and not p.archived;
  if pid is null then raise exception '코드를 찾지 못했습니다' using errcode = 'P0002'; end if;
  insert into members (project_id, user_id, name, role, is_pm)
       values (pid, auth.uid(), trim(p_name), p_role, false)
  on conflict (project_id, user_id) do update set name = excluded.name;
  update project_codes set uses = uses + 1 where code = 'ODD-' || substr(norm, 1, 4) || '-' || substr(norm, 5, 4);
  return json_build_object('project_id', pid, 'name', pname);
end $$;

-- PM이 코드를 새로 발급한다 (이전 코드는 막는다. 이미 들어온 멤버는 그대로)
create or replace function public.new_project_code(p_project uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_pm(p_project) then raise exception 'PM만 코드를 발급할 수 있습니다' using errcode = '42501'; end if;
  update project_codes set revoked = true where project_id = p_project and not revoked;
  loop
    c := public.new_code_text();
    exit when not exists (select 1 from project_codes where code = c);
  end loop;
  insert into project_codes (code, project_id, created_by) values (c, p_project, auth.uid());
  return c;
end $$;

create or replace function public.close_project_code(p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_pm(p_project) then raise exception 'PM만 코드를 막을 수 있습니다' using errcode = '42501'; end if;
  update project_codes set revoked = true where project_id = p_project and not revoked;
end $$;

-- PM이 멤버를 내보내거나, 본인이 나간다. 마지막 PM은 못 나감
create or replace function public.remove_member(p_project uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_pm(p_project) or p_user = auth.uid()) then raise exception 'PM만 멤버를 내보낼 수 있습니다' using errcode = '42501'; end if;
  if exists (select 1 from members where project_id = p_project and user_id = p_user and is_pm)
     and not exists (select 1 from members where project_id = p_project and is_pm and user_id <> p_user) then
    raise exception '마지막 PM은 나갈 수 없습니다' using errcode = '42501';
  end if;
  delete from members where project_id = p_project and user_id = p_user;
end $$;

-- 앱을 다시 깔아 새 계정이 된 팀원에게 이전 기록(내가 만든 문서와 단계)을 옮긴다
create or replace function public.transfer_member(p_project uuid, p_from uuid, p_to uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r members%rowtype;
begin
  if not public.is_pm(p_project) then raise exception 'PM만 옮길 수 있습니다' using errcode = '42501'; end if;
  select * into r from members where project_id = p_project and user_id = p_from;
  if r.user_id is null or not exists (select 1 from members where project_id = p_project and user_id = p_to) then
    raise exception '두 사람 모두 이 프로젝트 멤버여야 합니다' using errcode = '22023';
  end if;
  update docs set owner = p_to where project_id = p_project and owner = p_from and collection <> 'quick';
  update members set role = r.role, stage = r.stage, stage_note = r.stage_note where project_id = p_project and user_id = p_to;
  delete from members where project_id = p_project and user_id = p_from;
end $$;

-- 문서 일부만 고친다 (여러 사람이 동시에 고쳐도 서로 덮어쓰지 않게). 권한과 규칙은 그대로 적용된다
create or replace function public.patch_doc(p_id text, p_patch jsonb, p_project uuid default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update docs set data = data || coalesce(p_patch, '{}'::jsonb), project_id = coalesce(p_project, project_id) where id = p_id;
  if not found then raise exception '문서를 찾지 못했거나 고칠 권한이 없습니다' using errcode = '42501'; end if;
end $$;

-- ---------------------------------------------------------------- 공개 범위
revoke all on function public.create_project(text, text, date, text) from public;
revoke all on function public.join_project(text, text, text) from public;
revoke all on function public.new_project_code(uuid) from public;
revoke all on function public.close_project_code(uuid) from public;
revoke all on function public.remove_member(uuid, uuid) from public;
revoke all on function public.transfer_member(uuid, uuid, uuid) from public;
grant execute on function public.create_project(text, text, date, text) to authenticated;
grant execute on function public.join_project(text, text, text) to authenticated;
grant execute on function public.new_project_code(uuid) to authenticated;
grant execute on function public.close_project_code(uuid) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.transfer_member(uuid, uuid, uuid) to authenticated;
revoke all on function public.patch_doc(text, jsonb, uuid) from public;
grant execute on function public.patch_doc(text, jsonb, uuid) to authenticated;

grant select, update on public.projects to authenticated;
grant select, update on public.members to authenticated;
grant select on public.project_codes to authenticated;
grant select, insert, update, delete on public.docs to authenticated;
revoke all on public.projects, public.members, public.project_codes, public.docs from anon;

-- ---------------------------------------------------------------- 실시간 반영
alter table public.docs replica identity full;
alter table public.members replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.docs; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.members; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.projects; exception when duplicate_object then null; end;
  end if;
end $$;
