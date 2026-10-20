-- =====================================================
--  WORKOUT TRACKER — Supabase database setup
--  Paste all of this into Supabase: SQL Editor → New query → Run.
--  You only do this once.
-- =====================================================

-- One row per log. The whole log is kept in "data", so new fields
-- (like times) never need changes here. "type" and "date" are copies,
-- just to make the table easier to read in Supabase.
create table if not exists public.entries (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  type       text not null,
  date       text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Row Level Security: the database itself makes sure each signed-in
-- person can only see and change their own rows.
alter table public.entries enable row level security;

create policy "Read own entries" on public.entries
  for select to authenticated using (auth.uid() = user_id);

create policy "Add own entries" on public.entries
  for insert to authenticated with check (auth.uid() = user_id);

create policy "Change own entries" on public.entries
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Delete own entries" on public.entries
  for delete to authenticated using (auth.uid() = user_id);

-- Signed-in users may use the table (the rules above still apply);
-- people who aren't signed in get nothing.
grant select, insert, update, delete on public.entries to authenticated;
revoke all on public.entries from anon;
