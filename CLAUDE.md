# Workout Tracker — project notes

## About the user
- Beginner at programming. Explain every part in plain English as we build it.
- Ask questions one or two at a time before big decisions.
- Keep it simple: no installs if possible (no Node, no build tools, no frameworks).

## What we're building
A minimal, clean personal workout tracker website, in English, usable on phone and computers.
Just for the user for now, but designed so others can use it later (every entry has `user: "me"`).

### Log types
- **Workout:** weights and cardio are logged inside a workout: Start → add exercises → Finish
  (date + total minutes, used for calories). Each exercise has `workoutId` = the workout entry's id.
  The running workout lives in localStorage `active-workout` (per device, not synced).
  Sports and body weight are logged on their own.
  A live timer (⏱ H:MM:SS, computed from `startedAt`) shows while a workout runs; Finish
  pre-fills total minutes from it (editable; warns if over 4 hours).
- **Weights:** exercise (suggestions list + remembers custom names), sets with reps + weight, kg or lb.
- **Cardio:** activity = Incline walking (incline %, speed, time), Walking (speed, time),
  Running (speed, time, optional incline), Stairmaster (level, time, optional floors), Other (name + time).
- **Sports:** any sport + time played. Golf also has optional temperature (°C/°F) and score.
- **Body weight:** kg or lb, assumed morning unless "Not a morning weigh-in" is ticked.
  Wants a weekly average and a chart of how weight fluctuates.
- **Calories:** conservative estimates for cardio and sports (MET-based), using weight + profile
  (height, age, sex).
- Exercise input: predefined list + own entries for now. An AI "describe your workout" helper
  is a possible later add-on (would need a small server function, e.g. a Supabase Edge
  Function, and costs money per use).

### Tech decisions
- Plain HTML/CSS/JS: `index.html`, `style.css`, `app.js`.
- Data: **Supabase** (switched from Google Sheets on 2026-10-20 because the user didn't want
  to keep re-pasting/redeploying the Apps Script). Table `entries` (user_id, id, type, date,
  data jsonb, updated_at), RLS so each user sees only their own rows (`supabase-setup.sql`).
  The whole entry is stored in `data`, so new fields never need database changes. Avoid
  anything that needs manual Supabase steps; if unavoidable, say so clearly.
- App talks to Supabase with plain `fetch` (no supabase-js): `/auth/v1/token` for sign-in /
  refresh, `/rest/v1/entries` for upsert/delete/select. Email + password sign-in; users are
  created in the Supabase dashboard; public sign-ups turned off. Project URL + anon key are
  constants at the top of `app.js` (public by design; never the service_role key).
- Hosting: GitHub Pages (public repo, so no secrets in code). Goal: updates go live
  automatically on push, with no manual steps for the user.
- Storage code is part 1 of `app.js`: localStorage copy + outbox of changes; sync uploads the
  entries the outbox touched, deletes the missing ones, then downloads everything (pages of 1000).

## Plan and progress
1. ✅ Basic page: header, 4 tabs (Log, History, Weight, Profile), light/dark mode.
2. ✅ Forms for all four types, saving to localStorage; simple History list with delete.
   Then: weights/cardio grouped into workouts (start/finish, total minutes); golf temp optional.
   User tested it 2026-10-20: all fine.
   Testing: no Node/Python on this PC; the preview pane blocks localStorage on file:// pages,
   so test via a throwaway PowerShell HttpListener server on localhost.
