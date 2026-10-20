// =====================================================
//  1. STORAGE
//  Every change is saved in this browser straight away (so the app
//  works without internet), and also put in an "outbox". When you're
//  signed in and online, the outbox is sent to Supabase (the online
//  database), and we download the full, up-to-date list of entries.
// =====================================================

// Your Supabase project. These two values are meant to be public: the
// database's own rules (see supabase-setup.sql) protect your data.
// NEVER put the "service_role" / "secret" key here.
const SUPABASE_URL = "https://ugzvmzkigbbnigdcqbfo.supabase.co";
const SUPABASE_KEY = "sb_publishable_Dk-xgU9NWZ2SNcD-4M0I9w_W8iA522l";   // the public "publishable" key

const STORAGE_KEY = "workout-entries";
const OUTBOX_KEY = "workout-outbox";

// Read all saved entries (an empty list if there are none yet)
function loadEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (error) {
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

// The changes not yet sent online
function loadOutbox() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || [];
  } catch (error) {
    return [];
  }
}

function saveOutbox(outbox) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
}

// A unique id: the current time plus a few random letters, e.g. "1792473217680-k3f9"
function newId() {
  return Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

// Add one new entry, with an id, an owner and the time it was created
function addEntry(entry) {
  entry.id = entry.id || newId();          // keep an id we already chose
  entry.user = "me";                       // whose entry it is (for other users later)
  entry.createdAt = new Date().toISOString();
  recordChange({ op: "add", entry: entry });
}

// Change some fields of one entry, e.g. updateEntry(id, { date: "2026-10-19" })
function updateEntry(id, changes) {
  recordChange({ op: "update", id: id, changes: changes });
}

function deleteEntry(id) {
  recordChange({ op: "delete", id: id });
}

// Apply one change to a list of entries and return the new list
function applyChange(entries, change) {
  if (change.op === "add") {
    return entries.filter(function (e) { return e.id !== change.entry.id; }).concat([change.entry]);
  }
  if (change.op === "update") {
    return entries.map(function (e) {
      return e.id === change.id ? Object.assign({}, e, change.changes) : e;
    });
  }
  if (change.op === "delete") {
    return entries.filter(function (e) { return e.id !== change.id; });
  }
  return entries;
}

// Save a change here, add it to the outbox, and send it soon
function recordChange(change) {
  saveEntries(applyChange(loadEntries(), change));
  const outbox = loadOutbox();
  outbox.push(change);
  saveOutbox(outbox);
  syncSoon();
}


// ---------- Signing in ----------
// When you sign in, Supabase gives us a "session": a pass that proves who you
// are. It's kept in this browser and lasts an hour; after that we swap it for
// a fresh one automatically, so you stay signed in.

function getSession() {
  try {
    return JSON.parse(localStorage.getItem("supabase-session"));
  } catch (error) {
    return null;
  }
}

function setSession(session) {
  if (session) localStorage.setItem("supabase-session", JSON.stringify(session));
  else localStorage.removeItem("supabase-session");
}

// Ask Supabase's sign-in service for a session (with a password, or by renewing one)
async function requestSession(grantType, body) {
  const response = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=" + grantType, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const answer = await response.json();
  if (!response.ok) {
    throw new Error(answer.error_description || answer.msg || answer.message || "Sign-in failed");
  }
  setSession({
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token,
    expiresAt: Date.now() + answer.expires_in * 1000,
    userId: answer.user.id,
    email: answer.user.email
  });
}

async function signIn(email, password) {
  await requestSession("password", { email: email, password: password });
  // Upload everything already saved on this device (also logs from before signing in)
  const uploads = loadEntries().map(function (e) { return { op: "add", entry: e }; });
  saveOutbox(loadOutbox().concat(uploads));
  sync();
}

// Signing out removes your logs from this device (they stay safe online)
function signOut() {
  setSession(null);
  saveEntries([]);
  saveOutbox([]);
  setActiveWorkout(null);
  syncError = "";
  updateSyncStatus();
  refreshViews();
}

// A session that's still valid, renewed first if it's about to run out
async function validSession() {
  const session = getSession();
  if (Date.now() < session.expiresAt - 60000) return session;
  try {
    await requestSession("refresh_token", { refresh_token: session.refreshToken });
  } catch (error) {
    if (error instanceof TypeError) throw error;   // no internet: just try again later
    setSession(null);                              // the pass was refused
    throw new Error("Please sign in again in Profile");
  }
  return getSession();
}

// Send a request to your database table, as you (the signed-in user)
async function database(path, options) {
  const session = await validSession();
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: options.method || "GET",
    headers: Object.assign({
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + session.accessToken,
      "Content-Type": "application/json"
    }, options.headers),
    body: options.body
  });
  const text = await response.text();
  if (!response.ok) {
    let message = "Supabase error " + response.status;
    try { message = JSON.parse(text).message || message; } catch (error) { /* keep the number */ }
    throw new Error(message);
  }
  return text ? JSON.parse(text) : null;
}


