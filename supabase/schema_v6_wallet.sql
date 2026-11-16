-- v6: 서버가 계산하는 지갑(코인·변기력·칭호·구매).
-- 지금까지는 코인과 칭호를 각 기기가 스스로 계산해서, 브라우저 저장소를 고치면 조작할 수 있었다.
-- 이제는 서버에 쌓인 기록(보고·인증·이야기·등록)에서 서버가 직접 계산하고, 기기는 그 결과를 보여주기만 한다.
-- 여러 번 실행해도 안전하다.

alter table visits add column if not exists tz smallint;  -- 인증한 사람의 시간대(UTC 기준 분). 심야 칭호 판정용

create table if not exists claims (
  user_id text not null,
  kind text not null check (kind in ('bonus','mission','tut')),
  day date not null,
  ref text not null default '',
  amount int not null default 0,
  at timestamptz not null default now(),
  primary key (user_id, kind, day, ref)
);
create table if not exists purchases (
  user_id text not null,
  item text not null,
  price int not null,
  at timestamptz not null default now(),
  primary key (user_id, item)
);
create table if not exists shop_items (item text primary key, price int not null check (price >= 0));
insert into shop_items (item, price) values
  ('bg_night',150),('bg_onsen',200),('bg_forest',200),('bg_sunset',250),('bg_neon',400),('bg_gold',1500),
  ('fr_gold',200),('fr_wave',300),('fr_rainbow',600),
  ('co_sky',100),('co_mint',100),('co_pink',100),('co_gold',300),
  ('pk_sea',250),('pk_night',250),('pk_party',350)
on conflict (item) do update set price = excluded.price;

alter table claims enable row level security;
alter table purchases enable row level security;
alter table shop_items enable row level security;
revoke all on public.claims, public.purchases, public.shop_items from anon, authenticated;  -- 함수로만 접근

