-- ===== v2: 상태 보고 · 사용자 등록 화장실 공유 + 도배 방지 =====
create table if not exists reports (
  id bigserial primary key,
  toilet_id text not null,
  k text not null check (k in ('open','paper','clean','queue','flagged')),
  v int not null check (v in (0,1)),
  user_id text not null,
  nick text,
  at timestamptz not null default now()
);
create index if not exists reports_at on reports(at desc);
create index if not exists reports_toilet on reports(toilet_id, at desc);

create table if not exists toilets (
  id text primary key,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  name text not null check (char_length(name) <= 60),
  access text,
  user_id text not null,
  nick text,
  at timestamptz not null default now()
);
create index if not exists toilets_latlng on toilets(lat, lng);

-- 도배 방지: 같은 탐험가(user_id) 기준 시간당/분당 작성 수 제한
create or replace function rate_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare n int; lim int; win interval;
begin
  if tg_table_name = 'messages' then lim := 8;  win := interval '1 minute';
  elsif tg_table_name = 'reports' then lim := 20; win := interval '1 minute';
  elsif tg_table_name = 'toilets' then lim := 5;  win := interval '1 hour';
  else lim := 30; win := interval '1 minute';
  end if;
  execute format('select count(*) from %I where user_id = $1 and at > now() - $2', tg_table_name) into n using new.user_id, win;
  if n >= lim then raise exception '너무 빨라요. 잠시 후 다시 시도해 주세요.' using errcode = 'P0001'; end if;
  return new;
end $$;
drop trigger if exists rl_messages on messages;
drop trigger if exists rl_reports on reports;
drop trigger if exists rl_toilets on toilets;
drop trigger if exists rl_visits on visits;
create trigger rl_messages before insert on messages for each row execute function rate_limit();
create trigger rl_reports before insert on reports for each row execute function rate_limit();
create trigger rl_toilets before insert on toilets for each row execute function rate_limit();
create trigger rl_visits before insert on visits for each row execute function rate_limit();

grant select, insert on public.reports to anon, authenticated;
grant select, insert on public.toilets to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
alter table reports enable row level security;
alter table toilets enable row level security;
drop policy if exists "read reports" on reports;
drop policy if exists "insert reports" on reports;
drop policy if exists "read toilets" on toilets;
drop policy if exists "insert toilets" on toilets;
create policy "read reports" on reports for select to anon, authenticated using (true);
create policy "insert reports" on reports for insert to anon, authenticated with check (true);
create policy "read toilets" on toilets for select to anon, authenticated using (true);
create policy "insert toilets" on toilets for insert to anon, authenticated with check (true);

select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1, 2;