// ---------- Syncing with Supabase ----------

let syncTimer;
let syncing = false;
let syncAgain = false;
let syncError = "";

// Wait a moment first, so several quick changes go in one trip
function syncSoon() {
  updateSyncStatus();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 300);
}

async function sync() {
  if (!SUPABASE_URL || !getSession()) return updateSyncStatus();   // not signed in: this device only
  if (syncing) { syncAgain = true; return; }    // already sending; go again afterwards

  syncing = true;
  updateSyncStatus();
  const sent = loadOutbox();
  try {
    // Which logs did the outbox touch? Those still here get saved online;
    // those no longer here were deleted, so delete them online too.
    const entries = loadEntries();
    const ids = Array.from(new Set(sent.map(function (c) {
      return c.op === "add" ? c.entry.id : c.id;
    })));
    const toSave = entries.filter(function (e) { return ids.includes(e.id); });
    const toDelete = ids.filter(function (id) {
      return !entries.some(function (e) { return e.id === id; });
    });

    if (toSave.length) {
      const userId = getSession().userId;
      await database("entries?on_conflict=user_id,id", {
        method: "POST",
        // "merge-duplicates" = if it's already there, replace it instead of failing
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(toSave.map(function (e) {
          return { user_id: userId, id: e.id, type: e.type, date: e.date, data: e,
                   updated_at: new Date().toISOString() };
        }))
      });
    }
    if (toDelete.length) {
      const list = toDelete.map(function (id) { return '"' + id + '"'; }).join(",");
      await database("entries?id=in.(" + encodeURIComponent(list) + ")", { method: "DELETE" });
    }

    // Download everything, 1000 at a time (the most Supabase sends at once)
    let online = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await database("entries?select=data&order=id&limit=1000&offset=" + offset, {});
      online = online.concat(page.map(function (row) { return row.data; }));
      if (page.length < 1000) break;
    }

    // Those changes arrived: take them out of the outbox. Then use the online
    // list, plus any changes you made while we were waiting.
    const stillWaiting = loadOutbox().slice(sent.length);
    saveOutbox(stillWaiting);
    saveEntries(stillWaiting.reduce(applyChange, online));
    syncError = "";
    refreshViews();
  } catch (error) {
    // No internet, or a problem: keep everything in the outbox and try later
    if (!navigator.onLine) syncError = "Offline";
    else if (error instanceof TypeError) syncError = "Can't reach Supabase";
    else syncError = error.message;
  }
  syncing = false;
  updateSyncStatus();
  renderAccount();   // in case you were signed out because the pass was refused
  if (syncAgain) { syncAgain = false; sync(); }
}

// The little status text in the header
function updateSyncStatus() {
  const status = document.getElementById("sync-status");
  const waiting = loadOutbox().length;
  if (!SUPABASE_URL || !getSession()) {
    status.textContent = syncError ? "⚠ " + syncError : "Not signed in";
  } else if (syncing) {
    status.textContent = "Syncing…";
  } else if (syncError) {
    status.textContent = (syncError === "Offline" ? "Offline" : "⚠ " + syncError) +
                         (waiting ? " · " + waiting + " waiting" : "");
  } else if (waiting) {
    status.textContent = waiting + " waiting…";
  } else {
    status.textContent = "Synced ✓";
  }
}

// Try again when the internet comes back, or when you reopen the app
window.addEventListener("online", sync);
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") sync();
});

// The workout you're in the middle of (only on this device), or null
function getActiveWorkout() {
  try {
    return JSON.parse(localStorage.getItem("active-workout"));
  } catch (error) {
    return null;
  }
}

function setActiveWorkout(workout) {
  if (workout) {
    localStorage.setItem("active-workout", JSON.stringify(workout));
  } else {
    localStorage.removeItem("active-workout");
  }
}

// Small remembered settings, like whether you prefer kg or lb
function getPref(name, fallback) {
  try {
    return localStorage.getItem("pref-" + name) || fallback;
  } catch (error) {
    return fallback;
  }
}

function setPref(name, value) {
  try {
    localStorage.setItem("pref-" + name, value);
  } catch (error) {
    // Not important if it fails; we just won't remember the choice
  }
}


// =====================================================
//  2. HELPERS
// =====================================================

// Today's date as "2026-10-20", in your local time zone
function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

// A moment (now, by default) as "07:32", in your local time
function timeOf(moment) {
  const d = moment ? new Date(moment) : new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// An entry's time. Entries from before times existed use when they were saved.
function entryTime(e) {
  return e.time || (e.createdAt ? timeOf(e.createdAt) : "");
}

// "07:32" -> "7:32 AM" or "07:32", following your device's clock setting
function formatTime(timeText) {
  if (!timeText) return "";
  return new Date("2000-01-01T" + timeText).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// "2026-10-20" -> "Tue, Oct 20, 2026"
function formatDate(dateText) {
  return new Date(dateText + "T00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric"
  });
}

// Is this field currently visible? (hidden fields are ignored when saving)
function isVisible(element) {
  return !element.closest("[hidden]");
}

// The little "Saved ✓" message at the bottom of the screen
let toastTimer;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.hidden = true; }, 2000);
}


