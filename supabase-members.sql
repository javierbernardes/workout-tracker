-- =====================================================
--  MEMBERS: who may use the app. Applied 2026-10-22 (through the Supabase connector).
--
--  Note: it was applied statement by statement through the connector, which cannot run
--  DROP statements; existing policies were changed with ALTER POLICY instead. Running this
--  whole file in the SQL editor gives the same result.
--
--  Anyone can create an account, but it starts as "pending": the database
--  refuses their logs until the admin (Javier) approves them in the app's
--  Members section. Each member also has a name (for the Members list and,
--  later, for friendly competitions) so friends never need to see emails.
-- =====================================================

-- One row per account
create table if not exists public.members (
  user_id      uuid primary key references auth.users on delete cascade,
  email        text not null,
  name         text not null default '',
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  role         text not null default 'member'  check (role in ('member', 'admin')),
  requested_at timestamptz not null default now(),
  approved_at  timestamptz
);

alter table public.members enable row level security;

-- Two yes/no questions the rules below ask. "security definer" lets them read the
-- members table even though the caller may not be allowed to.
create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and status = 'approved');
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members
                 where user_id = auth.uid() and status = 'approved' and role = 'admin');
$$;

revoke execute on function public.is_approved(), public.is_admin() from public, anon;
grant execute on function public.is_approved(), public.is_admin() to authenticated;

-- When someone creates an account, add their pending row (name comes from the sign-up form)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.members (user_id, email, name)
  values (new.id, coalesce(new.email, ''), left(coalesce(new.raw_user_meta_data->>'name', ''), 40))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- Who may see / change the members table
create policy "Read own membership" on public.members
  for select to authenticated using (auth.uid() = user_id);
create policy "Admins read all members" on public.members
  for select to authenticated using (public.is_admin());
create policy "Admins change members" on public.members
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- A member may change their own name (and nothing else)
create or replace function public.set_my_name(new_name text)
returns void language sql security definer set search_path = public as $$
  update public.members set name = left(trim(new_name), 40) where user_id = auth.uid();
$$;
revoke execute on function public.set_my_name(text) from public, anon;
grant execute on function public.set_my_name(text) to authenticated;

-- For later games: approved members can see each other's names (never emails)
create or replace function public.approved_members()
returns table (user_id uuid, name text) language sql stable security definer set search_path = public as $$
  select user_id, name from public.members where status = 'approved' and public.is_approved();
$$;
revoke execute on function public.approved_members() from public, anon;
grant execute on function public.approved_members() to authenticated;

-- Logs and reminder subscriptions: still "only your own rows", and now only once approved
drop policy if exists "Read own entries"   on public.entries;
drop policy if exists "Add own entries"    on public.entries;
drop policy if exists "Change own entries" on public.entries;
drop policy if exists "Delete own entries" on public.entries;
create policy "Read own entries"   on public.entries for select to authenticated
  using (auth.uid() = user_id and public.is_approved());
create policy "Add own entries"    on public.entries for insert to authenticated
  with check (auth.uid() = user_id and public.is_approved());
create policy "Change own entries" on public.entries for update to authenticated
  using (auth.uid() = user_id and public.is_approved()) with check (auth.uid() = user_id and public.is_approved());
create policy "Delete own entries" on public.entries for delete to authenticated
  using (auth.uid() = user_id and public.is_approved());

drop policy if exists "Read own subscriptions"   on public.push_subscriptions;
drop policy if exists "Add own subscriptions"    on public.push_subscriptions;
drop policy if exists "Change own subscriptions" on public.push_subscriptions;
drop policy if exists "Delete own subscriptions" on public.push_subscriptions;
create policy "Read own subscriptions"   on public.push_subscriptions for select to authenticated
  using (auth.uid() = user_id and public.is_approved());
create policy "Add own subscriptions"    on public.push_subscriptions for insert to authenticated
  with check (auth.uid() = user_id and public.is_approved());
create policy "Change own subscriptions" on public.push_subscriptions for update to authenticated
  using (auth.uid() = user_id and public.is_approved()) with check (auth.uid() = user_id and public.is_approved());
create policy "Delete own subscriptions" on public.push_subscriptions for delete to authenticated
  using (auth.uid() = user_id and public.is_approved());

-- The existing account (created before this table) becomes the approved admin
insert into public.members (user_id, email, name, status, role, approved_at)
select id, email, 'Javier', 'approved', 'admin', now() from auth.users where email = 'jmbg.bego@gmail.com'
on conflict (user_id) do update set status = 'approved', role = 'admin', approved_at = now();