3. ✅ Online storage. First Google Sheets (worked, now removed; its Sheet stays as the user's
   backup), then replaced by Supabase: sign-in box in Profile, status in the header, setup steps
   in `SETUP.md`. Tested against a fake Supabase in the browser (sign-in, wrong password,
   upload, delete, offline, token refresh/refusal, other users' rows, >1000 rows, sign out).
   Real project created 2026-10-20 (URL + publishable key in app.js; sign-ups off; anon
   reads refused — checked). `supabase-views.sql` adds read-only views (workouts, weights,
   cardio, sports, body_weight; security_invoker) so the Table Editor shows normal columns.
   If new fields should appear there, update that file and the user re-runs it (optional;
   the app never depends on the views). Views were applied and all 10 old logs deleted
   (user confirmed) on 2026-10-20, so the table starts fresh.
   Claude has the Supabase MCP connector (org "barnardes", project id ugzvmzkigbbnigdcqbfo):
   run SQL / migrations directly instead of asking the user to paste SQL. Ask before deleting
   data or big changes; run get_advisors after schema changes. Keep the .sql files in the repo
   in sync with what was applied.
4. ✅ History: day headings (Today / Yesterday / date) and filter buttons
   (All / Workouts / Sports / Weight; remembered per device). Weight tab done: this-week morning average + change vs last week, range buttons
   (1M/3M/1Y/All), a highlighted "Morning weight" chart (dots + weekly average line) and a
   muted "All weigh-ins" reference chart (Chart.js 4.4.1 from cdnjs), weekly table.
   Body weight form also asks "Before weighing, did you… Pee / Poop" (`peed`, `pooped`).
   These are notes, not corrections: each weekly average shows a summary like
   "3 after pee · 1 after pee & poop · 2 with neither · 1 not noted" (toiletSummary).
   Every entry has a `time` ("HH:MM"): editable Time box next to Date (defaults to now; a
   workout's defaults to its start); weights/cardio get the time they were added. Old entries
   fall back to `createdAt`.
   Not chosen for History (maybe later): editing entries, workout totals (sets, volume).
5. ✅ Profile + calorie estimates (built 2026-10-20, from the deep research in
   `reports/Calorie estimation for workout tracker.md`, kept out of git):
   - Profile (height cm, birth date, sex) is a synced entry `{id:"profile", type:"profile"}`.
   - Calories (app.js part 9c): Mifflin-St Jeor resting burn per minute since midnight
     + 0.2 × resting for awake non-exercise minutes (awake = from wake time, max 16 h;
     assume 07:00 if not logged) + NET exercise kcal ((MET−1)·3.5·kg/200·min).
     Walking/incline walking with speed: ACSM net formula, grade capped 15%; running:
     Compendium speed METs + ACSM grade term; Stairmaster by level 4.5/6.8/9.3; weights
     Easy/Moderate/Hard 3.5/5/6 on workout minutes minus cardio minutes; sports table
     (padel 6, golf 4.5, tennis 6, soccer 7…), default 5. "Held the handrails" ×0.8.
     No food digestion, no afterburn (conservative). Matches the report's worked example.
   - Today box at the top of Log (updates each minute); History shows kcal per workout/sport
     and a daily total on each day heading.
   - Morning routine (part 9d): full-screen "Good morning" wake-up step (big "I just woke up",
     manual time, "Skip today"), then "Daily morning weigh-in" step ("Add weight later").
     Wake-up is a synced entry `{id:"wake-YYYY-MM-DD", type:"wake", time}`.
   - Installable PWA: manifest.json, icons (icon-180/192/512.png, drawn with PowerShell
     System.Drawing), sw.js (shows push notifications; no offline caching on purpose).
   - Daily reminder ("Good morning ☀️ Daily wake-up & weigh-in"): Profile → Morning
     notification. Supabase: tables push_subscriptions (RLS) + push_config (VAPID keys, no
     policies, service role only), Edge Function `morning-reminder` (verify_jwt off; GET =
     public key, POST {} = send due reminders, POST {test: endpoint} = test), pg_cron every
     5 min. Record in `supabase-reminder.sql` + `supabase/functions/morning-reminder/`.
     The user wanted lock-screen buttons like Spotify: impossible for web apps on iPhone
     (needs a native App Store app); tapping the reminder only opens the app.
     Couldn't test push in the preview browser (service workers blocked there), but on
     2026-10-20 the user re-added the home-screen app on iPhone, turned it on and received
     the test notification. Subscription: Apple push, 06:30 America/New_York.
6. ✅ Live at https://javierbernardes.github.io/workout-tracker/ (GitHub Pages from `main`,
   root; repo made Public 2026-10-20). User signed in on phone + added to home screen: works.
   Pushing to `main` updates the site in ~1–2 min. No custom domain (user declined).
   Maybe later: a proper app icon / web manifest for the home screen.
7. 🟡 Extras (built 2026-10-20, user chose this order; AI helper postponed by the user):
   - Edit entries: tap an entry (or an exercise inside a workout) in History → its form opens
     filled in ("✏️ Edit …", "Save changes"); saving replaces the entry with the same id
     (`editing` state + saveEdit in app.js part 4). Wake-up edits use the small form-wake.
   - Workout totals: sets + volume (reps × weight, in the usual unit) on workout cards.
   - "Weight" tab renamed "Progress" (section id still `weight`) with Week / Weight / Strength
     views (part 9e). Strength: per exercise (case-insensitive), best set per day as Epley
     estimated 1RM (weight × (1 + reps/30)); body-weight exercises (weight 0) track reps.
     Week: Mon–Sun summary tiles, calories-per-day bar chart, one line per day, ‹ › weeks.
   - Phone: bottom tab bar with icons under 600px, iPhone safe areas (viewport-fit=cover),
     "Last time: … [Use these]" on weights/cardio/sports forms, cardio starts on the last
     activity, tabs scroll to top.
   - Offline: sw.js caches the app + Chart.js; network first with a 3 s timeout, then the
     saved copy (bump CACHE name if the caching logic changes). Couldn't run service workers
     in the preview browser; logic only syntax-checked.
   - Food log (later, user wants it but "not yet"): entries `type: "food"` (name, kcal,
     optional protein/carbs/fat, time), "Last time" for frequent foods, Today box shows
     eaten vs burned. After 2–3 weeks with morning weigh-ins: estimate real maintenance
     (intake vs weekly weight trend) and replace the everyday calibration with it.
     User asked whether 2,000 kcal/day is right: explained it's ~1.12 × resting (Mifflin
     1,779), likely a conservative floor; real rest-day burn probably ~2,200–2,500.
     Could pair with the AI helper (describe a meal → calorie estimate).
   - AI helper (later): turn a typed workout into entries via a Supabase Edge Function calling
     the Claude API (separate pay-per-token account; key stored as a Supabase secret, never
     in the site). User was told: claude.ai subscription can't be used; Haiku 5.5 ≈ $0.0003,
     Sonnet 5.5 ≈ $0.006–0.015, Opus 5.5 ≈ $0.012–0.03 per request; user decides the model.
   ✅ WHOOP calibration (2026-10-20): old WHOOP export (Feb 2025 – Mar 2026, 374 cycles,
   187 workouts) in `whoop/` (git-ignored; analysed locally only, it's health data).
   Rest days measured ≈1,948 kcal vs our formula ≈2,051 (at the 180 lb set in WHOOP; the
   export has no profile weight). User chose a rest day of 2,000 kcal → everyday factor
   0.992 (at current 174.3 lb, age 22). Per-sport METs from WHOOP gross kcal/min:
   golf 2.7, padel 4.7, tennis 5.7, basketball 6.2 (≥9 sessions each); weightlifting kept
   (HR undercounts lifting); others too few sessions. Stored in the synced profile entry as
   `calibration: {everyday, sportMets, source}` (set via SQL); app applies it in
   restingPerDay/sportKcal, keeps it when the profile form is saved, and shows a note in Profile.

GitHub: https://github.com/javierbernardes/workout-tracker (remote `origin`, branch `main`).
Repo is Public (needed for free GitHub Pages): never commit passwords or secret keys.
Git signs in via Git Credential Manager (browser); no `gh` CLI installed.
Commit/push only when the user asks.