// =====================================================
//  3. TABS
//  When you click a tab, highlight it and show its matching section.
// =====================================================

const tabs = document.querySelectorAll(".tab");
const sections = document.querySelectorAll(".section");

tabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    // Which section does this tab point to? (from data-section="...")
    const target = tab.dataset.section;

    // Un-highlight every tab and hide every section...
    tabs.forEach(function (t) { t.classList.remove("active"); });
    sections.forEach(function (s) { s.classList.remove("active"); });

    // ...then highlight the clicked tab and show its section.
    tab.classList.add("active");
    document.getElementById(target).classList.add("active");

    if (target === "history") renderHistory();
    if (target === "weight") renderWeight();
  });
});


// =====================================================
//  4. OPENING AND CLOSING THE FORMS
// =====================================================

const picker = document.getElementById("type-picker");
const forms = document.querySelectorAll("#log form.log-form");

function openForm(formId) {
  picker.hidden = true;
  forms.forEach(function (form) { form.hidden = form.id !== formId; });
  resetForm(document.getElementById(formId));
}

function closeForms() {
  forms.forEach(function (form) { form.hidden = true; });
  picker.hidden = false;
  renderCurrentWorkout();
}

// Any button with data-form="..." opens that form
document.querySelectorAll("#type-picker [data-form]").forEach(function (button) {
  button.addEventListener("click", function () { openForm(button.dataset.form); });
});

// Every "← Back" button returns to the type buttons
document.querySelectorAll(".back").forEach(function (button) {
  button.addEventListener("click", closeForms);
});

// Empty a form and fill in sensible defaults (today, your usual units)
function resetForm(form) {
  form.reset();
  const f = form.elements;
  if (f.date) f.date.value = today();     // weights and cardio use the workout's date instead
  if (f.time) f.time.value = timeOf();    // now; change it if you're logging later

  if (form.id === "form-weights" || form.id === "form-bodyweight") {
    f.unit.value = getPref("weightUnit", "kg");
  }
  if (form.id === "form-weights") {
    setsBox.innerHTML = "";
    addSetRow("", "");
    fillSuggestions("exercise-list", COMMON_EXERCISES, "weights", "exercise");
  }
  if (form.id === "form-cardio") {
    f.speedUnit.value = getPref("speedUnit", "km/h");
    updateCardioFields();
  }
  if (form.id === "form-sports") {
    f.tempUnit.value = getPref("tempUnit", "°C");
    fillSuggestions("sport-list", COMMON_SPORTS, "sports", "sport");
    updateGolfFields();
  }
  if (form.id === "form-finish") {
    // Total minutes comes from the timer (at least 1); you can still change it
    const workout = getActiveWorkout();
    f.date.value = workout.date;
    f.time.value = timeOf(workout.startedAt);   // a workout's time is when you started it
    const minutes = Math.max(1, Math.round((Date.now() - workout.startedAt) / 60000));
    f.minutes.value = minutes;

    // Over 4 hours probably means you forgot to press Finish last time
    document.getElementById("finish-hint").textContent = minutes > 240
      ? "⚠ The timer ran for over 4 hours. Did you forget to finish? Put in the real length."
      : "Filled in from the timer. Change it if you finished earlier.";
  }
}


// =====================================================
//  4b. THE CURRENT WORKOUT
//  Start → add weights/cardio → Finish. Each exercise is saved
//  right away with a "workoutId" that links it to the workout.
// =====================================================

document.getElementById("start-workout").addEventListener("click", function () {
  setActiveWorkout({ id: "w" + newId(), date: today(), startedAt: Date.now() });
  renderCurrentWorkout();
});

// ---------- The workout timer ----------
// It doesn't count by itself: every second it works out "now minus the time you
// pressed Start". So it stays right even if you close the page or lock your phone.

function updateWorkoutTimer() {
  const workout = getActiveWorkout();
  if (!workout) return;
  const seconds = Math.floor((Date.now() - workout.startedAt) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  document.getElementById("workout-timer").textContent =
    "⏱ " + h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
setInterval(updateWorkoutTimer, 1000);

// The exercises already added to the running workout
function currentWorkoutEntries() {
  const workout = getActiveWorkout();
  if (!workout) return [];
  return loadEntries().filter(function (e) { return e.workoutId === workout.id; });
}

// Show either the "Start" button or the running workout with its exercises
function renderCurrentWorkout() {
  const workout = getActiveWorkout();
  document.getElementById("no-workout").hidden = !!workout;
  document.getElementById("current-workout").hidden = !workout;
  if (!workout) return;
  updateWorkoutTimer();   // show the right time straight away, not after a second

  const list = document.getElementById("workout-items");
  list.innerHTML = "";
  const items = currentWorkoutEntries();
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "No exercises yet. Add your first one below.";
    list.appendChild(empty);
  }
  items.forEach(function (e) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = ICONS[e.type] + " " + describe(e);
    const remove = document.createElement("button");
    remove.className = "delete";
    remove.title = "Remove";
    remove.textContent = "×";
    remove.addEventListener("click", function () {
      if (confirm("Remove this exercise?")) {
        deleteEntry(e.id);
        renderCurrentWorkout();
      }
    });
    item.append(text, remove);
    list.appendChild(item);
  });
}

