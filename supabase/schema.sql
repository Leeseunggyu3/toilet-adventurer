-- 급해요 시티 — Supabase 스키마 (SQL Editor에 붙여넣고 실행)
create extension if not exists pgcrypto;

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  channel text not null,            -- 'toilet:<id>' 또는 'area:<격자키>'
  toilet_id text,
  user_id text not null,
  nick text not null,
  text text not null check (char_length(text) <= 300),
  kind text not null default 'chat', -- chat | question | answer
  parent uuid references messages(id),
  helpful int not null default 0,
  at timestamptz not null default now()
);
create index if not exists messages_channel_at on messages(channel, at desc);

create table if not exists visits (
  id bigserial primary key,
  toilet_id text not null,
  toilet_name text,
  user_id text not null,
  nick text,
  at timestamptz not null default now()
);
create index if not exists visits_toilet on visits(toilet_id, at);
create index if not exists visits_user on visits(user_id, at desc);

-- 도움됐어요 카운트 (익명이라 RPC로만 증가)
create or replace function mark_helpful(mid uuid) returns void language sql security definer as $$
  update messages set helpful = helpful + 1 where id = mid;
$$;

-- RLS: 익명 읽기/쓰기 허용, 수정/삭제 금지 (MVP). 스팸이 생기면 rate limit/Edge Function로 보강.
alter table messages enable row level security;
alter table visits enable row level security;
create policy "read messages" on messages for select using (true);
create policy "insert messages" on messages for insert with check (true);
create policy "read visits" on visits for select using (true);
create policy "insert visits" on visits for insert with check (true);
