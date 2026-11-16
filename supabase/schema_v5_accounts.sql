-- v5: 구글 로그인 계정 저장소. 본인만 읽고 쓸 수 있다
create table if not exists accounts (
  auth_uid uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  state jsonb not null check (length(state::text) < 60000),
  updated_at timestamptz not null default now()
);
alter table accounts enable row level security;
revoke all on public.accounts from anon;
grant select, insert, update on public.accounts to authenticated;
drop policy if exists "own account read" on accounts;
drop policy if exists "own account insert" on accounts;
drop policy if exists "own account update" on accounts;
create policy "own account read" on accounts for select to authenticated using (auth.uid() = auth_uid);
create policy "own account insert" on accounts for insert to authenticated with check (auth.uid() = auth_uid);
create policy "own account update" on accounts for update to authenticated using (auth.uid() = auth_uid) with check (auth.uid() = auth_uid);

select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1, 2;