document.getElementById("form-finish").addEventListener("submit", function (event) {
  event.preventDefault();
  const f = event.target.elements;
  const workout = getActiveWorkout();
  const items = currentWorkoutEntries();
  if (items.length === 0) {
    showToast("Add at least one exercise first");
    return;
  }

  // If you changed the date, move the exercises to that date too
  items.forEach(function (e) {
    if (e.date !== f.date.value) updateEntry(e.id, { date: f.date.value });
  });

  addEntry({
    id: workout.id,
    type: "workout",
    date: f.date.value,
    time: f.time.value,
    minutes: Number(f.minutes.value),
    notes: f.notes.value.trim()
  });
  setActiveWorkout(null);
  showToast("Workout saved ✓");
  closeForms();
});

document.getElementById("discard-workout").addEventListener("click", function () {
  if (!confirm("Discard this workout and all its exercises?")) return;
  currentWorkoutEntries().forEach(function (e) { deleteEntry(e.id); });
  setActiveWorkout(null);
  closeForms();
});


// =====================================================
//  5. SUGGESTIONS (exercise and sport names)
//  Common names, plus any you've typed before.
// =====================================================

const COMMON_EXERCISES = [
  "Bench press", "Incline bench press", "Dumbbell press", "Chest fly", "Push-up",
  "Shoulder press", "Lateral raise", "Pull-up", "Lat pulldown", "Seated row",
  "Barbell row", "Deadlift", "Romanian deadlift", "Squat", "Leg press", "Lunge",
  "Leg extension", "Leg curl", "Calf raise", "Bicep curl", "Hammer curl",
  "Tricep pushdown", "Dips", "Plank", "Crunch"
];

const COMMON_SPORTS = [
  "Padel", "Golf", "Soccer", "Tennis", "Basketball", "Volleyball", "Swimming", "Cycling"
];

function fillSuggestions(listId, commonNames, type, field) {
  // Names you've used before come first, then the common ones, no duplicates
  const yourNames = loadEntries()
    .filter(function (e) { return e.type === type; })
    .map(function (e) { return e[field]; });
  const allNames = Array.from(new Set(yourNames.concat(commonNames)));

  const list = document.getElementById(listId);
  list.innerHTML = "";
  allNames.forEach(function (name) {
    const option = document.createElement("option");
    option.value = name;
    list.appendChild(option);
  });
}


// =====================================================
//  6. WEIGHTS: the rows of sets
// =====================================================

const setsBox = document.getElementById("sets");

function addSetRow(reps, weight) {
  const row = document.createElement("div");
  row.className = "set-row";
  row.innerHTML =
    '<span class="set-number"></span>' +
    '<input type="number" class="reps" min="1" step="1" inputmode="numeric" placeholder="Reps">' +
    '<input type="number" class="set-weight" min="0" step="0.5" inputmode="decimal" placeholder="Weight">' +
    '<button type="button" class="remove-set" title="Remove set">×</button>';
  row.querySelector(".reps").value = reps;
  row.querySelector(".set-weight").value = weight;

  row.querySelector(".remove-set").addEventListener("click", function () {
    if (setsBox.children.length > 1) {   // always keep at least one row
      row.remove();
      renumberSets();
    }
  });

  setsBox.appendChild(row);
  renumberSets();
}

function renumberSets() {
  Array.from(setsBox.children).forEach(function (row, index) {
    row.querySelector(".set-number").textContent = index + 1;
  });
}

// "+ Add set" copies the last set's numbers, since the next set is usually the same
document.getElementById("add-set").addEventListener("click", function () {
  const last = setsBox.lastElementChild;
  addSetRow(last.querySelector(".reps").value, last.querySelector(".set-weight").value);
});


// =====================================================
//  7. CARDIO and SPORTS: show only the fields that apply
// =====================================================

const cardioForm = document.getElementById("form-cardio");

function updateCardioFields() {
  const activity = cardioForm.elements.activity.value;
  cardioForm.querySelectorAll("[data-show]").forEach(function (field) {
    field.hidden = !field.dataset.show.split(",").includes(activity);
  });
}
cardioForm.elements.activity.addEventListener("change", updateCardioFields);

const sportsForm = document.getElementById("form-sports");

function updateGolfFields() {
  const sport = sportsForm.elements.sport.value.trim().toLowerCase();
  document.getElementById("golf-fields").hidden = sport !== "golf";
}
sportsForm.elements.sport.addEventListener("input", updateGolfFields);


// =====================================================
//  8. SAVING EACH FORM
//  "submit" happens when you press the Save button.
// =====================================================

