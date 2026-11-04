-- =====================================================
--  FRIENDS: weekly and monthly challenges, rankings, points, trophies.
--  Applied 2026-11-04 (through the Supabase connector, in small batches; no DROP).
--
--  How it works, in plain words:
--  - There is always one weekly (Mon–Sun) and one monthly challenge. They are created
--    automatically from a rotation of "metrics" (what is counted); the admin can replace
--    the current one (set_current_challenge).
--  - A person's score is computed from their own logs by metric_score(); the database
--    shares only that number with the other approved members, never the logs.
--  - When a challenge ends, close_finished_challenges() ranks everyone, hands out points
--    (1st of N scorers gets N points … last scorer gets 1; monthly ×2) and records the
--    results. Wins = trophies; points within a quarter = the season table.
--  - Hourly: close what's over, create what's missing, and note who dropped out of the
--    top 3 (for a once-a-day notification).
-- =====================================================

create table if not exists public.challenges (
  id         uuid primary key default gen_random_uuid(),
  period     text not null check (period in ('week', 'month')),
  starts_on  date not null,
  ends_on    date not null,
  metric     text not null,
  title      text not null,
  closed     boolean not null default false,
  created_at timestamptz not null default now(),
  unique (period, starts_on)
);

create table if not exists public.challenge_results (
  challenge_id uuid not null references public.challenges on delete cascade,
  user_id      uuid not null references auth.users on delete cascade,
  score        numeric not null,
  rank         int not null,
  points       int not null,
  primary key (challenge_id, user_id)
);

-- Who was in the top 3 last time we looked (for "you dropped out of the top 3")
create table if not exists public.challenge_positions (
  challenge_id uuid not null references public.challenges on delete cascade,
  user_id      uuid not null references auth.users on delete cascade,
  rank         int not null,
  notified_on  date,
  primary key (challenge_id, user_id)
);

alter table public.challenges enable row level security;
alter table public.challenge_results enable row level security;
alter table public.challenge_positions enable row level security;
-- Nobody reads these tables directly; everything goes through the functions below
grant select on public.challenges, public.challenge_results to service_role;

-- ---------- What can be counted ----------
create or replace function public.metric_title(p_metric text)
returns text language sql immutable as $$
  select case p_metric
    when 'workouts'         then 'Most workouts'
    when 'sports'           then 'Most sports sessions'
    when 'active_days'      then 'Most active days'
    when 'exercise_minutes' then 'Most minutes of exercise'
    when 'weigh_in_days'    then 'Most morning weigh-ins'
    when 'early_wakeups'    then 'Most wake-ups before 7:30'
    when 'streak'           then 'Longest streak of active days'
    else p_metric end;
$$;

create or replace function public.metric_unit(p_metric text)
returns text language sql immutable as $$
  select case p_metric
    when 'workouts' then 'workouts' when 'sports' then 'sessions' when 'active_days' then 'days'
    when 'exercise_minutes' then 'min' when 'weigh_in_days' then 'weigh-ins'
    when 'early_wakeups' then 'early mornings' when 'streak' then 'days in a row' else '' end;
$$;

-- One person's score for a metric between two dates (dates in entries are 'YYYY-MM-DD' text)
create or replace function public.metric_score(p_user uuid, p_metric text, p_start date, p_end date)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  v numeric := 0; d date; prev date; run int := 0; best int := 0;
  s text := to_char(p_start, 'YYYY-MM-DD'); e text := to_char(p_end, 'YYYY-MM-DD');
begin
  if p_metric = 'workouts' then
    select count(*) into v from entries where user_id = p_user and type = 'workout' and date between s and e;
  elsif p_metric = 'sports' then
    select count(*) into v from entries where user_id = p_user and type = 'sports' and date between s and e;
  elsif p_metric = 'active_days' then
    select count(distinct date) into v from entries where user_id = p_user and type in ('workout', 'sports') and date between s and e;
  elsif p_metric = 'exercise_minutes' then
    select coalesce(sum(coalesce((data->>'minutes')::numeric, 0)), 0) into v from entries
      where user_id = p_user and type in ('workout', 'sports') and date between s and e;
  elsif p_metric = 'weigh_in_days' then
    select count(distinct date) into v from entries
      where user_id = p_user and type = 'bodyweight' and coalesce((data->>'morning')::boolean, true) and date between s and e;
  elsif p_metric = 'early_wakeups' then
    select count(*) into v from entries
      where user_id = p_user and type = 'wake' and coalesce(data->>'time', '99:99') < '07:30' and date between s and e;
  elsif p_metric = 'streak' then
    for d in select distinct date::date from entries
             where user_id = p_user and type in ('workout', 'sports') and date between s and e order by 1 loop
      if prev is not null and d = prev + 1 then run := run + 1; else run := 1; end if;
      if run > best then best := run; end if;
      prev := d;
    end loop;
    v := best;
  end if;
  return coalesce(v, 0);
