-- v4: 탐험가 프로필 카드 (칭호 · 스티커). 읽기는 누구나, 쓰기는 본인 기기의 비밀 열쇠로만
create table if not exists profiles (
  user_id text primary key,
  key_hash text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table profiles enable row level security;
drop policy if exists "read profiles" on profiles;
create policy "read profiles" on profiles for select to anon, authenticated using (true);
revoke all on public.profiles from anon, authenticated;
grant select (user_id, data, updated_at) on public.profiles to anon, authenticated;

create or replace function save_profile(p_user text, p_secret text, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  if p_user is null or length(p_user) > 64 or p_secret is null or length(p_secret) < 16 then raise exception 'bad request'; end if;
  if length(p_data::text) > 4000 then raise exception 'profile too large'; end if;
  h := encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  insert into profiles (user_id, key_hash, data) values (p_user, h, p_data)
  on conflict (user_id) do update set data = excluded.data, updated_at = now()
  where profiles.key_hash = excluded.key_hash;
  if not found then raise exception 'not your profile'; end if;
end $$;
revoke all on function public.save_profile(text, text, jsonb) from public;
grant execute on function public.save_profile(text, text, jsonb) to anon, authenticated;

select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1, 2;