document.getElementById("form-weights").addEventListener("submit", function (event) {
  event.preventDefault();               // stop the browser from reloading the page
  const form = event.target;
  const f = form.elements;

  // Collect every set that has reps filled in
  const sets = [];
  setsBox.querySelectorAll(".set-row").forEach(function (row) {
    const reps = row.querySelector(".reps").value;
    const weight = row.querySelector(".set-weight").value;
    if (reps !== "") {
      sets.push({ reps: Number(reps), weight: weight === "" ? 0 : Number(weight) });
    }
  });
  if (sets.length === 0) {
    showToast("Add at least one set with reps");
    return;
  }

  const exercise = f.exercise.value.trim();
  const workout = getActiveWorkout();
  addEntry({
    type: "weights",
    date: workout.date,
    time: timeOf(),
    workoutId: workout.id,
    exercise: exercise,
    unit: f.unit.value,
    sets: sets,
    notes: f.notes.value.trim()
  });
  setPref("weightUnit", f.unit.value);
  showToast("Added " + exercise + " ✓");

  // Go back to the workout, where you can add the next exercise or finish
  closeForms();
});

cardioForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const f = cardioForm.elements;

  let activity = f.activity.value;
  if (activity === "Other") {
    activity = f.otherName.value.trim();
    if (activity === "") {
      showToast("Write what you did");
      return;
    }
  }

  const workout = getActiveWorkout();
  const entry = {
    type: "cardio",
    date: workout.date,
    time: timeOf(),
    workoutId: workout.id,
    activity: activity,
    minutes: Number(f.minutes.value),
    notes: f.notes.value.trim()
  };

  // Only keep the extra numbers that apply to this activity and were filled in
  ["speed", "incline", "level", "floors"].forEach(function (name) {
    if (isVisible(f[name]) && f[name].value !== "") {
      entry[name] = Number(f[name].value);
    }
  });
  if (entry.speed !== undefined) {
    entry.speedUnit = f.speedUnit.value;
    setPref("speedUnit", f.speedUnit.value);
  }

  addEntry(entry);
  showToast("Added " + activity + " ✓");
  closeForms();
});

sportsForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const f = sportsForm.elements;

  const entry = {
    type: "sports",
    date: f.date.value,
    time: f.time.value,
    sport: f.sport.value.trim(),
    minutes: Number(f.minutes.value),
    notes: f.notes.value.trim()
  };

  // Golf extras, only if shown and filled in
  if (isVisible(f.temperature) && f.temperature.value !== "") {
    entry.temperature = Number(f.temperature.value);
    entry.tempUnit = f.tempUnit.value;
    setPref("tempUnit", f.tempUnit.value);
  }
  if (isVisible(f.score) && f.score.value !== "") {
    entry.score = Number(f.score.value);
  }

  addEntry(entry);
  showToast("Saved " + entry.sport + " ✓");
  closeForms();
});

document.getElementById("form-bodyweight").addEventListener("submit", function (event) {
  event.preventDefault();
  const f = event.target.elements;

  addEntry({
    type: "bodyweight",
    date: f.date.value,
    time: f.time.value,
    weight: Number(f.weight.value),
    unit: f.unit.value,
    morning: !f.notMorning.checked,
    peed: f.peed.checked,
    pooped: f.pooped.checked
  });
  setPref("weightUnit", f.unit.value);
  showToast("Saved weight ✓");
  closeForms();
});


// =====================================================
//  9. HISTORY LIST
// =====================================================

const ICONS = { workout: "💪", weights: "🏋️", cardio: "🏃", sports: "🎾", bodyweight: "⚖️" };

// Turn one entry into a short line of text
function describe(e) {
  if (e.type === "workout") {
    return "Workout — " + e.minutes + " min";
  }
  if (e.type === "weights") {
    const sets = e.sets.map(function (s) { return s.reps + "×" + s.weight; }).join(", ");
    return e.exercise + " — " + sets + " " + e.unit;
  }
  if (e.type === "cardio") {
    const parts = [e.minutes + " min"];
    if (e.speed !== undefined) parts.push(e.speed + " " + e.speedUnit);
    if (e.incline !== undefined) parts.push(e.incline + "% incline");
    if (e.level !== undefined) parts.push("level " + e.level);
    if (e.floors !== undefined) parts.push(e.floors + " floors");
    return e.activity + " — " + parts.join(" · ");
  }
  if (e.type === "sports") {
    const parts = [e.minutes + " min"];
    if (e.temperature !== undefined) parts.push(e.temperature + e.tempUnit);
    if (e.score !== undefined) parts.push("score " + e.score);
    return e.sport + " — " + parts.join(" · ");
  }
  if (e.type === "bodyweight") {
    return "Body weight — " + e.weight + " " + e.unit + (e.morning ? "" : " (not morning)") +
           toiletNote(e, " · ");
  }
  return "";
}

// " · after pee and poop", or "" if neither (or not recorded)
function toiletNote(e, before) {
  const done = [];
  if (e.peed) done.push("pee");
  if (e.pooped) done.push("poop");
  return done.length ? before + "after " + done.join(" and ") : "";
}

