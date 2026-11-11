-- ============================================================================
-- ODD HR 0.2.0 서버 업데이트: 메시지, 드라이브, 주간 업데이트, 양식
-- 0.1.0 서버를 쓰던 팀은 Supabase → SQL Editor 에 이 부분만 붙여 넣고 Run.
-- (setup.sql 맨 아래에도 같은 내용이 들어 있다. 여러 번 실행해도 안전하다.)
--
--   messages  프로젝트 대화방 글과 1:1 메시지 (받는 사람이 있으면 두 사람만 읽는다)
--   files     드라이브 목록 (파일은 저장소 oddhr 버킷, 큰 영상은 링크로 등록)
--   weekly    주간 업데이트 (본인이 제출, PM은 확인 표시만)
--   forms     양식: 계약서 초안, 프로젝트 브리프 (만든 사람과 PM이 고침)
-- ============================================================================
alter table public.docs drop constraint if exists docs_collection_check;
alter table public.docs add constraint docs_collection_check
  check (collection in ('tasks','goals','meetings','flags','quick','messages','files','weekly','forms'));

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select using (
  public.is_member(project_id)
  and (collection <> 'flags' or public.is_pm(project_id))
  and (collection <> 'quick' or owner = auth.uid())
  and (collection <> 'messages' or not (data ? 'to') or owner = auth.uid() or data ->> 'to' = auth.uid()::text)
);
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert with check (
  public.is_member(project_id)
  and owner = auth.uid()
  and (collection <> 'flags' or public.is_pm(project_id))
  and (collection <> 'messages' or not (data ? 'to')
       or exists (select 1 from public.members m where m.project_id = docs.project_id and m.user_id::text = docs.data ->> 'to'))
);
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update
  using (public.is_member(project_id)
     and (collection <> 'flags' or public.is_pm(project_id))
     and (collection <> 'quick' or owner = auth.uid())
     and (collection <> 'messages' or owner = auth.uid())
     and (collection not in ('weekly','files','forms') or owner = auth.uid() or public.is_pm(project_id)))
  with check (public.is_member(project_id)
     and (collection <> 'flags' or public.is_pm(project_id))
     and (collection <> 'quick' or owner = auth.uid())
     and (collection <> 'messages' or owner = auth.uid())
     and (collection not in ('weekly','files','forms') or owner = auth.uid() or public.is_pm(project_id)));
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete using (
  public.is_pm(project_id) or (collection in ('quick','messages','files','weekly','forms') and owner = auth.uid())
);

create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pm boolean := public.is_pm(new.project_id);
  k text;
  keep text[] := array['PM 확인','PM 확인 시각','PM 코멘트'];
begin
  if tg_op = 'INSERT' then
    if new.collection = 'tasks' and new.data ->> '상태' = '완료' and not pm then
      raise exception 'PM만 완료 처리할 수 있습니다' using errcode = '42501';
    end if;
    if new.collection = 'messages' and char_length(trim(coalesce(new.data ->> 'text', ''))) not between 1 and 4000 then
      raise exception '메시지는 1자 이상 4000자 이하여야 합니다' using errcode = '22023';
    end if;
    if new.collection in ('messages','files','weekly') then
      new.data := new.data || jsonb_build_object('from', new.owner::text);   -- 보낸 사람은 서버가 적는다 (남의 이름으로 못 씀)
    end if;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  -- UPDATE
  if coalesce(current_setting('oddhr.transfer', true), '') = '1' and new.collection = old.collection and new.id = old.id then
    new.created_at := old.created_at; new.updated_at := now();
    return new;                       -- transfer_member가 기록을 옮기는 중
  end if;
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
  if new.collection in ('messages','files','weekly') then
    if (new.data -> 'from') is distinct from (old.data -> 'from') or (new.data -> 'to') is distinct from (old.data -> 'to') then
      raise exception '보낸 사람과 받는 사람은 바꿀 수 없습니다' using errcode = '42501';
    end if;
  end if;
  if new.collection = 'weekly' and old.owner <> auth.uid() and (new.data - keep) is distinct from (old.data - keep) then
    raise exception '주간 업데이트 내용은 본인만 고칠 수 있습니다 (PM은 확인 표시만)' using errcode = '42501';
  end if;
  if new.collection = 'weekly' and old.owner = auth.uid() and not pm
     and (select jsonb_object_agg(x, new.data -> x) from unnest(keep) x) is distinct from (select jsonb_object_agg(x, old.data -> x) from unnest(keep) x) then
    raise exception 'PM 확인 표시는 PM만 남길 수 있습니다' using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

-- 앱을 다시 깐 팀원의 기록 옮기기: 메시지의 보낸 사람·받는 사람도 함께 옮긴다
create or replace function public.transfer_member(p_project uuid, p_from uuid, p_to uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r members%rowtype;
begin
  if not public.is_pm(p_project) then raise exception 'PM만 옮길 수 있습니다' using errcode = '42501'; end if;
  select * into r from members where project_id = p_project and user_id = p_from;
  if r.user_id is null or not exists (select 1 from members where project_id = p_project and user_id = p_to) then
    raise exception '두 사람 모두 이 프로젝트 멤버여야 합니다' using errcode = '22023';
  end if;
  perform set_config('oddhr.transfer', '1', true);   -- 이 거래 안에서만 규칙 트리거가 보낸 사람 변경을 허용
  update docs set owner = p_to, data = case when data ? 'from' then data || jsonb_build_object('from', p_to::text) else data end
   where project_id = p_project and owner = p_from and collection <> 'quick';
  update docs set data = data || jsonb_build_object('to', p_to::text)
   where project_id = p_project and collection = 'messages' and data ->> 'to' = p_from::text;
  perform set_config('oddhr.transfer', '', true);
  update members set role = r.role, stage = r.stage, stage_note = r.stage_note where project_id = p_project and user_id = p_to;
  delete from members where project_id = p_project and user_id = p_from;
end $$;

-- 드라이브 파일 저장소 (비공개 버킷, 파일 하나 50MB까지). 경로: <프로젝트 id>/<문서 id>.<확장자>
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit) values ('oddhr', 'oddhr', false, 52428800)
      on conflict (id) do update set public = false, file_size_limit = 52428800;
    execute 'drop policy if exists oddhr_read on storage.objects';
    execute 'drop policy if exists oddhr_write on storage.objects';
    execute 'drop policy if exists oddhr_delete on storage.objects';
    execute $p$create policy oddhr_read on storage.objects for select to authenticated
      using (bucket_id = 'oddhr' and public.is_member(((storage.foldername(name))[1])::uuid))$p$;
    execute $p$create policy oddhr_write on storage.objects for insert to authenticated
      with check (bucket_id = 'oddhr' and public.is_member(((storage.foldername(name))[1])::uuid))$p$;
    execute $p$create policy oddhr_delete on storage.objects for delete to authenticated
      using (bucket_id = 'oddhr' and (
        public.is_pm(((storage.foldername(name))[1])::uuid)
        or exists (select 1 from public.docs d where d.id = split_part(storage.filename(name), '.', 1) and d.owner = auth.uid())))$p$;
  end if;
end $$;
