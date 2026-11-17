-- v8: "없음" 신고와 사진 증거.
-- 원칙: 가입한 사람 수는 막지 않는다. 대신 남에게 영향을 주는 행동("없음" 신고, 사진)은
--       한 번이라도 도착 인증을 한 탐험가(= 실제로 돌아다니는 사람)만 할 수 있게 한다.
-- 신고가 있어도 그 뒤에 누군가 도착 인증을 하거나 "있어요" 사진을 올리면 신고는 무효가 된다.
-- v7 다음에 실행. 여러 번 실행해도 안전하다.

-- v7을 예전 판(새 탐험가 수 제한)으로 실행했어도 제한이 풀리도록 다시 정의
create or replace function check_key(p_user text, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
declare h text; cur text;
begin
  if p_user is null or length(p_user) < 4 or length(p_user) > 64 or p_secret is null or length(p_secret) < 16 then raise exception 'bad request'; end if;
  h := encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  select key_hash into cur from profiles where user_id = p_user;
  if cur is null then
    insert into profiles (user_id, key_hash, data) values (p_user, h, '{}'::jsonb) on conflict (user_id) do nothing;
    select key_hash into cur from profiles where user_id = p_user;
  end if;
  if cur <> h then raise exception '본인 확인에 실패했어요'; end if;
end $$;
drop table if exists key_births;  -- 예전 판의 네트워크 집계표. 더 이상 쓰지 않는다

-- 실제로 돌아다니는 탐험가인가: 도착 인증 기록이 하나 이상
create or replace function is_trusted(p_user text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from visits where user_id = p_user);
$$;

create table if not exists photos (
  id bigserial primary key,
  toilet_id text not null,
  kind text not null check (kind in ('exists', 'gone')),
  data text not null check (data like 'data:image/jpeg;base64,%' and length(data) <= 200000),
  user_id text not null,
  nick text,
  hidden boolean not null default false,
  at timestamptz not null default now()
);
-- 목록에는 작은 미리보기(thumb)만 보내고, 원본(data)은 눌렀을 때만 받는다 (전송량 절약)
alter table photos add column if not exists thumb text;
create index if not exists photos_toilet on photos(toilet_id, at desc);
create index if not exists photos_user on photos(user_id, at desc);
create table if not exists photo_reports (
  photo_id bigint not null references photos(id) on delete cascade,
  user_id text not null,
  at timestamptz not null default now(),
  primary key (photo_id, user_id)
);
alter table photos enable row level security;
alter table photo_reports enable row level security;
revoke all on public.photos, public.photo_reports from anon, authenticated;
grant select (id, toilet_id, kind, thumb, data, user_id, nick, at) on public.photos to anon, authenticated;
drop policy if exists "read visible photos" on photos;
create policy "read visible photos" on photos for select to anon, authenticated using (not hidden);

-- 사진 올리기: 도착 인증을 한 탐험가만, 하루 5장까지
drop function if exists post_photo(text, text, text, text, text, text);
create or replace function post_photo(p_user text, p_secret text, p_toilet text, p_kind text, p_data text, p_nick text default null, p_thumb text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare n int; new_id bigint;
begin
  perform check_key(p_user, p_secret);
  if not is_trusted(p_user) then raise exception '도착 인증을 한 번 이상 한 탐험가만 사진을 올릴 수 있어요'; end if;
  if p_toilet is null or length(p_toilet) > 80 or p_kind not in ('exists', 'gone') then raise exception 'bad request'; end if;
  if p_data is null or p_data not like 'data:image/jpeg;base64,%' or length(p_data) > 200000 then raise exception '사진 형식이 올바르지 않거나 너무 커요'; end if;
  select count(*) into n from photos where user_id = p_user and at > now() - interval '24 hours';
  if n >= 5 then raise exception '사진은 하루 5장까지 올릴 수 있어요'; end if;
  if p_thumb is not null and (p_thumb not like 'data:image/jpeg;base64,%' or length(p_thumb) > 20000) then p_thumb := null; end if;
  insert into photos (toilet_id, kind, data, thumb, user_id, nick) values (p_toilet, p_kind, p_data, p_thumb, p_user, left(p_nick, 40)) returning id into new_id;
  -- 변기 하나에 사진은 최근 8장까지만 남긴다 (저장 공간이 끝없이 늘지 않게)
  delete from photos where toilet_id = p_toilet and id not in (select id from photos where toilet_id = p_toilet order by at desc, id desc limit 8);
  return new_id;
end $$;

-- 부적절한 사진 신고: 서로 다른 탐험가 2명이 신고하면 숨김
create or replace function report_photo(p_user text, p_secret text, p_photo bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare owner text; n int;
begin
  perform check_key(p_user, p_secret);
  if not is_trusted(p_user) then raise exception '도착 인증을 한 번 이상 한 탐험가만 신고할 수 있어요'; end if;
  select user_id into owner from photos where id = p_photo;
  if owner is null then raise exception '없는 사진이에요'; end if;
  if owner = p_user then raise exception '내 사진은 신고할 수 없어요'; end if;
  insert into photo_reports (photo_id, user_id) values (p_photo, p_user) on conflict do nothing;
  select count(*) into n from photo_reports where photo_id = p_photo;
  if n >= 2 then update photos set hidden = true where id = p_photo; end if;
  return n >= 2;
end $$;

-- 변기별 유효한 "없음" 신고 수.
-- 유효한 신고 = 최근 30일 안에, 도착 인증을 한 탐험가가 남긴 신고 또는 "없어졌어요" 사진으로,
--             그 변기에 마지막 증거(누군가의 도착 인증, "있어요" 사진)가 생긴 뒤에 남긴 것.
-- 서로 다른 탐험가 2명 이상이면 hidden = true (변기탐지 후보에서 빠진다)
-- p_ids: 지금 지도에 보이는 변기들만 (전 세계 집계를 매번 보내지 않게). 비우면 전체
drop function if exists toilet_flags();
create or replace function toilet_flags(p_ids text[] default null) returns table (toilet_id text, flags int, hidden boolean)
language sql stable security definer set search_path = public as $$
  with claims as (
    select r.toilet_id, r.user_id, r.at from reports r where r.k = 'flagged' and r.at > now() - interval '30 days' and (p_ids is null or r.toilet_id = any(p_ids))
    union all
    select p.toilet_id, p.user_id, p.at from photos p where p.kind = 'gone' and not p.hidden and p.at > now() - interval '30 days' and (p_ids is null or p.toilet_id = any(p_ids))
  ), evidence as (
    select e.toilet_id, max(e.at) as at from (
      select v.toilet_id, v.at from visits v where v.at > now() - interval '30 days' and v.toilet_id in (select c0.toilet_id from claims c0)
      union all
      select p.toilet_id, p.at from photos p where p.kind = 'exists' and not p.hidden and p.at > now() - interval '30 days'
    ) e group by e.toilet_id
  )
  select c.toilet_id, count(distinct c.user_id)::int as flags, count(distinct c.user_id) >= 2 as hidden
  from claims c
  left join evidence ev on ev.toilet_id = c.toilet_id
  where c.at > coalesce(ev.at, '-infinity'::timestamptz)
    and exists (select 1 from visits v where v.user_id = c.user_id)
  group by c.toilet_id;
$$;

-- 변기 레벨 카드: 방문 기록을 통째로 보내지 않고 서버가 센 숫자만 보낸다
create or replace function toilet_stats(p_toilet text, p_user text default null) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'visits', (select count(*) from visits where toilet_id = p_toilet),
    'explorers', (select count(distinct user_id) from visits where toilet_id = p_toilet),
    'first_nick', (select nick from visits where toilet_id = p_toilet order by at asc, id asc limit 1),
    'mine', (select count(*) from visits where toilet_id = p_toilet and user_id = p_user));
$$;
revoke all on function public.toilet_stats(text, text) from public;
grant execute on function public.toilet_stats(text, text) to anon, authenticated;

revoke all on function public.is_trusted(text), public.post_photo(text, text, text, text, text, text, text), public.report_photo(text, text, bigint), public.toilet_flags(text[]) from public;
grant execute on function public.post_photo(text, text, text, text, text, text, text), public.report_photo(text, text, bigint), public.toilet_flags(text[]) to anon, authenticated;

select 'evidence ready' as status;
