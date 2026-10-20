// =====================================================
//  1. STORAGE
//  For now everything is saved in this browser (localStorage).
//  In step 3 we swap these few functions for Google Sheets,
//  and the rest of the code stays the same.
// =====================================================

const STORAGE_KEY = "workout-entries";

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

// Add one new entry, with an id, an owner and the time it was created
function addEntry(entry) {
  entry.id = entry.id || Date.now().toString();   // keep an id we already chose
  entry.user = "me";                       // whose entry it is (for other users later)
  entry.createdAt = new Date().toISOString();
  const entries = loadEntries();
  entries.push(entry);
  saveEntries(entries);
}

// Change some fields of one entry, e.g. updateEntry(id, { date: "2026-10-19" })
function updateEntry(id, changes) {
  const entries = loadEntries().map(function (e) {
    return e.id === id ? Object.assign(e, changes) : e;
  });
  saveEntries(entries);
}

function deleteEntry(id) {
  const remaining = loadEntries().filter(function (e) { return e.id !== id; });
  saveEntries(remaining);
}

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
  });
});


// =====================================================
//  4. OPENING AND CLOSING THE FORMS
// =====================================================

const picker = document.getElementById("type-picker");
const forms = document.querySelectorAll("form.log-form");

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
    // Suggest the time since you pressed Start, if it looks like a real session
    const workout = getActiveWorkout();
    f.date.value = workout.date;
    const minutes = Math.round((Date.now() - workout.startedAt) / 60000);
    if (minutes >= 5 && minutes <= 300) f.minutes.value = minutes;
  }
}


// =====================================================
//  4b. THE CURRENT WORKOUT
//  Start → add weights/cardio → Finish. Each exercise is saved
//  right away with a "workoutId" that links it to the workout.
// =====================================================

document.getElementById("start-workout").addEventListener("click", function () {
  setActiveWorkout({ id: "w" + Date.now(), date: today(), startedAt: Date.now() });
  renderCurrentWorkout();
});

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
    weight: Number(f.weight.value),
    unit: f.unit.value,
    morning: !f.notMorning.checked
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
    return "Body weight — " + e.weight + " " + e.unit + (e.morning ? "" : " (not morning)");
  }
  return "";
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

  // Newest first
  const entries = all.filter(function (e) {
    return !e.workoutId || !workoutIds.includes(e.workoutId);
  }).sort(function (a, b) {
    return (b.date + b.createdAt).localeCompare(a.date + a.createdAt);
  });

  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = "Nothing logged yet.";
    list.appendChild(empty);
    return;
  }

  entries.forEach(function (e) {
    const item = document.createElement("li");
    item.className = "entry";

    const text = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = ICONS[e.type] + " " + describe(e);
    const details = document.createElement("div");
    details.className = "hint small";
    details.textContent = formatDate(e.date) + (e.notes ? " · " + e.notes : "");
    text.append(title, details);

    // A workout lists its exercises underneath
    const children = e.type === "workout" ? exercisesOf(e.id) : [];
    if (e.type === "workout") {
      title.textContent += " · " + children.length + (children.length === 1 ? " exercise" : " exercises");
      const sub = document.createElement("ul");
      sub.className = "sub-list";
      children.forEach(function (c) {
        const line = document.createElement("li");
        line.textContent = ICONS[c.type] + " " + describe(c);
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
//  10. START-UP: show the running workout, if there is one
// =====================================================

renderCurrentWorkout();
