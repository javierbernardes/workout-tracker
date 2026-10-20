-- =====================================================
--  WORKOUT TRACKER — readable views
--  Paste into Supabase: SQL Editor → New query → Run. Safe to run again.
--
--  The app saves each log as one bundle in entries.data. These "views"
--  show the logs as normal columns, one view per kind of log, like the
--  tabs of a spreadsheet. They fill themselves in automatically; there's
--  nothing to keep up to date. Find them in the Table Editor.
--
--  "security_invoker" makes the views follow the table's rules, so each
--  person still only sees their own logs.
-- =====================================================

create or replace view public.workouts with (security_invoker = true) as
select
  date,
  data->>'time'                  as "time",
  (data->>'minutes')::numeric    as total_minutes,
  data->>'notes'                 as notes,
  id,
  user_id
from public.entries
where type = 'workout'
order by date desc, "time" desc;

create or replace view public.weights with (security_invoker = true) as
select
  date,
  data->>'time'                  as "time",
  data->>'exercise'              as exercise,
  (select string_agg((s->>'reps') || ' × ' || (s->>'weight'), ', ')
     from jsonb_array_elements(data->'sets') as s)   as sets,
  jsonb_array_length(data->'sets')                   as set_count,
  data->>'unit'                  as unit,
  data->>'notes'                 as notes,
  data->>'workoutId'             as workout_id,
  id,
  user_id
from public.entries
where type = 'weights'
order by date desc, "time" desc;

create or replace view public.cardio with (security_invoker = true) as
select
  date,
  data->>'time'                  as "time",
  data->>'activity'              as activity,
  (data->>'minutes')::numeric    as minutes,
  (data->>'speed')::numeric      as speed,
  data->>'speedUnit'             as speed_unit,
  (data->>'incline')::numeric    as incline_percent,
  (data->>'level')::numeric      as level,
  (data->>'floors')::numeric     as floors,
  data->>'notes'                 as notes,
  data->>'workoutId'             as workout_id,
  id,
  user_id
from public.entries
where type = 'cardio'
order by date desc, "time" desc;

create or replace view public.sports with (security_invoker = true) as
select
  date,
  data->>'time'                  as "time",
  data->>'sport'                 as sport,
  (data->>'minutes')::numeric    as minutes,
  (data->>'temperature')::numeric as temperature,
  data->>'tempUnit'              as temp_unit,
  (data->>'score')::numeric      as score,
  data->>'notes'                 as notes,
  id,
  user_id
from public.entries
where type = 'sports'
order by date desc, "time" desc;

create or replace view public.body_weight with (security_invoker = true) as
select
  date,
  data->>'time'                  as "time",
  (data->>'weight')::numeric     as weight,
  data->>'unit'                  as unit,
  coalesce((data->>'morning')::boolean, true) as morning,
  (data->>'peed')::boolean       as peed_before,
  (data->>'pooped')::boolean     as pooped_before,
  id,
  user_id
from public.entries
where type = 'bodyweight'
order by date desc, "time" desc;

-- Only for you in the dashboard; nobody can read these from outside
-- without signing in.
revoke all on public.workouts, public.weights, public.cardio,
              public.sports, public.body_weight from anon;
