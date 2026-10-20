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
  is a possible later add-on (would run via the Google Apps Script, costs money per use).

### Tech decisions
- Plain HTML/CSS/JS: `index.html`, `style.css`, `app.js`.
- Data: Google Sheets via a Google Apps Script web app (user chose this, "option A").
- Hosting: GitHub Pages (public repo, so no secrets in code; a simple password is typed once
  per device and stored in the browser to stop strangers writing to the sheet).
- Possible later move to Supabase if other users join.
- Storage code is isolated in part 1 of `app.js` so it can be swapped from localStorage to Sheets.

## Plan and progress
1. ✅ Basic page: header, 4 tabs (Log, History, Weight, Profile), light/dark mode.
2. ✅ Forms for all four types, saving to localStorage; simple History list with delete.
   Then: weights/cardio grouped into workouts (start/finish, total minutes); golf temp optional.
   User tested it 2026-10-20: all fine.
   Testing: no Node/Python on this PC; the preview pane blocks localStorage on file:// pages,
   so test via a throwaway PowerShell HttpListener server on localhost.
3. ✅ Connect Google Sheets: `google-apps-script.gs` (one tab per type, readable columns,
   password check, add/update/delete ops), setup steps in `SETUP.md`.
   app.js keeps localStorage as the local copy + an outbox of changes; syncs on load, after
   changes, when back online and when the app is reopened. Connection (URL + password) is set
   in Profile and stored per device. Tested against a fake Sheets mock in the browser only.
   User set up the real sheet + web app on 2026-10-20 ("Who has access: Anyone"); connected
   from the computer and shows Synced ✓. Phone can't connect until the site is hosted (step 6).
4. ✅ History: day headings (Today / Yesterday / date) and filter buttons
   (All / Workouts / Sports / Weight; remembered per device). Weight tab done: this-week morning average + change vs last week, range buttons
   (1M/3M/1Y/All), a highlighted "Morning weight" chart (dots + weekly average line) and a
   muted "All weigh-ins" reference chart (Chart.js 4.4.1 from cdnjs), weekly table.
   Body weight form also asks "Before weighing, did you… Pee / Poop" (`peed`, `pooped`).
   Apps Script now reads columns by title and auto-upgrades old tabs when columns change;
   user must deploy a new version of the script whenever its columns change.
   User deployed the updated script and tested everything on 2026-10-20: works.
   Every entry has a `time` ("HH:MM"): editable Time box next to Date (defaults to now; a
   workout's defaults to its start); weights/cardio get the time they were added. Old entries
   fall back to `createdAt`. Sheet has a Time column after Date (script needs redeploy).
   Not chosen for History (maybe later): editing entries, workout totals (sets, volume).
5. ⬜ Profile + calorie estimates.
6. ⬜ Publish on GitHub Pages; add to phone home screen.
7. ⬜ Later: extras, design polish, other users, optional AI helper.

GitHub: https://github.com/javierbernardes/workout-tracker (remote `origin`, branch `main`).
Repo is currently Private; must be made Public for free GitHub Pages (step 6).
Git signs in via Git Credential Manager (browser); no `gh` CLI installed.
Commit/push only when the user asks.
