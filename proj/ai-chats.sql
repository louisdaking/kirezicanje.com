-- Daking AI chat history: one private conversation per account. Run once in the Supabase SQL editor (safe to run again).
create table if not exists public.ai_chats (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('user', 'model')),
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_chats_user_time on public.ai_chats (user_id, created_at desc);

alter table public.ai_chats enable row level security;
-- a user can only READ his own messages. Writing is done by the server (service role) so the daily limit cannot be bypassed.
drop policy if exists "ai_chats read own" on public.ai_chats;
create policy "ai_chats read own" on public.ai_chats for select using (auth.uid() = user_id);
