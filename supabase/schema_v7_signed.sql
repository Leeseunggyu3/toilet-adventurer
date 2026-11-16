-- v7: 본인 확인이 붙은 쓰기 + 불가능한 이동 걸러내기 + 새 탐험가 남발 제한.
-- 지금까지는 글·보고·인증·등록을 올릴 때 본인 확인이 없어서, 남의 탐험가 ID로 기록을 올릴 수 있었다.
-- 이제 모든 쓰기는 기기 열쇠를 확인하는 함수로만 가능하고, 테이블에 직접 쓰는 길은 닫는다.
-- 여러 번 실행해도 안전하다. (v6을 먼저 실행해야 한다)

alter table visits add column if not exists lat double precision;
alter table visits add column if not exists lng double precision;

-- 두 지점 사이 거리(m)
create or replace function dist_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) returns double precision
language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- 새 탐험가(새 기기 열쇠)가 같은 네트워크에서 하루에 너무 많이 만들어지는 것을 막기 위한 집계. 기준은 하루 500명.
-- 휴대폰 데이터는 많은 사람이 같은 주소를 나눠 쓰므로 넉넉하게 잡았다. 이미 있는 탐험가에게는 적용되지 않는다.
-- IP 주소 자체는 저장하지 않는다. 날짜를 섞은 해시만 남기므로 다음 날이면 같은 사람인지 알 수 없다.
create table if not exists key_births (ip_hash text not null, day date not null, n int not null default 0, primary key (ip_hash, day));
alter table key_births enable row level security;
revoke all on public.key_births from anon, authenticated;

create or replace function check_key(p_user text, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
declare h text; cur text; ip text; ih text; cnt int; today date := (now() at time zone 'utc')::date;
  daily_new_limit constant int := 500;  -- 같은 네트워크에서 하루에 새로 생길 수 있는 탐험가 수. 바꾸려면 이 숫자만 고치고 이 파일을 다시 실행
begin
  if p_user is null or length(p_user) < 4 or length(p_user) > 64 or p_secret is null or length(p_secret) < 16 then raise exception 'bad request'; end if;
  h := encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  select key_hash into cur from profiles where user_id = p_user;
  if cur is null then
    begin
      ip := split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1);
    exception when others then ip := '';
    end;
    if ip <> '' then
      ih := encode(sha256(convert_to(ip || '|' || today::text, 'UTF8')), 'hex');
      insert into key_births (ip_hash, day, n) values (ih, today, 1)
        on conflict (ip_hash, day) do update set n = key_births.n + 1 returning n into cnt;
      if cnt > daily_new_limit then raise exception '지금 이 네트워크에서 새 탐험가가 너무 많이 만들어지고 있어요. 와이파이를 바꾸거나 내일 다시 시도해 주세요.'; end if;
    end if;
    insert into profiles (user_id, key_hash, data) values (p_user, h, '{}'::jsonb) on conflict (user_id) do nothing;
    select key_hash into cur from profiles where user_id = p_user;
  end if;
  if cur <> h then raise exception '본인 확인에 실패했어요'; end if;
end $$;

