-- v9: 앱 광고 보너스 (광고를 끝까지 보면 +30코인, 하루 3번까지)
-- v6~v8을 실행한 뒤 실행. 여러 번 실행해도 안전함.
-- 광고 보너스는 claims에 kind='bonus', ref='ad1'~'ad3'으로 기록한다 (표 구조는 그대로)

-- 지갑 계산: 오늘의 보너스(ref='')와 광고 보너스(ref='ad…')를 구분하고, 오늘 본 광고 수(ads_today)를 알려준다
create or replace function wallet_state(p_user text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  rep_n int; rep_coin int; quest_coin int;
  visit_coin int; first_n int; distinct_n int; visit_n int; has_b3 boolean; has_b5 boolean; has_night boolean;
  talk_n int; talk_coin int; help_coin int;
  reg_n int; reg_coin int;
  bonus_coin int; mission_coin int; has_tut boolean; bonus_today boolean; missions_today int; ads_today int;
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
         coalesce(bool_or(kind = 'tut'), false), coalesce(bool_or(kind = 'bonus' and day = today and ref = ''), false),
         coalesce(count(*) filter (where kind = 'mission' and day = today), 0),
         coalesce(count(*) filter (where kind = 'bonus' and day = today and ref like 'ad%'), 0)
    into bonus_coin, mission_coin, has_tut, bonus_today, missions_today, ads_today
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
    'bonus_today', bonus_today, 'missions_today', missions_today, 'ads_today', ads_today,
    'stats', jsonb_build_object('reports', rep_n, 'visits', visit_n, 'distinct', distinct_n, 'talks', talk_n, 'regs', reg_n, 'firsts', first_n));
end $$;

create or replace function claim_ad_bonus(p_user text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'utc')::date; n int; last_at timestamptz;
begin
  perform check_key(p_user, p_secret);
  perform pg_advisory_xact_lock(hashtext('ad:' || p_user));  -- 동시에 두 번 눌러도 한 번만
  select count(*), max(at) into n, last_at from claims where user_id = p_user and kind = 'bonus' and day = today and ref like 'ad%';
  if n >= 3 then raise exception '오늘 광고 보너스는 다 받았어요'; end if;
  if last_at is not null and now() - last_at < interval '20 seconds' then raise exception '잠시 후 다시 시도해 주세요'; end if;
  insert into claims (user_id, kind, day, ref, amount) values (p_user, 'bonus', today, 'ad' || (n + 1), 30) on conflict do nothing;
  return wallet_state(p_user);
end $$;

revoke all on function public.claim_ad_bonus(text, text) from public;
grant execute on function public.claim_ad_bonus(text, text) to anon, authenticated;

select 'v9 ready' as result;
