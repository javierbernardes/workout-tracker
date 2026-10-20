-- =====================================================
--  WORKOUT TRACKER — morning reminder notification
--  Already applied to the project (by Claude, through the Supabase connection).
--  Kept here as a record. The program itself: supabase/functions/morning-reminder/
-- =====================================================

-- The app's notification keys (made once by the reminder program).
-- RLS on with no rules = nobody can read it from outside; only Supabase's own
-- server-side programs (service role) can.
create table if not exists public.push_config (
  id          int primary key default 1 check (id = 1),
  public_key  text not null,
  private_key text not null
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;
grant all on public.push_config to service_role;

-- Each phone that turned the reminder on: where to send it and when.
create table if not exists public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh       text not null,
  auth         text not null,
  notify_time  text not null default '07:00',
  time_zone    text not null default 'UTC',
  last_sent_on text,
  created_at   timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;

create policy "Read own subscriptions" on public.push_subscriptions
  for select to authenticated using (auth.uid() = user_id);
create policy "Add own subscriptions" on public.push_subscriptions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Change own subscriptions" on public.push_subscriptions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Delete own subscriptions" on public.push_subscriptions
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.push_subscriptions to authenticated;
revoke all on public.push_subscriptions from anon;
grant all on public.push_subscriptions to service_role;

-- The reminder program checks whether you already logged today
grant select on public.entries to service_role;

-- A timer inside the database (pg_cron) that calls the program (via pg_net)
create extension if not exists pg_cron;
create extension if not exists pg_net schema extensions;

select cron.schedule(
  'morning-reminder',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://ugzvmzkigbbnigdcqbfo.supabase.co/functions/v1/morning-reminder',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb
     ) $$
);