create or replace function post_message(p_user text, p_secret text, p_channel text, p_text text, p_kind text default 'chat', p_toilet text default null, p_parent uuid default null, p_nick text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_key(p_user, p_secret);
  if p_kind not in ('chat', 'question', 'answer') then raise exception 'bad request'; end if;
  if p_channel is null or length(p_channel) > 120 then raise exception 'bad request'; end if;
  insert into messages (channel, toilet_id, user_id, nick, text, kind, parent)
  values (p_channel, left(p_toilet, 80), p_user, left(coalesce(nullif(trim(p_nick), ''), '탐험가'), 40), p_text, p_kind, p_parent);
end $$;

create or replace function post_report(p_user text, p_secret text, p_toilet text, p_k text, p_v int, p_nick text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_key(p_user, p_secret);
  if p_toilet is null or length(p_toilet) > 80 then raise exception 'bad request'; end if;
  insert into reports (toilet_id, k, v, user_id, nick) values (p_toilet, p_k, p_v, p_user, left(p_nick, 40));
end $$;

-- 도착 인증. 변기의 좌표를 함께 받아서, 직전 인증 지점에서 올 수 없는 속도(2시간 안에 시속 약 320km 초과)면 거절한다.
-- 사용자가 등록한 화장실은 서버에 있는 좌표를 쓴다.
create or replace function post_visit(p_user text, p_secret text, p_toilet text, p_name text default null, p_nick text default null, p_tz int default null, p_lat double precision default null, p_lng double precision default null) returns void
language plpgsql security definer set search_path = public as $$
declare la double precision := p_lat; lo double precision := p_lng; prev record; d double precision; secs double precision;
begin
  perform check_key(p_user, p_secret);
  if p_toilet is null or length(p_toilet) > 80 then raise exception 'bad request'; end if;
  select t.lat, t.lng into la, lo from toilets t where t.id = p_toilet;
  if not found then la := p_lat; lo := p_lng; end if;
  if la is not null and (la < -90 or la > 90 or lo < -180 or lo > 180) then raise exception 'bad request'; end if;
  if la is not null then
    select v.lat, v.lng, v.at into prev from visits v
      where v.user_id = p_user and v.lat is not null and v.at > now() - interval '2 hours' order by v.at desc limit 1;
    if found then
      d := dist_m(prev.lat, prev.lng, la, lo); secs := greatest(extract(epoch from now() - prev.at), 1);
      if d > 3000 and d / secs > 90 then raise exception '직전 인증 지점에서 너무 빨리 이동했어요. 잠시 후 다시 인증해 주세요.'; end if;
    end if;
  end if;
  insert into visits (toilet_id, toilet_name, user_id, nick, tz, lat, lng)
  values (p_toilet, left(p_name, 80), p_user, left(p_nick, 40), case when p_tz between -840 and 840 then p_tz end, la, lo);
end $$;

create or replace function post_toilet(p_user text, p_secret text, p_id text, p_lat double precision, p_lng double precision, p_name text, p_access text default 'yes', p_nick text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform check_key(p_user, p_secret);
  if p_id is null or length(p_id) < 4 or length(p_id) > 40 or left(p_id, 1) <> 'u' then raise exception 'bad request'; end if;
  insert into toilets (id, lat, lng, name, access, user_id, nick)
  values (p_id, p_lat, p_lng, left(coalesce(nullif(trim(p_name), ''), '사용자 등록 화장실'), 60), case when p_access in ('yes', 'customers') then p_access else 'yes' end, p_user, left(p_nick, 40));
end $$;

revoke all on function public.dist_m(double precision, double precision, double precision, double precision), public.check_key(text, text),
  public.post_message(text, text, text, text, text, text, uuid, text), public.post_report(text, text, text, text, int, text),
  public.post_visit(text, text, text, text, text, int, double precision, double precision), public.post_toilet(text, text, text, double precision, double precision, text, text, text) from public;
grant execute on function public.post_message(text, text, text, text, text, text, uuid, text), public.post_report(text, text, text, text, int, text),
  public.post_visit(text, text, text, text, text, int, double precision, double precision), public.post_toilet(text, text, text, double precision, double precision, text, text, text) to anon, authenticated;

-- 테이블에 직접 쓰는 길을 닫는다 (읽기는 그대로)
revoke insert, update, delete on public.messages, public.reports, public.visits, public.toilets from anon, authenticated;
grant select on public.messages, public.reports, public.visits, public.toilets to anon, authenticated;
drop policy if exists "insert messages" on messages;
drop policy if exists "insert reports" on reports;
drop policy if exists "insert visits" on visits;
drop policy if exists "insert toilets" on toilets;

select 'signed writes ready' as status,
       (select count(*) from pg_policies where schemaname = 'public' and cmd = 'INSERT' and tablename in ('messages','reports','visits','toilets')) as open_insert_policies;