end;
$$;
revoke execute on function public.metric_score(uuid, text, date, date) from public, anon, authenticated;

-- "Today" for everyone is Javier's time zone (the app's users are there)
create or replace function public.app_today()
returns date language sql stable as $$ select (now() at time zone 'America/New_York')::date; $$;

-- ---------- Creating the current challenges (the rotation) ----------
create or replace function public.ensure_current_challenges()
returns void language plpgsql security definer set search_path = public as $$
declare
  t date := app_today();
  ws date := date_trunc('week', t)::date;
  ms date := date_trunc('month', t)::date;
  weekly text[] := array['workouts', 'active_days', 'exercise_minutes', 'early_wakeups', 'sports', 'streak', 'weigh_in_days'];
  monthly text[] := array['workouts', 'active_days', 'exercise_minutes'];
  wm text; mm text;
begin
  wm := weekly[(extract(week from ws)::int % array_length(weekly, 1)) + 1];
  mm := monthly[(extract(month from ms)::int % array_length(monthly, 1)) + 1];
  insert into challenges (period, starts_on, ends_on, metric, title)
    values ('week', ws, ws + 6, wm, metric_title(wm)) on conflict (period, starts_on) do nothing;
  insert into challenges (period, starts_on, ends_on, metric, title)
    values ('month', ms, (ms + interval '1 month' - interval '1 day')::date, mm, metric_title(mm)) on conflict (period, starts_on) do nothing;
end;
$$;
revoke execute on function public.ensure_current_challenges() from public, anon, authenticated;

-- ---------- Scores and ranks for one challenge ----------
-- Everyone approved, with their score (0 if nothing logged), best first.
create or replace function public.challenge_scores(p_id uuid)
returns table (user_id uuid, name text, score numeric, rank int)
language sql stable security definer set search_path = public as $$
  with c as (select * from challenges where id = p_id),
  s as (
    select m.user_id, m.name, metric_score(m.user_id, c.metric, c.starts_on, c.ends_on) as score
    from members m, c where m.status = 'approved'
  )
  select user_id, name, score, rank() over (order by score desc)::int as rank from s order by rank, name;
$$;
revoke execute on function public.challenge_scores(uuid) from public, anon, authenticated;

-- ---------- Closing: ranks, points, results ----------
create or replace function public.close_finished_challenges()
returns void language plpgsql security definer set search_path = public as $$
declare c record; n int; mult int;
begin
  for c in select * from challenges where not closed and ends_on < app_today() loop
    select count(*) into n from challenge_scores(c.id) where score > 0;
    mult := case when c.period = 'month' then 2 else 1 end;
    insert into challenge_results (challenge_id, user_id, score, rank, points)
      select c.id, user_id, score, rank,
             case when score > 0 then greatest(n - rank + 1, 1) * mult else 0 end
      from challenge_scores(c.id)
      on conflict do nothing;
    update challenges set closed = true where id = c.id;
    -- Tell everyone how it ended (the notification program)
    perform net.http_post(
      url := 'https://ugzvmzkigbbnigdcqbfo.supabase.co/functions/v1/morning-reminder',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('challenge_closed', c.id));
  end loop;
end;
$$;
revoke execute on function public.close_finished_challenges() from public, anon, authenticated;