-- 지갑 상태 계산. 보상 규칙은 전부 여기에 있다.
create or replace function wallet_state(p_user text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  rep_n int; rep_coin int; quest_coin int;
  visit_coin int; first_n int; distinct_n int; visit_n int; has_b3 boolean; has_b5 boolean; has_night boolean;
  talk_n int; talk_coin int; help_coin int;
  reg_n int; reg_coin int;
  bonus_coin int; mission_coin int; has_tut boolean; bonus_today boolean; missions_today int;
  spent int; earned int; xp int; titles text[] := '{}'; owned text[];
  today date := (now() at time zone 'utc')::date;
begin
  -- 상태 보고: 같은 변기의 같은 항목은 30분 간격, 하루 30건까지 보상. 건당 5코인. 하루 3건을 채우면 일일 퀘스트 +60
  with r as (
    select at, (at at time zone 'utc')::date as d,
           lag(at) over (partition by toilet_id, k order by at) as prev
    from reports where user_id = p_user and k <> 'flagged'
  ), ok as (
    select d, row_number() over (partition by d order by at) as rn from r where prev is null or at - prev >= interval '30 minutes'
  ), per_day as (
    select d, count(*) filter (where rn <= 30) as n from ok group by d
  )
  select coalesce(sum(n), 0), coalesce(sum(n), 0) * 5, coalesce(count(*) filter (where n >= 3), 0) * 60
    into rep_n, rep_coin, quest_coin from per_day;

  -- 도착 인증: 변기 하나당 하루 한 번, 하루 15곳까지 30코인. 그 변기의 첫 인증자면 +40 (하루 5곳까지)
  with v as (
    select toilet_id, (at at time zone 'utc')::date as d, min(at) as at from visits where user_id = p_user group by 1, 2
  ), ranked as (
    select *, row_number() over (partition by d order by at) as rn from v
  )
  select coalesce(count(*) filter (where rn <= 15), 0) * 30 into visit_coin from ranked;

  with mine as (
    select toilet_id, min(at) as at from visits where user_id = p_user group by 1
  ), firsts as (
    select m.toilet_id, m.at, (m.at at time zone 'utc')::date as d from mine m
    where not exists (select 1 from visits o where o.toilet_id = m.toilet_id and o.user_id <> p_user and o.at < m.at)
  ), fr as (
    select *, row_number() over (partition by d order by at) as rn from firsts
  )
  select coalesce(count(*) filter (where rn <= 5), 0) into first_n from fr;

  select count(distinct toilet_id), count(*) into distinct_n, visit_n from visits where user_id = p_user;
  select exists (select 1 from visits a where a.user_id = p_user and
           (select count(distinct b.toilet_id) from visits b where b.user_id = p_user and b.at <= a.at and b.at > a.at - interval '2 hours') >= 3) into has_b3;
  select exists (select 1 from visits a where a.user_id = p_user and
           (select count(distinct b.toilet_id) from visits b where b.user_id = p_user and b.at <= a.at and b.at > a.at - interval '24 hours') >= 5) into has_b5;
  select exists (select 1 from visits where user_id = p_user and
           extract(hour from (at at time zone 'utc') + make_interval(mins => coalesce(tz, 540))) < 5) into has_night;

  -- 이야기: 하루 10건까지. 답변 5, 그 외 2. 내 답변이 "도움됐어요"를 받으면 답변당 한 번 +15
  with m as (
    select kind, row_number() over (partition by (at at time zone 'utc')::date order by at) as rn from messages where user_id = p_user
  )
  select count(*), coalesce(sum(case when rn <= 10 then (case when kind = 'answer' then 5 else 2 end) else 0 end), 0) into talk_n, talk_coin from m;
  select coalesce(count(*), 0) * 15 into help_coin from messages where user_id = p_user and kind = 'answer' and helpful > 0;

  -- 화장실 등록: 하루 3곳까지 50코인
  with t as (
    select row_number() over (partition by (at at time zone 'utc')::date order by at) as rn from toilets where user_id = p_user
  )
  select count(*), coalesce(count(*) filter (where rn <= 3), 0) * 50 into reg_n, reg_coin from t;

  select coalesce(sum(amount) filter (where kind = 'bonus'), 0), coalesce(sum(amount) filter (where kind = 'mission'), 0),
         coalesce(bool_or(kind = 'tut'), false), coalesce(bool_or(kind = 'bonus' and day = today), false),
         coalesce(count(*) filter (where kind = 'mission' and day = today), 0)
    into bonus_coin, mission_coin, has_tut, bonus_today, missions_today
    from claims where user_id = p_user;

  select coalesce(sum(price), 0), coalesce(array_agg(item), '{}') into spent, owned from purchases where user_id = p_user;

  xp := rep_coin + quest_coin + visit_coin + first_n * 40 + talk_coin + help_coin + reg_coin + mission_coin;  -- 변기력: 보너스 제외
  earned := xp + bonus_coin;

  if has_tut then titles := array_append(titles, 'tut'); end if;
  if visit_n >= 1 then titles := array_append(titles, 'v1'); end if;
  if distinct_n >= 3 then titles := array_append(titles, 'd3'); end if;
  if distinct_n >= 10 then titles := array_append(titles, 'd10'); end if;
  if distinct_n >= 30 then titles := array_append(titles, 'd30'); end if;
  if rep_n >= 1 then titles := array_append(titles, 'r1'); end if;
  if rep_n >= 10 then titles := array_append(titles, 'r10'); end if;
  if rep_n >= 50 then titles := array_append(titles, 'r50'); end if;
  if talk_n >= 10 then titles := array_append(titles, 't10'); end if;
  if reg_n >= 1 then titles := array_append(titles, 'g1'); end if;
  if first_n >= 1 then titles := array_append(titles, 'f1'); end if;
  if has_b3 then titles := array_append(titles, 's3'); end if;
  if has_b5 then titles := array_append(titles, 's5'); end if;
  if has_night then titles := array_append(titles, 'n1'); end if;
  if xp >= 1000 then titles := array_append(titles, 'k3'); end if;

  return jsonb_build_object(
    'coins', greatest(0, earned - spent), 'xp', xp, 'earned', earned, 'spent', spent,
    'titles', to_jsonb(titles), 'owned', to_jsonb(owned),
    'bonus_today', bonus_today, 'missions_today', missions_today,
    'stats', jsonb_build_object('reports', rep_n, 'visits', visit_n, 'distinct', distinct_n, 'talks', talk_n, 'regs', reg_n, 'firsts', first_n));
end $$;

-- 본인 확인: 프로필에 묶인 기기 열쇠와 맞는지 본다. 프로필이 아직 없으면 지금 열쇠로 만든다
create or replace function check_key(p_user text, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
declare h text; cur text;
begin
  if p_user is null or length(p_user) > 64 or p_secret is null or length(p_secret) < 16 then raise exception 'bad request'; end if;
  h := encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  select key_hash into cur from profiles where user_id = p_user;
  if cur is null then
    insert into profiles (user_id, key_hash, data) values (p_user, h, '{}'::jsonb) on conflict (user_id) do nothing;
    select key_hash into cur from profiles where user_id = p_user;
  end if;
  if cur <> h then raise exception '본인 확인에 실패했어요'; end if;
end $$;

-- 오늘의 보너스: 하루 한 번 50코인. 장착한 유물(서버가 칭호를 확인한 것만)마다 조금씩 더해진다
create or replace function claim_bonus(p_user text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare st jsonb; eq jsonb; amt int := 50; r text;
begin
  perform check_key(p_user, p_secret);
  st := wallet_state(p_user);
  select coalesce(data->'relics', '[]'::jsonb) into eq from profiles where user_id = p_user;
  if jsonb_typeof(eq) = 'array' then
    for r in select distinct jsonb_array_elements_text(eq) loop
      if st->'titles' ? r then
        amt := amt + case r when 'd30' then 5 when 'r50' then 3 when 's3' then 3 when 's5' then 5 when 'n1' then 3 when 'k3' then 5 else 0 end;
      end if;
    end loop;
  end if;
  insert into claims (user_id, kind, day, amount) values (p_user, 'bonus', (now() at time zone 'utc')::date, amt) on conflict do nothing;
  return wallet_state(p_user);
end $$;

-- 출동 미션 완료: 오늘 그 변기를 인증했어야 하고, 하루 3번까지 40코인
create or replace function claim_mission(p_user text, p_secret text, p_toilet text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'utc')::date; n int;
begin
  perform check_key(p_user, p_secret);
  if not exists (select 1 from visits where user_id = p_user and toilet_id = p_toilet and at > now() - interval '24 hours') then
    raise exception '그 변기의 도착 인증 기록이 없어요';
  end if;
  select count(*) into n from claims where user_id = p_user and kind = 'mission' and day = today;
  if n < 3 then
    insert into claims (user_id, kind, day, ref, amount) values (p_user, 'mission', today, left(p_toilet, 80), 40) on conflict do nothing;
  end if;
  return wallet_state(p_user);
end $$;

create or replace function claim_tut(p_user text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform check_key(p_user, p_secret);
  insert into claims (user_id, kind, day) values (p_user, 'tut', date '2000-01-01') on conflict do nothing;
  return wallet_state(p_user);
end $$;

-- 상점 구매: 가격은 서버의 shop_items가 기준
create or replace function buy_item(p_user text, p_secret text, p_item text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pr int; st jsonb;
begin
  perform check_key(p_user, p_secret);
  select price into pr from shop_items where item = p_item;
  if pr is null then raise exception '없는 상품이에요'; end if;
  if exists (select 1 from purchases where user_id = p_user and item = p_item) then return wallet_state(p_user); end if;
  perform pg_advisory_xact_lock(hashtext(p_user));  -- 같은 사람이 동시에 여러 개를 사서 잔액을 넘기지 못하게
  st := wallet_state(p_user);
  if (st->>'coins')::int < pr then raise exception '코인이 부족해요'; end if;
  insert into purchases (user_id, item, price) values (p_user, p_item, pr) on conflict do nothing;
  return wallet_state(p_user);
end $$;

revoke all on function public.wallet_state(text), public.check_key(text, text), public.claim_bonus(text, text), public.claim_mission(text, text, text), public.claim_tut(text, text), public.buy_item(text, text, text) from public;
grant execute on function public.wallet_state(text), public.claim_bonus(text, text), public.claim_mission(text, text, text), public.claim_tut(text, text), public.buy_item(text, text, text) to anon, authenticated;

-- "도움됐어요"는 답변에만, 그리고 표시는 1까지만 (연타로 숫자를 불리지 못하게)
create or replace function mark_helpful(mid uuid) returns void language sql security definer set search_path = public as $$
  update messages set helpful = 1 where id = mid and kind = 'answer' and helpful = 0;
$$;
grant execute on function public.mark_helpful(uuid) to anon, authenticated;

select 'wallet ready' as status, (select count(*) from shop_items) as shop_items;