// The History filter: which entry types belong to each button
// (weights/cardio from before workouts existed count as "Workouts")
const FILTER_GROUP = { workout: "workout", weights: "workout", cardio: "workout",
                       sports: "sports", bodyweight: "bodyweight" };
let historyFilter = getPref("historyFilter", "all");
if (!["all", "workout", "sports", "bodyweight"].includes(historyFilter)) historyFilter = "all";

document.querySelectorAll("#history-filter button").forEach(function (button) {
  button.addEventListener("click", function () {
    historyFilter = button.dataset.filter;
    setPref("historyFilter", historyFilter);
    renderHistory();
  });
});

// "Today", "Yesterday", or "Mon, Oct 19, 2026"
function dayLabel(dateText) {
  if (dateText === today()) return "Today";
  if (dateText === shiftDate(today(), -1)) return "Yesterday";
  return formatDate(dateText);
}

function renderHistory() {
  const list = document.getElementById("history-list");
  list.innerHTML = "";

  const all = loadEntries();

  // Exercises that belong to a workout are shown inside it, not on their own
  // (the running workout's exercises are shown on the Log tab instead)
  const active = getActiveWorkout();
  const workoutIds = all.filter(function (e) { return e.type === "workout"; })
                        .map(function (e) { return e.id; });
  if (active) workoutIds.push(active.id);
  function exercisesOf(workoutId) {
    return all.filter(function (e) { return e.workoutId === workoutId; });
  }

  // Highlight the chosen filter button
  document.querySelectorAll("#history-filter button").forEach(function (button) {
    button.classList.toggle("active", button.dataset.filter === historyFilter);
  });

  // Newest first, only the kind chosen in the filter
  const entries = all.filter(function (e) {
    return !e.workoutId || !workoutIds.includes(e.workoutId);
  }).filter(function (e) {
    return historyFilter === "all" || FILTER_GROUP[e.type] === historyFilter;
  }).sort(function (a, b) {
    return (b.date + entryTime(b) + b.createdAt).localeCompare(a.date + entryTime(a) + a.createdAt);
  });

  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = historyFilter === "all" ? "Nothing logged yet." : "Nothing of this kind yet.";
    list.appendChild(empty);
    return;
  }

  let previousDate = "";
  entries.forEach(function (e) {
    // A heading each time a new day starts
    if (e.date !== previousDate) {
      const heading = document.createElement("li");
      heading.className = "day-heading";
      heading.textContent = dayLabel(e.date);
      list.appendChild(heading);
      previousDate = e.date;
    }

    const item = document.createElement("li");
    item.className = "entry";

    const text = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = ICONS[e.type] + " " + describe(e);
    const details = document.createElement("div");
    details.className = "hint small";
    details.textContent = formatTime(entryTime(e)) + (e.notes ? " · " + e.notes : "");
    text.append(title, details);

    // A workout lists its exercises underneath
    const children = e.type === "workout" ? exercisesOf(e.id) : [];
    if (e.type === "workout") {
      title.textContent += " · " + children.length + (children.length === 1 ? " exercise" : " exercises");
      const sub = document.createElement("ul");
      sub.className = "sub-list";
      children.sort(function (a, b) { return entryTime(a).localeCompare(entryTime(b)); });
      children.forEach(function (c) {
        const line = document.createElement("li");
        line.textContent = ICONS[c.type] + " " + describe(c) + " · " + formatTime(entryTime(c));
        sub.appendChild(line);
      });
      text.appendChild(sub);
    }

    const remove = document.createElement("button");
    remove.className = "delete";
    remove.title = "Delete";
    remove.textContent = "×";
    remove.addEventListener("click", function () {
      const question = e.type === "workout"
        ? "Delete this workout and all its exercises?"
        : "Delete this entry?";
      if (confirm(question)) {
        children.forEach(function (c) { deleteEntry(c.id); });
        deleteEntry(e.id);
        renderHistory();
      }
    });

    item.append(text, remove);
    list.appendChild(item);
  });
}


// =====================================================
//  9b. WEIGHT TAB: weekly averages and charts
//  Averages use morning weigh-ins only (the most comparable ones).
// =====================================================

const LB_PER_KG = 2.20462;
let weightRangeDays = getPref("weightRange", "91");   // how far back to show; "" = all
if (weightRangeDays === "all") weightRangeDays = "";
if (!["30", "91", "365", ""].includes(weightRangeDays)) weightRangeDays = "91";
let morningChart, allChart;                            // the two charts, once drawn

// A Date -> "2026-10-20" (in your time zone)
function localDateText(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
         String(d.getDate()).padStart(2, "0");
}

// "2026-10-20" plus or minus some days
function shiftDate(dateText, days) {
  const d = new Date(dateText + "T00:00");
  d.setDate(d.getDate() + days);
  return localDateText(d);
}

// The Monday of that date's week, e.g. Thu "2026-10-22" -> Mon "2026-10-19"
function weekStart(dateText) {
  const d = new Date(dateText + "T00:00");
  return shiftDate(dateText, -((d.getDay() + 6) % 7));
}