-- ---------- "You dropped out of the top 3" (checked hourly) ----------
create or replace function public.check_overtakes()
returns void language plpgsql security definer set search_path = public as $$
declare c record; r record; old_rank int; old_notified date;
begin
  for c in select * from challenges where not closed loop
    for r in select * from challenge_scores(c.id) loop
      select rank, notified_on into old_rank, old_notified from challenge_positions
        where challenge_id = c.id and user_id = r.user_id;
      if old_rank is not null and old_rank <= 3 and r.rank > 3 and r.score > 0
         and (old_notified is null or old_notified < app_today()) then
        perform net.http_post(
          url := 'https://ugzvmzkigbbnigdcqbfo.supabase.co/functions/v1/morning-reminder',
          headers := '{"Content-Type": "application/json"}'::jsonb,
          body := jsonb_build_object('overtaken', r.user_id, 'title', c.title, 'rank', r.rank));
        insert into challenge_positions (challenge_id, user_id, rank, notified_on)
          values (c.id, r.user_id, r.rank, app_today())
          on conflict (challenge_id, user_id) do update set rank = excluded.rank, notified_on = excluded.notified_on;
      else
        insert into challenge_positions (challenge_id, user_id, rank)
          values (c.id, r.user_id, r.rank)
          on conflict (challenge_id, user_id) do update set rank = excluded.rank;
      end if;
    end loop;
  end loop;
end;
$$;
revoke execute on function public.check_overtakes() from public, anon, authenticated;

-- ---------- What the app asks for (approved members only) ----------
-- The two current challenges with everyone's score, plus who you are
create or replace function public.friends_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not is_approved() then raise exception 'Not approved'; end if;
  perform close_finished_challenges();
  perform ensure_current_challenges();
  select jsonb_build_object(
    'me', auth.uid(),
    'today', app_today(),
    'challenges', (
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'period', c.period, 'metric', c.metric, 'title', c.title, 'unit', metric_unit(c.metric),
        'starts_on', c.starts_on, 'ends_on', c.ends_on,
        'scores', (select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'name', s.name, 'score', s.score, 'rank', s.rank) order by s.rank, s.name)
                   from challenge_scores(c.id) s)
      ) order by c.period desc)   -- 'week' before 'month'
      from challenges c where not c.closed
    )
  ) into result;
  return result;
end;
$$;
grant execute on function public.friends_overview() to authenticated;

-- Past challenges, newest first: winners and your own result
create or replace function public.hall_of_fame()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when is_approved() then coalesce(jsonb_agg(row_json order by ends_on desc), '[]'::jsonb) else '[]'::jsonb end
  from (
    select c.ends_on, jsonb_build_object(
      'id', c.id, 'period', c.period, 'title', c.title, 'unit', metric_unit(c.metric),
      'starts_on', c.starts_on, 'ends_on', c.ends_on,
      'winners', (select jsonb_agg(m.name order by m.name) from challenge_results r join members m on m.user_id = r.user_id
                  where r.challenge_id = c.id and r.rank = 1 and r.score > 0),
      'top_score', (select max(score) from challenge_results where challenge_id = c.id),
      'my_rank', (select rank from challenge_results where challenge_id = c.id and user_id = auth.uid()),
      'my_score', (select score from challenge_results where challenge_id = c.id and user_id = auth.uid()),
      'my_points', (select points from challenge_results where challenge_id = c.id and user_id = auth.uid())
    ) as row_json
    from challenges c where c.closed
    order by c.ends_on desc limit 40
  ) x;
$$;
grant execute on function public.hall_of_fame() to authenticated;

-- The season table (this quarter): points and trophies per person
create or replace function public.season_table()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when is_approved() then coalesce(jsonb_agg(jsonb_build_object(
      'user_id', m.user_id, 'name', m.name, 'points', coalesce(p.points, 0), 'wins', coalesce(p.wins, 0))
      order by coalesce(p.points, 0) desc, coalesce(p.wins, 0) desc, m.name), '[]'::jsonb) else '[]'::jsonb end
  from members m
  left join (
    select r.user_id, sum(r.points) as points, count(*) filter (where r.rank = 1 and r.score > 0) as wins
    from challenge_results r join challenges c on c.id = r.challenge_id
    where c.ends_on >= date_trunc('quarter', app_today())::date
    group by r.user_id
  ) p on p.user_id = m.user_id
  where m.status = 'approved';
$$;
grant execute on function public.season_table() to authenticated;

-- The admin replaces the current week's or month's challenge
create or replace function public.set_current_challenge(p_period text, p_metric text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if metric_title(p_metric) = p_metric then raise exception 'Unknown metric'; end if;
  perform ensure_current_challenges();
  update challenges set metric = p_metric, title = metric_title(p_metric)
    where period = p_period and not closed and starts_on <= app_today() and ends_on >= app_today();
  delete from challenge_positions where challenge_id in (select id from challenges where period = p_period and not closed);
end;
$$;
grant execute on function public.set_current_challenge(text, text) to authenticated;

-- ---------- Hourly housekeeping ----------
select cron.schedule('challenges-hourly', '7 * * * *',
  $$ select public.close_finished_challenges(); select public.ensure_current_challenges(); select public.check_overtakes(); $$);

-- A new challenge tells everyone it started (the notification program)
create or replace function public.notify_challenge_started()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url := 'https://ugzvmzkigbbnigdcqbfo.supabase.co/functions/v1/morning-reminder',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('challenge_started', new.id));
  return new;
