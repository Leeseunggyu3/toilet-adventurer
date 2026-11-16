-- v3: 의견 보내기 (쓰기만 가능, 읽기는 대시보드에서만)
create table if not exists feedback (
  id bigserial primary key,
  text text not null check (char_length(text) between 3 and 1000),
  version text,
  user_id text not null,
  nick text,
  ua text,
  at timestamptz not null default now()
);
grant insert on public.feedback to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
alter table feedback enable row level security;
drop policy if exists "insert feedback" on feedback;
create policy "insert feedback" on feedback for insert to anon, authenticated with check (true);

create or replace function rate_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare n int; lim int; win interval;
begin
  if tg_table_name = 'messages' then lim := 8;  win := interval '1 minute';
  elsif tg_table_name = 'reports' then lim := 20; win := interval '1 minute';
  elsif tg_table_name = 'toilets' then lim := 5;  win := interval '1 hour';
  elsif tg_table_name = 'feedback' then lim := 5; win := interval '1 hour';
  else lim := 30; win := interval '1 minute';
  end if;
  execute format('select count(*) from %I where user_id = $1 and at > now() - $2', tg_table_name) into n using new.user_id, win;
  if n >= lim then raise exception '너무 빨라요. 잠시 후 다시 시도해 주세요.' using errcode = 'P0001'; end if;
  return new;
end $$;
drop trigger if exists rl_feedback on feedback;
create trigger rl_feedback before insert on feedback for each row execute function rate_limit();

select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1, 2;