// A weigh-in in kg or lb (converting if you logged it in the other unit)
function weightIn(e, unit) {
  let w = e.weight;
  if (e.unit !== unit) w = unit === "kg" ? w / LB_PER_KG : w * LB_PER_KG;
  return w;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Group weigh-ins by week: [{ week: "2026-10-19", average: 80.2, count: 4 }, ...] oldest first
function weeklyAverages(weighIns, unit) {
  const weeks = {};
  weighIns.forEach(function (e) {
    const week = weekStart(e.date);
    weeks[week] = weeks[week] || [];
    weeks[week].push(weightIn(e, unit));
  });
  return Object.keys(weeks).sort().map(function (week) {
    const list = weeks[week];
    const total = list.reduce(function (sum, w) { return sum + w; }, 0);
    return { week: week, average: round1(total / list.length), count: list.length };
  });
}

// The range buttons above the charts
document.querySelectorAll("#weight .range-buttons button").forEach(function (button) {
  button.addEventListener("click", function () {
    weightRangeDays = button.dataset.days;
    setPref("weightRange", weightRangeDays || "all");   // an empty value wouldn't be remembered
    renderWeight();
  });
});

function renderWeight() {
  const unit = getPref("weightUnit", "kg");
  const weighIns = loadEntries()
    .filter(function (e) { return e.type === "bodyweight"; })
    .sort(function (a, b) {
      return (a.date + entryTime(a) + a.createdAt).localeCompare(b.date + entryTime(b) + b.createdAt);
    });

  document.getElementById("weight-empty").hidden = weighIns.length > 0;
  document.getElementById("weight-content").hidden = weighIns.length === 0;
  if (weighIns.length === 0) return;

  const morning = weighIns.filter(function (e) { return e.morning; });
  const weeks = weeklyAverages(morning, unit);

  // --- The two numbers at the top (always this week vs last week) ---
  const thisWeek = weeks.find(function (w) { return w.week === weekStart(today()); });
  const lastWeek = weeks.find(function (w) { return w.week === weekStart(shiftDate(today(), -7)); });

  document.getElementById("stat-week").textContent = thisWeek ? thisWeek.average + " " + unit : "–";
  document.getElementById("stat-week-note").textContent = thisWeek
    ? thisWeek.count + (thisWeek.count === 1 ? " morning weigh-in" : " morning weigh-ins")
    : "No morning weigh-ins yet";

  if (thisWeek && lastWeek) {
    const change = round1(thisWeek.average - lastWeek.average);
    document.getElementById("stat-change").textContent =
      (change > 0 ? "+" : change < 0 ? "−" : "") + Math.abs(change).toFixed(1) + " " + unit;
    document.getElementById("stat-change-note").textContent = "Last week: " + lastWeek.average + " " + unit;
  } else {
    document.getElementById("stat-change").textContent = "–";
    document.getElementById("stat-change-note").textContent = "Needs a morning weigh-in in both weeks";
  }

  // --- Only what's inside the chosen range ---
  document.querySelectorAll("#weight .range-buttons button").forEach(function (button) {
    button.classList.toggle("active", button.dataset.days === weightRangeDays);
  });
  const from = weightRangeDays ? shiftDate(today(), -Number(weightRangeDays)) : "";
  const shown = weighIns.filter(function (e) { return e.date >= from; });
  const shownWeeks = weeks.filter(function (w) { return w.week >= weekStart(from || w.week); });

  // --- The weekly table, newest first ---
  const tbody = document.querySelector("#weekly-table tbody");
  tbody.innerHTML = "";
  shownWeeks.slice().reverse().forEach(function (w) {
    const row = document.createElement("tr");
    [formatDate(w.week), w.average + " " + unit, w.count].forEach(function (value) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });

  drawWeightCharts(shown, shownWeeks, unit);
}

// One dot on a chart: x is the date as a number, y the weight.
// "date" and "note" are extra info for the tooltip.
function weightPoint(e, unit) {
  return {
    x: new Date(e.date + "T00:00").getTime(),
    y: round1(weightIn(e, unit)),
    date: e.date,
    time: entryTime(e),
    note: toiletNote(e, " · ")
  };
}

function drawWeightCharts(shown, weeks, unit) {
  // Chart.js comes from the internet; without a connection, skip the charts
  const chartsLoaded = typeof Chart !== "undefined";
  document.getElementById("chart-offline").hidden = chartsLoaded;
  document.querySelectorAll(".chart-card").forEach(function (card) { card.hidden = !chartsLoaded; });
  if (!chartsLoaded) return;

  // Use the page's own colors, so the charts follow light/dark mode
  const css = getComputedStyle(document.documentElement);
  const colors = {
    accent: css.getPropertyValue("--accent").trim(),
    muted: css.getPropertyValue("--muted").trim(),
    border: css.getPropertyValue("--border").trim(),
    card: css.getPropertyValue("--card").trim()
  };

  const morning = shown.filter(function (e) { return e.morning; });
  const other = shown.filter(function (e) { return !e.morning; });

  // The weekly average is drawn on the Thursday, the middle of each week
  // (or today, for this week, so the line doesn't run into the future)
  const averageLine = weeks.map(function (w) {
    const middle = shiftDate(w.week, 3) > today() ? today() : shiftDate(w.week, 3);
    return { x: new Date(middle + "T00:00").getTime(), y: w.average,
             date: w.week, note: " · " + w.count + (w.count === 1 ? " weigh-in" : " weigh-ins"),
             isWeek: true };
  });

  if (morningChart) morningChart.destroy();
  morningChart = new Chart(document.getElementById("chart-morning"), {
    type: "line",
    data: { datasets: [
      { label: "Weekly average", data: averageLine, borderColor: colors.accent,
        backgroundColor: colors.accent, borderWidth: 2,
        pointRadius: averageLine.length === 1 ? 4 : 0, pointHoverRadius: 5 },
      { label: "Morning weigh-in", data: morning.map(function (e) { return weightPoint(e, unit); }),
        showLine: false, pointRadius: 4, pointHoverRadius: 6,
        backgroundColor: colors.accent + "70", borderColor: colors.card, borderWidth: 1 }
    ]},
    options: chartOptions(colors, unit)
  });

  if (allChart) allChart.destroy();
  allChart = new Chart(document.getElementById("chart-all"), {
    type: "line",
    data: { datasets: [
      { label: "Morning", data: morning.map(function (e) { return weightPoint(e, unit); }),
        showLine: false, pointRadius: 4, pointHoverRadius: 6,
        backgroundColor: colors.accent + "70", borderColor: colors.card, borderWidth: 1 },
      { label: "Other times", data: other.map(function (e) { return weightPoint(e, unit); }),
        showLine: false, pointRadius: 5, pointHoverRadius: 7, pointStyle: "triangle",
        backgroundColor: colors.muted, borderColor: colors.card, borderWidth: 1 }
    ]},
    options: chartOptions(colors, unit)
  });
}

// Settings shared by both charts: quiet axes, dates on the bottom, a helpful tooltip
function chartOptions(colors, unit) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { labels: { color: colors.muted, usePointStyle: true, boxWidth: 8, boxHeight: 6 } },
      tooltip: { callbacks: {
        title: function (items) {
          const p = items[0].raw;
          return (p.isWeek ? "Week of " : "") + formatDate(p.date) + (p.time ? " · " + formatTime(p.time) : "");
        },
        label: function (item) {
          return item.dataset.label + ": " + item.raw.y + " " + unit + item.raw.note;
        }
      }}
    },
    scales: {
      x: {
        type: "linear",
        // the axis starts where the chosen range starts, and ends today
        min: weightRangeDays ? new Date(shiftDate(today(), -Number(weightRangeDays)) + "T00:00").getTime() : undefined,
        max: new Date(today() + "T00:00").getTime(),
        grid: { display: false },
        ticks: { color: colors.muted, maxTicksLimit: 6, callback: function (value) {
          return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        }}
      },
      y: {
        grid: { color: colors.border },
        ticks: { color: colors.muted, maxTicksLimit: 5 }
      }
    }
  };
}