end;
$$;
create trigger on_challenge_created after insert on public.challenges
  for each row execute function public.notify_challenge_started();

-- Only signed-in, approved members may call the app functions; the trigger helpers nobody
revoke execute on function public.friends_overview(), public.hall_of_fame(), public.season_table(),
  public.set_current_challenge(text, text) from public, anon;
revoke execute on function public.notify_challenge_started() from public, anon, authenticated;
alter function public.metric_title(text) set search_path = public;
alter function public.metric_unit(text) set search_path = public;
alter function public.app_today() set search_path = public;

-- =====================================================
--  Changed 2026-11-04 (evening): no monthly challenges. "This month" is a running points
--  total = weekly challenge points + daily activity points. Applied with CREATE OR REPLACE.
-- =====================================================

-- Points for daily activity: 5 per workout, 5 per sports session, 1 per morning weigh-in day, 1 per logged wake-up (changed from 2/2/1/1 on 2026-11-04)
create or replace function public.activity_points(p_user uuid, p_start date, p_end date)
returns int language sql stable security definer set search_path = public as $$
  with s as (select to_char(p_start, 'YYYY-MM-DD') as a, to_char(p_end, 'YYYY-MM-DD') as b)
  select (
    5 * (select count(*) from entries, s where user_id = p_user and type = 'workout' and date between s.a and s.b) +
    5 * (select count(*) from entries, s where user_id = p_user and type = 'sports' and date between s.a and s.b) +
    1 * (select count(distinct date) from entries, s where user_id = p_user and type = 'bodyweight'
         and coalesce((data->>'morning')::boolean, true) and date between s.a and s.b) +
    1 * (select count(*) from entries, s where user_id = p_user and type = 'wake' and date between s.a and s.b)
  )::int;
$$;
revoke execute on function public.activity_points(uuid, date, date) from public, anon, authenticated;

-- This month's running total for everyone: challenge points + activity points
create or replace function public.month_points()
returns jsonb language sql stable security definer set search_path = public as $$
  with bounds as (
    select date_trunc('month', app_today())::date as ms,
           (date_trunc('month', app_today()) + interval '1 month' - interval '1 day')::date as me
  ),
  rows_ as (
    select m.user_id, m.name,
      coalesce((select sum(r.points) from challenge_results r join challenges c on c.id = r.challenge_id
                where r.user_id = m.user_id and c.period = 'week' and c.ends_on between b.ms and b.me), 0)::int as challenge_points,
      activity_points(m.user_id, b.ms, b.me) as activity_points
    from members m, bounds b where m.status = 'approved'
  ),
  ranked as (
    select *, challenge_points + activity_points as points,
           rank() over (order by challenge_points + activity_points desc)::int as rank
    from rows_
  )
  select case when is_approved() then jsonb_build_object(
    'me', auth.uid(),
    'month_start', (select ms from bounds), 'month_end', (select me from bounds),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name, 'points', points,
              'challenge_points', challenge_points, 'activity_points', activity_points, 'rank', rank)
              order by rank, name) from ranked), '[]'::jsonb)
  ) else '{}'::jsonb end;
$$;
revoke execute on function public.month_points() from public, anon;
grant execute on function public.month_points() to authenticated;

-- ensure_current_challenges() now creates only the weekly challenge (same rotation);
-- season_table() adds activity points for the quarter. The open monthly challenge was deleted.

-- 2026-11-04 (later): rotation is now workouts / active_days / calories / sports / streak.
-- New metric 'calories' = sum of the "kcal" the app saves in each workout and sports entry
-- (metric_title, metric_unit, metric_score and ensure_current_challenges replaced accordingly).
-- 'calories' is leveled for body weight: sum(data.kcalPerKg) × 75 (the app saves kcal and
-- kcalPerKg on every workout/sport; exercise only, no resting burn).
-- Shown as 'Most effort' in 'effort pts' = sum(kcalPerKg) × 10 (not as calories, to avoid confusion).