// =====================================================
//  10. PROFILE: your account
// =====================================================

const signInForm = document.getElementById("form-signin");

// Show the sign-in form, or "Signed in as …"
function renderAccount() {
  const session = getSession();
  signInForm.hidden = !!session;
  document.getElementById("signed-in").hidden = !session;
  if (session) document.getElementById("signed-in-email").textContent = session.email;
}

signInForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  const f = signInForm.elements;
  if (!SUPABASE_URL) {
    showToast("Supabase isn't set up yet");
    return;
  }
  try {
    await signIn(f.email.value.trim(), f.password.value);
    signInForm.reset();
    renderAccount();
    showToast("Signed in ✓");
  } catch (error) {
    showToast(error instanceof TypeError ? "Can't reach Supabase. Are you online?" : error.message);
  }
});

document.getElementById("sign-out").addEventListener("click", function () {
  const waiting = loadOutbox().length;
  const question = waiting
    ? waiting + " change(s) haven't been sent yet and will be lost. Sign out anyway?"
    : "Sign out? Your logs stay saved online.";
  if (!confirm(question)) return;
  signOut();
  renderAccount();
});

// Settings from the Google Sheets version, no longer used
localStorage.removeItem("pref-sheetUrl");
localStorage.removeItem("pref-sheetPassword");
localStorage.removeItem("pref-lastSync");


// =====================================================
//  11. START-UP
// =====================================================

// Redraw what's on screen after new data arrives
function refreshViews() {
  renderCurrentWorkout();
  renderAccount();
  if (document.getElementById("history").classList.contains("active")) renderHistory();
  if (document.getElementById("weight").classList.contains("active")) renderWeight();
}

renderCurrentWorkout();
renderAccount();
updateSyncStatus();
sync();
