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
  setSessionFrom(answer);
}

// Remember a session Supabase gave us (from a sign-in, a renewal, or a link in an email)
function setSessionFrom(answer) {
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
  await loadMembership();   // approved, or still waiting?
  // Upload everything already saved on this device (also logs from before signing in)
  const uploads = loadEntries().map(function (e) { return { op: "add", entry: e }; });
  saveOutbox(loadOutbox().concat(uploads));
  sync();
}

// Signing out removes your logs from this device (they stay safe online)
function signOut() {
  setSession(null);
  setMembership(null);
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
  if (!isApproved()) return updateSyncStatus();                     // waiting for approval: keep logs here for now
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
  } else if (!isApproved()) {
    status.textContent = "Waiting for approval";
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

// The little "Saved ✓" message at the bottom of the screen.
// It rises from the bottom edge and sinks back the same way. With an "undo"
// function it also shows an Undo button and stays a bit longer.
let toastTimer;
let toastUndo = null;
function showToast(message, undo) {
  const toast = document.getElementById("toast");
  const undoButton = document.getElementById("toast-undo");
  document.getElementById("toast-text").textContent = message;
  toastUndo = undo || null;
  undoButton.hidden = !undo;
  fluid.show(toast, { y: 24, scale: 0.96 });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 5000 : 2000);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastUndo = null;
  fluid.hide(document.getElementById("toast"), { y: 24, scale: 0.96 });
}

document.getElementById("toast-undo").addEventListener("click", function () {
  const undo = toastUndo;
  hideToast();
  if (undo) undo();
});

// Delete straight away, with an Undo in the toast instead of an "Are you sure?"
// question. Undo puts the very same entries back (same ids, same created time).
function deleteWithUndo(entries, what, afterwards) {
  entries.forEach(function (e) { deleteEntry(e.id); });
  afterwards();
  showToast("Deleted " + what, function () {
    entries.forEach(function (e) { recordChange({ op: "add", entry: e }); });
    afterwards();
  });
}

// Turn a list row into a "swipe left to reveal a red button" row.
// The row's current contents become the card that slides; the button sits behind it.
//   - The card follows the finger 1:1 and rubber-bands past both ends.
//   - On release, a clear flick decides by direction; otherwise we project where
//     the movement would stop and snap to the nearer end, carrying the speed.
//   - Only one row is open at a time; tapping an open card closes it.
let openSwipeRow = null;
function swipeRow(row, label, onAction) {
  const card = document.createElement("div");
  card.className = "swipe-card " + row.className;
  while (row.firstChild) card.appendChild(row.firstChild);
  row.className = "swipe-row";

  const action = document.createElement("button");
  action.type = "button";
  action.className = "swipe-action";
  action.textContent = label;
  action.tabIndex = -1;             // keyboards use the × instead
  action.addEventListener("click", function (event) {
    event.stopPropagation();
    onAction();
  });
  row.append(action, card);

  const x = fluid.valuesOf(card).x;
  const width = function () { return action.getBoundingClientRect().width; };
  let base = 0;

  function settle(target, velocity) {
    openSwipeRow = target < 0 ? row : (openSwipeRow === row ? null : openSwipeRow);
    return fluid.springTo(x, target, Object.assign({}, fluid.SPRING.momentum, { velocity: velocity || 0 }));
  }
  row.close = function () { settle(0, 0); };

  fluid.pointerDrag(card, {
    axis: "x",
    onStart: function () {
      if (openSwipeRow && openSwipeRow !== row) openSwipeRow.close();
      x.stop();
      base = x.get();
      card.style.willChange = "transform";
    },
    onMove: function (info) {
      const w = width();
      let pos = base + info.dx;
      if (pos > 0) pos = fluid.rubberband(pos, w);                 // nothing to the right
      else if (pos < -w) pos = -w + fluid.rubberband(pos + w, w);  // no further than the button
      fluid.jump(x, pos);
    },
    onEnd: function (info) {
      card.style.willChange = "";
      const w = width();
      let target;
      if (Math.abs(info.vx) > 400) target = info.vx < 0 ? -w : 0;
      else target = fluid.nearest([-w, 0], x.get() + fluid.project(info.vx));
      settle(target, info.vx);
    }
  });

  // Tapping an open card just closes it
  card.addEventListener("click", function (event) {
    if (x.get() < -1) { event.stopPropagation(); settle(0, 0); }
  }, true);
}


// =====================================================
//  3. TABS
//  When you click a tab, highlight it and show its matching section.
// =====================================================

const tabs = document.querySelectorAll(".tab");
const sections = document.querySelectorAll(".section");
const tabIndicator = document.querySelector(".tab-indicator");

// Slide the pill behind the chosen tab. It's a spring, so tapping another tab
// while it's still moving just re-aims it from wherever it is.
function moveTabIndicator(tab, instantly) {
  const x = tab.offsetLeft - tabs[0].offsetLeft;
  const value = fluid.valuesOf(tabIndicator).x;
  if (instantly) fluid.jump(value, x);
  else fluid.springTo(value, x);
}

tabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    // Which section does this tab point to? (from data-section="...")
    const target = tab.dataset.section;
    if (editing) stopEditing(false);   // leaving a half-done edit cancels it
    if (tab.classList.contains("active")) { window.scrollTo(0, 0); return; }
    window.scrollTo(0, 0);             // each tab starts at the top

    // Un-highlight every tab and hide every section...
    tabs.forEach(function (t) { t.classList.remove("active"); t.removeAttribute("aria-current"); });
    sections.forEach(function (s) { s.hidden = true; });

    // ...then highlight the clicked tab and show its section.
    tab.classList.add("active");
    tab.setAttribute("aria-current", "page");
    moveTabIndicator(tab);
    // The old section is gone at once (no waiting); the new one fades in with a small rise.
    // It's shown first, because measuring positions (the Progress pill) only works when visible.
    fluid.show(document.getElementById(target), { y: 8 }, { duration: 0.25 });
    if (target === "history") renderHistory();
    if (target === "weight") renderProgress();
  });
});

// Put the pill in place on load, and keep it right if the window changes size
moveTabIndicator(document.querySelector(".tab.active"), true);
window.addEventListener("resize", function () { moveTabIndicator(document.querySelector(".tab.active"), true); });


// =====================================================
//  4. OPENING AND CLOSING THE FORMS
// =====================================================

// The forms live in a "sheet": a panel that slides up from the bottom of the
// screen over whatever you're looking at. You close it with Cancel, by saving,
// by tapping the dim area, with Escape, or by dragging it down.
//
// makeSheet() builds that behavior once, for both the form sheet and the small
// question sheet. How the drag works, in plain words:
//   - While your finger is down, the sheet follows it exactly (1:1). Pulling it
//     higher than its resting place meets growing resistance (rubber-band).
//   - When you let go, we look at how fast you were moving. A clear flick decides
//     (down = close, up = stay); otherwise we project where the movement would
//     stop and pick whichever is nearer. The spring then continues at your
//     finger's speed, so there's no visible seam between dragging and animating.
//   - Everything starts from where the sheet is right now, so you can grab it
//     mid-animation and reverse it.
function makeSheet(sheet, scrim, options) {
  const values = fluid.valuesOf(sheet);
  const scrimValues = fluid.valuesOf(scrim);
  let open = false;
  let lastFocus = null;
  let anims = [];

  // How far down is "closed"? (its own height, plus a little, so the shadow goes too)
  function closedY() { return sheet.getBoundingClientRect().height + 40; }

  function stopAnims() {
    anims.forEach(function (a) { a.stop(); });
    anims = [];
  }

  // Spring the sheet to y, carrying the given speed; closing also hides it at the end
  function settle(y, velocity, closing) {
    stopAnims();
    const opts = Object.assign({}, fluid.SPRING.momentum, { velocity: velocity || 0 });
    sheet.style.willChange = "transform";
    anims = [
      fluid.springTo(values.y, y, opts),
      fluid.springTo(scrimValues.opacity, closing ? 0 : 1, opts)
    ];
    const mine = anims;
    return Promise.all(mine).then(function () {
      if (anims !== mine) return;          // something else took over meanwhile
      sheet.style.willChange = "";
      if (closing) { sheet.hidden = true; scrim.hidden = true; values.y.jump(0); }
    });
  }

  function show() {
    if (open) return;
    open = true;
    lastFocus = document.activeElement;
    document.body.classList.add("sheet-open");
    scrim.hidden = false;
    sheet.hidden = false;
    sheet.scrollTop = 0;
    if (fluid.reduced()) {
      // Less motion: a plain fade, no slide
      values.y.jump(0);
      scrimValues.opacity.jump(0);
      fluid.springTo(scrimValues.opacity, 1);
      fluid.show(sheet);
    } else {
      // Only start from the bottom if it isn't already on its way somewhere
      if (!values.y.isAnimating() && values.y.get() === 0) {
        values.y.jump(closedY());
        scrimValues.opacity.jump(0);
      }
      settle(0, 0, false);
    }
    sheet.focus({ preventScroll: true });
  }

  function hide(velocity) {
    if (!open) return;
    open = false;
    document.body.classList.remove("sheet-open");
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    if (fluid.reduced()) {
      fluid.springTo(scrimValues.opacity, 0);
      fluid.hide(sheet).then(function () { scrim.hidden = true; });
    } else {
      settle(closedY(), velocity || 0, true);
    }
    if (options.onClose) options.onClose();
  }

  // Tapping the dim area or pressing Escape closes it
  scrim.addEventListener("click", function () { hide(); });
  sheet.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); hide(); }
  });

  // Dragging it down
  let dragBase = 0;       // where the sheet was when the finger landed
  let dragIgnored = false;
  fluid.pointerDrag(sheet, {
    axis: "y",
    canStart: function (e) {
      // Typing or picking in a field is not a drag
      return !e.target.closest("input, select, textarea");
    },
    onStart: function (info) {
      // If the form is scrolled, or you push up on a form that can scroll, that's
      // scrolling, not dragging. (A short form pushed up just rubber-bands.)
      const body = sheet.querySelector(".sheet-body") || sheet;
      const canScroll = body.scrollHeight > body.clientHeight + 1;
      dragIgnored = body.scrollTop > 0 || (info.dy < 0 && canScroll);
      if (dragIgnored) return;
      stopAnims();
      dragBase = values.y.get();
      sheet.style.willChange = "transform";
    },
    onMove: function (info) {
      if (dragIgnored) return;
      let y = dragBase + info.dy;
      // Above its resting place: resist more and more (there's nothing up there)
      if (y < 0) y = fluid.rubberband(y, sheet.getBoundingClientRect().height);
      fluid.jump(values.y, y);
      fluid.jump(scrimValues.opacity, Math.max(0, 1 - y / closedY()));
    },
    onEnd: function (info) {
      if (dragIgnored) return;
      const y = values.y.get();
      const vy = info.vy;
      let close;
      if (Math.abs(vy) > 400) close = vy > 0;                   // a clear flick: its direction decides
      else close = fluid.nearest([0, closedY()], y + fluid.project(vy)) !== 0;   // otherwise: where would it stop?
      if (close) hide(vy);
      else settle(0, vy, false);
    }
  });

  return { show: show, hide: hide, isOpen: function () { return open; } };
}

// The sheet holds "steps": the six forms plus the exercise picker screens
// (Add to workout → Which muscles? → the exercises). Only one step shows at a time.
// sheetStack remembers the steps you came through, so ‹ takes you back one by one.
const steps = document.querySelectorAll("#sheet .sheet-step");
const forms = document.querySelectorAll("#sheet form.sheet-step");
let sheetStack = [];
let currentStep = null;

const formSheet = makeSheet(document.getElementById("sheet"), document.getElementById("sheet-scrim"), {
  onClose: function () {
    if (editing) stopEditing(true);     // dragged away mid-edit: cancel the edit
    sheetStack = [];
    renderCurrentWorkout();
    updateWeightButtons();
  }
});

// Steps can be shown two ways: in the bottom sheet (logging a sport or weight from
// the home, editing from History) or as full screens during a workout (the
// exercise picker and its forms). The step element is simply moved into whichever
// container is in use; its buttons keep working wherever it lives.
let stepMode = "sheet";          // "sheet" or "page"
const flowPage = document.getElementById("flow-page");

// Show one step. direction: 1 = going forward (slides in from the right),
// -1 = going back (from the left), 0 = the first step (just appears).
function showStep(stepId, direction) {
  const step = document.getElementById(stepId);
  const container = stepMode === "page" ? flowPage.querySelector(".flow-body")
                                        : document.querySelector("#sheet .sheet-body");
  if (step.parentNode !== container) container.appendChild(step);
  steps.forEach(function (s) { if (s !== step) s.hidden = true; });
  if (step.tagName === "FORM") resetForm(step);
  if (stepId === "pick-group") renderGroupSquares();
  currentStep = stepId;
  if (stepMode === "page") window.scrollTo(0, 0);
  else container.scrollTop = 0;
  if (direction) fluid.show(step, { x: 24 * direction }, { duration: 0.3 });
  else step.hidden = false;
}

// Open the sheet on a step, starting a fresh trail
function openForm(stepId) {
  stepMode = "sheet";
  sheetStack = [];
  showStep(stepId, 0);
  formSheet.show();
}

// Open a step as a full screen over the workout screen (slides in from the right)
function openFlow(stepId) {
  stepMode = "page";
  sheetStack = [];
  showStep(stepId, 0);
  workoutPage.hidden = true;
  window.scrollTo(0, 0);
  fluid.show(flowPage, { x: 40 }, { duration: 0.3 });
}

// Leave the flow screens: back to the workout screen, or to the Log home if the
// workout is over (finished or discarded)
function closeFlow() {
  flowPage.hidden = true;
  if (getActiveWorkout()) {
    fluid.show(workoutPage, { x: -40 }, { duration: 0.3 });
  } else {
    workoutPage.hidden = true;
    fluid.show(picker, { x: -40 }, { duration: 0.3 });
  }
  if (editing) stopEditing(true);
  renderCurrentWorkout();
  updateWeightButtons();
}

// Go one step deeper (remembering where we came from)
function goStep(stepId) {
  sheetStack.push(currentStep);
  showStep(stepId, 1);
}

// ‹ : back to the previous step, or close the sheet if this was the first
function sheetBack() {
  if (sheetStack.length) showStep(sheetStack.pop(), -1);
  else closeForms();
}

// After saving: back to where you picked from (so you can add the next one), or close
function afterSave() {
  if (sheetStack.length) sheetBack();
  else closeForms();
}

function closeForms() {
  if (stepMode === "page") closeFlow();
  else formSheet.hide();
}

// Squares inside a step that lead to another step
document.querySelectorAll(".sheet-step [data-step]").forEach(function (button) {
  button.addEventListener("click", function () { goStep(button.dataset.step); });
});

// Buttons on the workout screen that open a step as a full screen
document.querySelectorAll("[data-flow]").forEach(function (button) {
  button.addEventListener("click", function () { openFlow(button.dataset.flow); });
});

// The "Log a weigh-in" button in Progress › Weight opens the body weight form too
document.getElementById("weight-log-button").addEventListener("click", function () { openForm("form-bodyweight"); });

// The Body weight square on Log is only for today's first weigh-in; once it's logged,
// the button moves to Progress › Weight instead.
function updateWeightButtons() {
  const t = today();
  const logged = loadEntries().some(function (e) { return e.type === "bodyweight" && e.date === t; });
  document.querySelector('#type-picker [data-form="form-bodyweight"]').hidden = logged;
  document.getElementById("weight-log-button").hidden = !logged;
}

// ---------- Picking an exercise: six muscle groups, then the exercises ----------
const EXERCISE_GROUPS = [
  { name: "Chest", icon: "chest", exercises: ["Bench press", "Incline bench press", "Dumbbell press",
      "Incline dumbbell press", "Chest fly", "Cable crossover", "Push-up", "Dips"] },
  { name: "Back", icon: "back", exercises: ["Deadlift", "Pull-up", "Lat pulldown", "Barbell row",
      "Dumbbell row", "Seated row", "T-bar row", "Face pull"] },
  { name: "Arms", icon: "arms", exercises: ["Bicep curl", "Hammer curl", "Preacher curl", "Tricep pushdown",
      "Skull crusher", "Overhead tricep extension", "Shoulder press", "Lateral raise", "Rear delt fly"] },
  { name: "Legs", icon: "legs", exercises: ["Squat", "Front squat", "Leg press", "Romanian deadlift", "Lunge",
      "Bulgarian split squat", "Hip thrust", "Leg extension", "Leg curl", "Calf raise"] },
  { name: "Abs", icon: "abs", exercises: ["Plank", "Crunch", "Cable crunch", "Hanging leg raise",
      "Russian twist", "Ab wheel rollout", "Mountain climbers", "Dead bug"] },
  { name: "Other", icon: "stretch", exercises: ["Cat-cow", "World's greatest stretch", "90/90 hip stretch",
      "Hip flexor stretch", "Hamstring stretch", "Pigeon stretch", "Couch stretch", "Thoracic rotation",
      "Shoulder dislocates (band)", "Foam rolling"] }
];

function renderGroupSquares() {
  const grid = document.getElementById("group-grid");
  grid.innerHTML = "";
  EXERCISE_GROUPS.forEach(function (group) {
    grid.appendChild(makeSquare(group.icon, group.name, function () {
      renderExerciseSquares(group);
      goStep("pick-exercise");
    }, group.name));
  });
}

function renderExerciseSquares(group) {
  document.getElementById("pick-exercise-title").textContent = group.name;
  const grid = document.getElementById("exercise-grid");
  grid.innerHTML = "";
  let names = group.exercises.slice();
  // Names you typed yourself before (not in any list) show up under Other
  if (group.name === "Other") {
    const known = EXERCISE_GROUPS.reduce(function (all, g) { return all.concat(g.exercises); }, []);
    loadEntries().filter(function (e) { return e.type === "weights"; }).forEach(function (e) {
      if (!known.includes(e.exercise) && !names.includes(e.exercise)) names.push(e.exercise);
    });
  }
  names.forEach(function (name) {
    grid.appendChild(makeSquare(group.icon, name, function () { startExercise(name); }, group.name));
  });
  grid.appendChild(makeSquare("pencil", "Something else…", function () { startExercise(""); }));
}

// A square button: a line icon on a soft colour wash (one colour per muscle group), name under it
function makeSquare(iconName, label, onPick, groupName) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "type-btn square" + (groupName ? " g-" + groupName.toLowerCase() : "");
  const iconSpan = document.createElement("span");
  iconSpan.className = "square-icon";
  iconSpan.innerHTML = iconHTML(iconName);
  button.append(iconSpan, label);
  button.addEventListener("click", onPick);
  return button;
}

// Open the weights form for that exercise (empty name = type your own)
function startExercise(name) {
  goStep("form-weights");
  const f = document.getElementById("form-weights").elements;
  f.exercise.value = name;
  f.exercise.dispatchEvent(new Event("input"));   // shows "Last time: …" if you've done it
  if (!name) f.exercise.focus();
}

// A yes/no question for the two actions that can't be undone. Returns a promise
// that becomes true if you confirm. Replaces the browser's confirm() box.
const actionSheet = makeSheet(document.getElementById("action-sheet"), document.getElementById("action-scrim"), {
  onClose: function () { if (actionResolve) { actionResolve(false); actionResolve = null; } }
});
let actionResolve = null;

function askConfirm(title, message, confirmLabel, destructive) {
  document.getElementById("action-title").textContent = title;
  document.getElementById("action-message").textContent = message || "";
  const button = document.getElementById("action-confirm");
  button.textContent = confirmLabel;
  button.classList.toggle("danger", !!destructive);
  return new Promise(function (resolve) {
    actionResolve = resolve;
    actionSheet.show();
  });
}

document.getElementById("action-confirm").addEventListener("click", function () {
  const resolve = actionResolve;
  actionResolve = null;
  actionSheet.hide();
  if (resolve) resolve(true);
});
document.getElementById("action-cancel").addEventListener("click", function () { actionSheet.hide(); });

// Any button with data-form="..." opens that form
document.querySelectorAll("#log [data-form]").forEach(function (button) {
  button.addEventListener("click", function () { openForm(button.dataset.form); });
});

// Every "← Back" button returns to the type buttons (or to History, when editing)
document.querySelectorAll(".back").forEach(function (button) {
  button.addEventListener("click", function () {
    if (editing) stopEditing(true);
    else sheetBack();
  });
});


// ---------- Editing an entry from History ----------
// Tapping an entry in History opens the form it was logged with, filled in.
// "editing" remembers which entry it is, so saving replaces it instead of adding a new one.

let editing = null;

const FORM_FOR = {
  weights: "form-weights", cardio: "form-cardio", sports: "form-sports",
  bodyweight: "form-bodyweight", workout: "form-finish", wake: "form-wake"
};
const EDIT_TITLES = {
  weights: "Edit exercise", cardio: "Edit cardio", sports: "Edit sport",
  bodyweight: "Edit body weight", workout: "Edit workout", wake: "Edit wake-up time"
};

function editEntry(e) {
  if (!FORM_FOR[e.type]) return;
  editing = e;
  const form = document.getElementById(FORM_FOR[e.type]);
  openForm(form.id);
  fillForm(form, e);

  // "Edit …" title and "Save changes" button (remembering the normal text)
  const title = form.querySelector("h2");
  const save = form.querySelector('button[type="submit"]');
  title.dataset.normal = title.dataset.normal || title.textContent;
  save.dataset.normal = save.dataset.normal || save.textContent;
  title.textContent = EDIT_TITLES[e.type];
  save.textContent = "Save changes";
  document.getElementById("discard-workout").hidden = true;
}

// Leave editing mode. The sheet closes over the list you came from, which
// is refreshed so the change shows straight away.
function stopEditing(refreshHistory) {
  editing = null;
  document.querySelectorAll("#sheet form h2[data-normal]").forEach(function (h) { h.textContent = h.dataset.normal; });
  document.querySelectorAll('#sheet form button[type="submit"][data-normal]').forEach(function (b) {
    b.textContent = b.dataset.normal;
  });
  document.getElementById("discard-workout").hidden = false;
  closeForms();
  if (refreshHistory) renderHistory();
}

// Save the edited version: same id, owner and creation time; everything else from the form
function saveEdit(changes, message) {
  const kept = { id: editing.id, user: editing.user, createdAt: editing.createdAt };
  if (editing.workoutId) kept.workoutId = editing.workoutId;
  recordChange({ op: "add", entry: Object.assign({ type: editing.type }, changes, kept) });
  showToast(message || "Changes saved ✓");
  stopEditing(true);
}

// Put an entry's values into its form
function fillForm(form, e) {
  const f = form.elements;
  if (f.date && e.date) f.date.value = e.date;
  if (f.time) f.time.value = entryTime(e);
  if (f.notes) f.notes.value = e.notes || "";

  if (e.type === "weights") {
    f.exercise.value = e.exercise;
    f.unit.value = e.unit;
    setsBox.innerHTML = "";
    e.sets.forEach(function (s) { addSetRow(s.reps, s.weight); });
  }
  if (e.type === "cardio") {
    const known = Array.from(f.activity.options).some(function (o) { return o.value === e.activity; });
    f.activity.value = known ? e.activity : "Other";
    f.otherName.value = known ? "" : e.activity;
    updateCardioFields();
    f.minutes.value = e.minutes;
    ["speed", "incline", "level", "floors"].forEach(function (name) {
      f[name].value = e[name] !== undefined ? e[name] : "";
    });
    if (e.speedUnit) f.speedUnit.value = e.speedUnit;
    f.rails.checked = !!e.rails;
  }
  if (e.type === "sports") {
    f.sport.value = e.sport;
    f.minutes.value = e.minutes;
    updateGolfFields();
    f.temperature.value = e.temperature !== undefined ? e.temperature : "";
    if (e.tempUnit) f.tempUnit.value = e.tempUnit;
    f.score.value = e.score !== undefined ? e.score : "";
  }
  if (e.type === "bodyweight") {
    f.weight.value = e.weight;
    f.unit.value = e.unit;
    f.notMorning.checked = !e.morning;
    f.peed.checked = !!e.peed;
    f.pooped.checked = !!e.pooped;
  }
  if (e.type === "workout") {
    f.minutes.value = e.minutes;
    f.effort.value = e.effort || "easy";
    document.getElementById("finish-hint").textContent = "";
  }
}

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
    updateLastWeights();
  }
  if (form.id === "form-cardio") {
    f.speedUnit.value = getPref("speedUnit", "km/h");
    // Start on the activity you did most recently
    const lastCardio = lastEntry(function (e) { return e.type === "cardio"; });
    if (lastCardio && !editing) {
      const known = Array.from(f.activity.options).some(function (o) { return o.value === lastCardio.activity; });
      f.activity.value = known ? lastCardio.activity : "Other";
      if (!known) f.otherName.value = lastCardio.activity;
    }
    updateCardioFields();
    updateLastCardio();
  }
  if (form.id === "form-sports") {
    f.tempUnit.value = getPref("tempUnit", "°C");
    fillSuggestions("sport-list", COMMON_SPORTS, "sports", "sport");
    updateGolfFields();
    updateLastSport();
  }
  if (form.id === "form-finish" && !editing) {
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
  openWorkoutPage();
});

// ---------- The workout screen ----------
// Starting (or continuing) a workout opens its own screen, which slides in from
// the right like a new page. ‹ slides back to the Log home; the workout keeps
// running and the home shows a "Workout in progress" banner to return to it.
const picker = document.getElementById("type-picker");
const workoutPage = document.getElementById("workout-page");

function openWorkoutPage() {
  if (!workoutPage.hidden) return;
  picker.hidden = true;
  window.scrollTo(0, 0);
  fluid.show(workoutPage, { x: 40 }, { duration: 0.3 });
}

function closeWorkoutPage() {
  if (workoutPage.hidden) return;
  workoutPage.hidden = true;
  fluid.show(picker, { x: -40 }, { duration: 0.3 });
}

document.getElementById("current-workout").addEventListener("click", openWorkoutPage);
document.getElementById("workout-back").addEventListener("click", closeWorkoutPage);

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
  const text = h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  document.querySelectorAll(".workout-timer").forEach(function (el) { el.textContent = text; });
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
  const banner = document.getElementById("current-workout");
  document.getElementById("no-workout").hidden = !!workout;
  banner.hidden = !workout;
  if (!workout) { closeWorkoutPage(); return; }   // finished or discarded: back to the Log home
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
    text.append(icon(ICONS[e.type]), " " + describe(e));
    const remove = document.createElement("button");
    remove.className = "delete";
    remove.title = "Remove";
    remove.setAttribute("aria-label", "Remove " + describe(e));
    remove.textContent = "×";
    const removeIt = function () { deleteWithUndo([e], "exercise", renderCurrentWorkout); };
    remove.addEventListener("click", removeIt);
    item.append(text, remove);
    swipeRow(item, "Remove", removeIt);
    list.appendChild(item);
  });
}

document.getElementById("form-finish").addEventListener("submit", function (event) {
  event.preventDefault();
  const f = event.target.elements;

  // Editing a saved workout: update it, and move its exercises if the date changed
  if (editing) {
    loadEntries().forEach(function (e) {
      if (e.workoutId === editing.id && e.date !== f.date.value) updateEntry(e.id, { date: f.date.value });
    });
    saveEdit({ date: f.date.value, time: f.time.value, minutes: Number(f.minutes.value),
               effort: f.effort.value, notes: f.notes.value.trim() });
    return;
  }

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
    effort: f.effort.value,          // easy / moderate / hard, for the calorie estimate
    notes: f.notes.value.trim()
  });
  setActiveWorkout(null);
  showToast("Workout saved ✓");
  closeForms();
});

document.getElementById("discard-workout").addEventListener("click", function () {
  const count = currentWorkoutEntries().length;
  askConfirm("Discard this workout?",
             count ? "Its " + count + " exercise" + (count === 1 ? "" : "s") + " will be deleted too." : "",
             "Discard workout", true).then(function (ok) {
    if (!ok) return;
    currentWorkoutEntries().forEach(function (e) { deleteEntry(e.id); });
    setActiveWorkout(null);
    closeForms();
  });
});


// =====================================================
//  5. SUGGESTIONS (exercise and sport names)
//  Common names, plus any you've typed before.
// =====================================================

// Every exercise from the six groups, for the suggestions list when you type a name
const COMMON_EXERCISES = EXERCISE_GROUPS.reduce(function (all, g) { return all.concat(g.exercises); }, []);

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

  // New rows appear with a small rise (unless the form is being filled in all at once)
  row.hidden = true;
  setsBox.appendChild(row);
  fluid.show(row, { y: 8 }, { duration: 0.25 });
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
//  6b. "SAME AS LAST TIME"
//  When you pick something you've done before, show what you did last time
//  with a button that fills the form in one tap.
// =====================================================

// Your most recent entry that matches
function lastEntry(match) {
  return loadEntries().filter(match).sort(function (a, b) {
    return (b.date + entryTime(b) + b.createdAt).localeCompare(a.date + entryTime(a) + a.createdAt);
  })[0];
}

// Show (or hide) the "Last time: … [Use these]" bar of a form
function showLastTime(kind, entry, text, useIt) {
  const box = document.querySelector('.last-time[data-for="' + kind + '"]');
  if (!entry || editing) { fluid.hide(box, { y: -6 }); return; }
  fluid.show(box, { y: -6 }, { duration: 0.25 });
  box.innerHTML = "";
  const what = document.createElement("span");
  what.textContent = "Last time (" + dayLabel(entry.date).replace(/, \d{4}$/, "") + "): " + text;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "use-button";
  button.textContent = "Use these";
  button.addEventListener("click", function () {
    useIt();
    showToast("Filled in from last time ✓");
  });
  box.append(what, button);
}

function updateLastWeights() {
  const f = document.getElementById("form-weights").elements;
  const name = f.exercise.value.trim().toLowerCase();
  const last = name && lastEntry(function (e) {
    return e.type === "weights" && e.exercise.trim().toLowerCase() === name;
  });
  showLastTime("weights", last, last ? last.sets.map(function (s) { return s.reps + "×" + s.weight; }).join(", ") +
    " " + last.unit : "", function () {
    f.unit.value = last.unit;
    setsBox.innerHTML = "";
    last.sets.forEach(function (s) { addSetRow(s.reps, s.weight); });
  });
}

function updateLastCardio() {
  const f = cardioForm.elements;
  const activity = f.activity.value === "Other" ? f.otherName.value.trim() : f.activity.value;
  const last = activity && lastEntry(function (e) { return e.type === "cardio" && e.activity === activity; });
  showLastTime("cardio", last, last ? describe(last).replace(/^.*? — /, "") : "", function () {
    f.minutes.value = last.minutes;
    ["speed", "incline", "level", "floors"].forEach(function (name) {
      f[name].value = last[name] !== undefined ? last[name] : "";
    });
    if (last.speedUnit) f.speedUnit.value = last.speedUnit;
    f.rails.checked = !!last.rails;
  });
}

function updateLastSport() {
  const f = sportsForm.elements;
  const sport = f.sport.value.trim().toLowerCase();
  const last = sport && lastEntry(function (e) { return e.type === "sports" && e.sport.trim().toLowerCase() === sport; });
  showLastTime("sports", last, last ? last.minutes + " min" : "", function () {
    f.minutes.value = last.minutes;
  });
}

document.getElementById("form-weights").elements.exercise.addEventListener("input", updateLastWeights);


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
cardioForm.elements.activity.addEventListener("change", updateLastCardio);
cardioForm.elements.otherName.addEventListener("input", updateLastCardio);

const sportsForm = document.getElementById("form-sports");

function updateGolfFields() {
  const sport = sportsForm.elements.sport.value.trim().toLowerCase();
  document.getElementById("golf-fields").hidden = sport !== "golf";
}
sportsForm.elements.sport.addEventListener("input", updateGolfFields);
sportsForm.elements.sport.addEventListener("input", updateLastSport);


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
  if (editing) {
    saveEdit({ date: editing.date, time: entryTime(editing), exercise: exercise, unit: f.unit.value,
               sets: sets, notes: f.notes.value.trim() });
    return;
  }
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

  // Back to the list of exercises, ready for the next one
  afterSave();
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

  const entry = {
    type: "cardio",
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
  if (isVisible(f.rails) && f.rails.checked) entry.rails = true;

  if (editing) {
    saveEdit(Object.assign(entry, { date: editing.date, time: entryTime(editing) }));
    return;
  }
  // A new exercise belongs to the running workout
  const workout = getActiveWorkout();
  entry.date = workout.date;
  entry.time = timeOf();
  entry.workoutId = workout.id;
  addEntry(entry);
  showToast("Added " + activity + " ✓");
  afterSave();
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

  if (editing) { saveEdit(entry); return; }
  addEntry(entry);
  showToast("Saved " + entry.sport + " ✓");
  closeForms();
});

document.getElementById("form-bodyweight").addEventListener("submit", function (event) {
  event.preventDefault();
  const f = event.target.elements;

  const entry = {
    type: "bodyweight",
    date: f.date.value,
    time: f.time.value,
    weight: Number(f.weight.value),
    unit: f.unit.value,
    morning: !f.notMorning.checked,
    peed: f.peed.checked,
    pooped: f.pooped.checked
  };
  setPref("weightUnit", f.unit.value);
  if (editing) { saveEdit(entry); return; }
  addEntry(entry);
  showToast("Saved weight ✓");
  closeForms();
});

// Only used for editing a wake-up time from History
document.getElementById("form-wake").addEventListener("submit", function (event) {
  event.preventDefault();
  const f = event.target.elements;
  if (!editing) return;
  // The id holds the date ("wake-2026-10-20"), so a new date means a new entry
  if (f.date.value !== editing.date) {
    deleteEntry(editing.id);
    addEntry({ id: "wake-" + f.date.value, type: "wake", date: f.date.value, time: f.time.value });
    showToast("Changes saved ✓");
    stopEditing(true);
    return;
  }
  saveEdit({ date: f.date.value, time: f.time.value });
});


// =====================================================
//  9. HISTORY LIST
// =====================================================

// Which line icon (icons.js) goes with each kind of entry
const ICONS = { workout: "dumbbell", weights: "dumbbell", cardio: "run", sports: "ball", bodyweight: "scale", wake: "sun" };

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
    if (e.rails) parts.push("held rails");
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
  if (e.type === "wake") return "Woke up";
  return "";
}

// A workout's weights totals: how many sets, and the volume (reps × weight, all added up)
// in your usual unit, e.g. { sets: 9, volume: 4320, unit: "kg" }
function workoutTotals(workoutId) {
  const unit = getPref("weightUnit", "kg");
  let sets = 0, volume = 0;
  loadEntries().forEach(function (e) {
    if (e.workoutId !== workoutId || e.type !== "weights") return;
    e.sets.forEach(function (s) {
      sets++;
      let w = s.weight;
      if (e.unit !== unit) w = unit === "kg" ? w / LB_PER_KG : w * LB_PER_KG;
      volume += s.reps * w;
    });
  });
  return { sets: sets, volume: Math.round(volume), unit: unit };
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
    if (e.type === "profile") return false;     // your profile isn't a log
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
      // The day's estimated total (today: so far)
      const day = dayCalories(e.date, e.date === today() ? nowMinutes() : 1440);
      if (day) {
        const total = document.createElement("span");
        total.className = "kcal";
        total.textContent = " · ≈ " + kcalText(day.total) + " kcal burned" + (e.date === today() ? " so far" : "");
        heading.appendChild(total);
      }
      list.appendChild(heading);
      previousDate = e.date;
    }

    const item = document.createElement("li");
    item.className = "entry";

    const text = document.createElement("div");
    const title = document.createElement("div");
    title.append(icon(ICONS[e.type]), " " + describe(e));
    // Estimated extra calories for exercise entries
    const kg = weightKgOn(e.date);
    const burned = kg && restingPerDay(e.date) ? entryKcal(e, kg) : 0;
    const kcalLabel = document.createElement("span");
    kcalLabel.className = "kcal";
    if (burned > 0) kcalLabel.textContent = " · ≈ " + kcalText(burned) + " kcal";
    const details = document.createElement("div");
    details.className = "hint small";
    details.textContent = formatTime(entryTime(e)) + (e.notes ? " · " + e.notes : "");
    text.append(title, details);

    // A workout lists its exercises underneath
    const children = e.type === "workout" ? exercisesOf(e.id) : [];
    if (e.type === "workout") {
      title.textContent += " · " + children.length + (children.length === 1 ? " exercise" : " exercises");
      if (e.effort) title.textContent += " · " + e.effort;
      // Totals line: sets and volume lifted
      const totals = workoutTotals(e.id);
      if (totals.sets > 0) {
        const totalsLine = document.createElement("div");
        totalsLine.className = "hint small";
        totalsLine.textContent = totals.sets + (totals.sets === 1 ? " set" : " sets") +
          (totals.volume > 0 ? " · " + totals.volume.toLocaleString("en-US") + " " + totals.unit + " lifted" : "");
        text.appendChild(totalsLine);
      }
      const sub = document.createElement("ul");
      sub.className = "sub-list";
      children.sort(function (a, b) { return entryTime(a).localeCompare(entryTime(b)); });
      children.forEach(function (c) {
        const line = document.createElement("li");
        line.append(icon(ICONS[c.type]), " " + describe(c) + " · " + formatTime(entryTime(c)));
        // Tapping one exercise edits just that exercise
        line.className = "tappable";
        line.addEventListener("click", function (event) {
          event.stopPropagation();
          editEntry(c);
        });
        sub.appendChild(line);
      });
      text.appendChild(sub);
    }
    title.appendChild(kcalLabel);

    const remove = document.createElement("button");
    remove.className = "delete";
    remove.title = "Delete";
    remove.setAttribute("aria-label", "Delete " + describe(e));
    remove.textContent = "×";
    // A workout takes its exercises with it; Undo brings them all back
    const what = e.type === "workout" ? "workout" : "entry";
    const removeIt = function () { deleteWithUndo(children.concat([e]), what, renderHistory); };
    remove.addEventListener("click", function (event) { event.stopPropagation(); removeIt(); });

    // Tapping the entry (anywhere but ×) opens it for editing
    item.classList.add("tappable");
    item.addEventListener("click", function (event) {
      if (!event.target.closest(".delete")) editEntry(e);
    });

    item.append(text, remove);
    swipeRow(item, "Delete", removeIt);
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
    weeks[week].push(e);
  });
  return Object.keys(weeks).sort().map(function (week) {
    const list = weeks[week];
    const total = list.reduce(function (sum, e) { return sum + weightIn(e, unit); }, 0);
    return { week: week, average: round1(total / list.length), count: list.length, weighIns: list };
  });
}

// A note about the toilet before weigh-ins, e.g. "3 after pee · 1 after pee & poop · 3 with neither"
// (weigh-ins from before these questions existed are counted as "not noted")
function toiletSummary(weighIns) {
  const counts = { pee: 0, both: 0, poop: 0, neither: 0, unknown: 0 };
  weighIns.forEach(function (e) {
    if (e.peed === undefined && e.pooped === undefined) counts.unknown++;
    else if (e.peed && e.pooped) counts.both++;
    else if (e.peed) counts.pee++;
    else if (e.pooped) counts.poop++;
    else counts.neither++;
  });
  return [
    [counts.pee, "after pee"], [counts.both, "after pee & poop"], [counts.poop, "after poop"],
    [counts.neither, "with neither"], [counts.unknown, "not noted"]
  ].filter(function (c) { return c[0] > 0; }).map(function (c) { return c[0] + " " + c[1]; }).join(" · ");
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
  updateWeightButtons();
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
    ? thisWeek.count + (thisWeek.count === 1 ? " morning weigh-in" : " morning weigh-ins") +
      ": " + toiletSummary(thisWeek.weighIns)
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

    // A small notes line under each week: how the weigh-ins were done
    const notes = document.createElement("tr");
    notes.className = "week-notes";
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = toiletSummary(w.weighIns);
    notes.appendChild(cell);
    tbody.appendChild(notes);
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
//  9e. PROGRESS TAB: switching between Week / Weight / Strength
// =====================================================

let progressView = getPref("progressView", "view-week");
if (!document.getElementById(progressView)) progressView = "view-week";

document.querySelectorAll("#progress-views button").forEach(function (button) {
  button.addEventListener("click", function () {
    progressView = button.dataset.view;
    setPref("progressView", progressView);
    renderProgress();
  });
});

function renderProgress() {
  const buttons = document.querySelectorAll("#progress-views button");
  let chosen = null;
  buttons.forEach(function (b) {
    const active = b.dataset.view === progressView;
    b.classList.toggle("active", active);
    if (active) chosen = b;
  });
  // The pill springs behind the chosen view (from wherever it is right now)
  const indicator = document.querySelector(".seg-indicator");
  const x = chosen.offsetLeft - buttons[0].offsetLeft;
  const wasOff = indicator.dataset.placed !== "1";
  indicator.dataset.placed = "1";
  if (wasOff || document.getElementById("weight").hidden) fluid.jump(fluid.valuesOf(indicator).x, x);
  else fluid.springTo(fluid.valuesOf(indicator).x, x);

  document.querySelectorAll(".progress-view").forEach(function (v) {
    if (v.id === progressView) { if (v.hidden) fluid.show(v, { y: 8 }, { duration: 0.25 }); }
    else v.hidden = true;
  });
  if (progressView === "view-week") renderWeekSummary();
  if (progressView === "view-weight") renderWeight();
  if (progressView === "view-strength") renderStrength();
}

// Chart.js might not have loaded (no internet); then charts are skipped
function chartColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    accent: css.getPropertyValue("--accent").trim(),
    muted: css.getPropertyValue("--muted").trim(),
    border: css.getPropertyValue("--border").trim(),
    card: css.getPropertyValue("--card").trim()
  };
}

// A weight in your usual unit
function inUnit(weight, fromUnit, unit) {
  if (fromUnit === unit) return weight;
  return unit === "kg" ? weight / LB_PER_KG : weight * LB_PER_KG;
}

// A small number tile: label, big value, little note
function statTile(label, value, note) {
  const tile = document.createElement("div");
  tile.className = "stat";
  [["stat-label", label], ["stat-value", value], ["stat-note", note || ""]].forEach(function (part) {
    const div = document.createElement("div");
    div.className = part[0];
    div.textContent = part[1];
    tile.appendChild(div);
  });
  return tile;
}


// ---------- Strength: progress for one exercise ----------

// Estimated one-rep max (Epley formula): what you could probably lift once
function oneRepMax(reps, weight) {
  return reps <= 1 ? weight : weight * (1 + reps / 30);
}

let strengthChart;

document.getElementById("strength-exercise").addEventListener("change", function (event) {
  setPref("strengthExercise", event.target.value);
  renderStrength();
});

function renderStrength() {
  const unit = getPref("weightUnit", "kg");
  const logs = loadEntries().filter(function (e) { return e.type === "weights" && e.sets && e.sets.length; });
  document.getElementById("strength-empty").hidden = logs.length > 0;
  document.getElementById("strength-content").hidden = logs.length === 0;
  if (logs.length === 0) return;

  // The exercise list, most recently done first (names compared without caring about capitals)
  const latest = {};
  logs.forEach(function (e) {
    const key = e.exercise.trim().toLowerCase();
    const stamp = e.date + entryTime(e);
    const name = e.exercise.trim().charAt(0).toUpperCase() + e.exercise.trim().slice(1);
    if (!latest[key] || stamp > latest[key].stamp) latest[key] = { name: name, stamp: stamp };
  });
  const keys = Object.keys(latest).sort(function (a, b) { return latest[b].stamp.localeCompare(latest[a].stamp); });
  const select = document.getElementById("strength-exercise");
  select.innerHTML = "";
  keys.forEach(function (key) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = latest[key].name;
    select.appendChild(option);
  });
  const chosen = keys.includes(getPref("strengthExercise", "")) ? getPref("strengthExercise", "") : keys[0];
  select.value = chosen;

  // One session per day: all the sets of that exercise that day
  const byDay = {};
  logs.filter(function (e) { return e.exercise.trim().toLowerCase() === chosen; }).forEach(function (e) {
    byDay[e.date] = byDay[e.date] || [];
    e.sets.forEach(function (s) {
      byDay[e.date].push({ reps: s.reps, weight: round1(inUnit(s.weight, e.unit, unit)) });
    });
  });
  const days = Object.keys(byDay).sort();
  // Body-weight exercises (all weights 0): track the most reps instead
  const repsOnly = days.every(function (d) { return byDay[d].every(function (s) { return !s.weight; }); });

  const sessions = days.map(function (d) {
    const sets = byDay[d];
    const best = sets.reduce(function (top, s) {
      const score = repsOnly ? s.reps : oneRepMax(s.reps, s.weight);
      return score > top.score ? { score: score, set: s } : top;
    }, { score: 0, set: sets[0] });
    return { date: d, sets: sets, best: round1(best.score), bestSet: best.set };
  });

  // The number tiles
  const stats = document.getElementById("strength-stats");
  stats.innerHTML = "";
  const top = sessions.reduce(function (a, b) { return b.best >= a.best ? b : a; });
  const last = sessions[sessions.length - 1];
  const before = sessions[sessions.length - 2];
  const unitLabel = repsOnly ? " reps" : " " + unit;
  stats.appendChild(statTile(repsOnly ? "Most reps" : "Best est. max", top.best + unitLabel, formatDate(top.date)));
  if (before) {
    const change = round1(last.best - before.best);
    stats.appendChild(statTile("Last session", last.best + unitLabel,
      (change > 0 ? "▲ " + change : change < 0 ? "▼ " + Math.abs(change) : "same as") + " vs the time before"));
  } else {
    stats.appendChild(statTile("Sessions", "1", "Log it again to see your progress"));
  }

  // The chart: best of each session over time
  const box = document.getElementById("chart-strength");
  if (strengthChart) strengthChart.destroy();
  if (typeof Chart !== "undefined") {
    const colors = chartColors();
    strengthChart = new Chart(box, {
      type: "line",
      data: { datasets: [{
        label: repsOnly ? "Most reps" : "Estimated max",
        data: sessions.map(function (s) { return { x: new Date(s.date + "T00:00").getTime(), y: s.best, date: s.date }; }),
        borderColor: colors.accent, backgroundColor: colors.accent, borderWidth: 2,
        pointRadius: 4, pointHoverRadius: 6, tension: 0
      }]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: function (items) { return formatDate(items[0].raw.date); },
            label: function (item) { return item.dataset.label + ": " + item.raw.y + unitLabel; }
          }}
        },
        scales: {
          x: { type: "linear", grid: { display: false }, ticks: { color: colors.muted, maxTicksLimit: 5,
               callback: function (v) { return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } } },
          y: { grid: { color: colors.border }, ticks: { color: colors.muted, maxTicksLimit: 5 } }
        }
      }
    });
  }

  // The sessions list, newest first
  const list = document.getElementById("strength-sessions");
  list.innerHTML = "";
  sessions.slice().reverse().forEach(function (s) {
    const item = document.createElement("li");
    const day = document.createElement("strong");
    day.textContent = formatDate(s.date);
    item.appendChild(day);
    item.appendChild(document.createTextNode(" · " + s.sets.map(function (set) {
      return set.reps + "×" + set.weight;
    }).join(", ") + (repsOnly ? "" : " " + unit + " · est. max " + s.best + " " + unit)));
    list.appendChild(item);
  });
}


// ---------- Week: the weekly summary ----------

let weekOffset = 0;        // 0 = this week, -1 = last week, …
let weekChart;

// Move to another week. The panel slides out the way you went and the new week
// slides in from the other side, continuing at the speed of your swipe.
const weekPanel = document.getElementById("view-week");
const weekX = fluid.valuesOf(weekPanel).x;
const weekOpacity = fluid.valuesOf(weekPanel).opacity;

function goWeek(delta, velocity) {
  if (delta === 0 || weekOffset + delta > 0) { fluid.springTo(weekX, 0, { velocity: velocity || 0 }); return; }
  weekOffset += delta;
  if (fluid.reduced()) { renderWeekSummary(); return; }
  const width = weekPanel.getBoundingClientRect().width;
  const out = delta < 0 ? width : -width;      // previous week: content leaves to the right
  weekPanel.style.willChange = "transform, opacity";
  Promise.all([
    fluid.springTo(weekX, out, Object.assign({}, fluid.SPRING.momentum, { velocity: velocity || 0 })),
    fluid.springTo(weekOpacity, 0, { duration: 0.2 })
  ]).then(function () {
    renderWeekSummary();
    fluid.jump(weekX, -out * 0.35);              // the new week comes in from the other side
    return Promise.all([fluid.springTo(weekX, 0), fluid.springTo(weekOpacity, 1)]);
  }).then(function () { weekPanel.style.willChange = ""; });
}

document.getElementById("week-prev").addEventListener("click", function () { goWeek(-1); });
document.getElementById("week-next").addEventListener("click", function () { goWeek(1); });

// Swiping the week panel: it follows the finger; at "this week" it only
// rubber-bands to the left (there is no next week yet).
let weekDragBase = 0;
fluid.pointerDrag(weekPanel, {
  axis: "x",
  canStart: function (e) { return !e.target.closest("button, canvas"); },
  onStart: function () {
    weekX.stop();
    weekDragBase = weekX.get();
    weekPanel.style.willChange = "transform";
  },
  onMove: function (info) {
    let x = weekDragBase + info.dx;
    const width = weekPanel.getBoundingClientRect().width;
    if (weekOffset === 0 && x < 0) x = fluid.rubberband(x, width);
    fluid.jump(weekX, x);
  },
  onEnd: function (info) {
    weekPanel.style.willChange = "";
    const width = weekPanel.getBoundingClientRect().width;
    const landing = weekX.get() + fluid.project(info.vx);
    let delta = 0;
    if (Math.abs(info.vx) > 400) delta = info.vx > 0 ? -1 : 1;             // a flick: its direction
    else if (Math.abs(landing) > width / 3) delta = landing > 0 ? -1 : 1;   // a long pull: where it would land
    goWeek(delta, info.vx);
  }
});

// "07:10" average of a list of times
function averageTime(times) {
  if (!times.length) return "";
  const avg = Math.round(times.reduce(function (sum, t) { return sum + minutesOf(t); }, 0) / times.length);
  return String(Math.floor(avg / 60)).padStart(2, "0") + ":" + String(avg % 60).padStart(2, "0");
}

function renderWeekSummary() {
  const unit = getPref("weightUnit", "kg");
  const monday = shiftDate(weekStart(today()), 7 * weekOffset);
  const days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return shiftDate(monday, i); });
  const sunday = days[6];

  document.getElementById("week-title").textContent = weekOffset === 0 ? "This week"
    : weekOffset === -1 ? "Last week"
    : new Date(monday + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " – " +
      new Date(sunday + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  document.getElementById("week-next").disabled = weekOffset === 0;

  const all = loadEntries();
  const inWeek = all.filter(function (e) { return e.date >= monday && e.date <= sunday; });
  const workouts = inWeek.filter(function (e) { return e.type === "workout"; });
  const sports = inWeek.filter(function (e) { return e.type === "sports"; });
  const loneCardio = inWeek.filter(function (e) { return e.type === "cardio" && !e.workoutId; });
  const exerciseMinutes = workouts.concat(sports, loneCardio).reduce(function (sum, e) { return sum + e.minutes; }, 0);

  let sets = 0, volume = 0;
  workouts.forEach(function (w) {
    const t = workoutTotals(w.id);
    sets += t.sets;
    volume += t.volume;
  });

  // Calories each day (today only up to now; future days have none yet)
  const perDay = days.map(function (d) {
    if (d > today()) return null;
    return dayCalories(d, d === today() ? nowMinutes() : 1440);
  });
  const known = perDay.filter(Boolean);
  const fullDays = perDay.filter(function (c, i) { return c && days[i] !== today(); });
  const avgBurn = fullDays.length
    ? fullDays.reduce(function (s, c) { return s + c.total; }, 0) / fullDays.length : null;
  const exerciseKcal = known.reduce(function (s, c) { return s + c.exercise; }, 0);

  // Morning weight: this week's average vs the week before
  const morningIn = function (from, to) {
    return all.filter(function (e) { return e.type === "bodyweight" && e.morning && e.date >= from && e.date <= to; });
  };
  const morningAvg = function (from, to) {
    const list = morningIn(from, to);
    return list.length ? round1(list.reduce(function (s, e) { return s + inUnit(e.weight, e.unit, unit); }, 0) / list.length) : null;
  };
  const weightNow = morningAvg(monday, sunday);
  const weightBefore = morningAvg(shiftDate(monday, -7), shiftDate(monday, -1));
  const wakeTimes = inWeek.filter(function (e) { return e.type === "wake"; }).map(function (e) { return e.time; });

  const stats = document.getElementById("week-stats");
  stats.innerHTML = "";
  stats.appendChild(statTile("Workouts", String(workouts.length),
    sports.length ? "+ " + sports.length + (sports.length === 1 ? " sport session" : " sport sessions") : ""));
  const hours = Math.floor(exerciseMinutes / 60), mins = exerciseMinutes % 60;
  stats.appendChild(statTile("Exercise time",
    hours ? hours + " h" + (mins ? " " + mins + " min" : "") : mins + " min"));
  stats.appendChild(statTile("Avg burned / day", avgBurn ? "≈ " + kcalText(avgBurn) : "–",
    avgBurn ? "kcal, " + fullDays.length + (fullDays.length === 1 ? " full day" : " full days") : "needs profile + weigh-in"));
  stats.appendChild(statTile("From exercise", known.length ? "≈ " + kcalText(exerciseKcal) : "–", known.length ? "kcal this week" : ""));
  stats.appendChild(statTile("Weights", sets ? sets + " sets" : "–",
    volume ? volume.toLocaleString("en-US") + " " + unit + " lifted" : ""));
  const weightTile = statTile("Morning weight", weightNow ? weightNow + " " + unit : "–",
    weightNow && weightBefore ? (weightNow - weightBefore > 0 ? "+" : weightNow - weightBefore < 0 ? "−" : "") +
      Math.abs(round1(weightNow - weightBefore)) + " " + unit + " vs week before" : "weekly average");
  if (weightNow) {
    // How the weigh-ins were done (pee / poop notes)
    const toilet = document.createElement("div");
    toilet.className = "stat-note";
    toilet.textContent = toiletSummary(morningIn(monday, sunday));
    weightTile.appendChild(toilet);
  }
  stats.appendChild(weightTile);
  if (wakeTimes.length) {
    stats.appendChild(statTile("Avg wake-up", formatTime(averageTime(wakeTimes)),
      wakeTimes.length + (wakeTimes.length === 1 ? " day logged" : " days logged")));
  }

  // Bar chart of calories per day
  const box = document.getElementById("chart-week");
  if (weekChart) weekChart.destroy();
  box.closest(".chart-card").hidden = typeof Chart === "undefined" || !known.length;
  if (typeof Chart !== "undefined" && known.length) {
    const colors = chartColors();
    weekChart = new Chart(box, {
      type: "bar",
      data: {
        labels: days.map(function (d) { return new Date(d + "T00:00").toLocaleDateString("en-US", { weekday: "short" }); }),
        datasets: [{
          label: "kcal",
          data: perDay.map(function (c) { return c ? Math.round(c.total) : null; }),
          backgroundColor: days.map(function (d) { return d === today() ? colors.accent + "80" : colors.accent; }),
          borderRadius: 4, maxBarThickness: 28
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: function (item) { return "≈ " + kcalText(item.raw) + " kcal" + (days[item.dataIndex] === today() ? " so far" : ""); }
        }}},
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.muted } },
          y: { grid: { color: colors.border }, ticks: { color: colors.muted, maxTicksLimit: 4 } }
        }
      }
    });
  }

  // One line per day: what you did
  const list = document.getElementById("week-days");
  list.innerHTML = "";
  days.forEach(function (d, i) {
    if (d > today()) return;
    const bits = [];
    inWeek.forEach(function (e) {
      if (e.date !== d) return;
      if (e.type === "workout") bits.push("Workout " + e.minutes + " min");
      if (e.type === "sports") bits.push(e.sport);
      if (e.type === "cardio" && !e.workoutId) bits.push(e.activity);
      if (e.type === "bodyweight" && e.morning) bits.push(e.weight + " " + e.unit);
    });
    if (perDay[i]) bits.push(kcalText(perDay[i].total) + " kcal");
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = d === today() ? "Today"
      : new Date(d + "T00:00").toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
    const what = document.createElement("span");
    what.className = "day-what";
    what.textContent = bits.length ? bits.join(" · ") : "–";
    item.append(name, what);
    list.appendChild(item);
  });
}


// =====================================================
//  9c. CALORIES
//  Based on our research (reports/Calorie estimation for workout tracker.md):
//  - Resting burn (Mifflin-St Jeor formula), counted minute by minute from midnight
//  - Everyday movement: +20% of resting, only while awake and not exercising
//  - Exercise: only the EXTRA calories above resting ("net"), so nothing counts twice
//  Food digestion and "afterburn" are left out on purpose, to keep it conservative.
// =====================================================

// MET = how many times harder than sitting still. From the 2024 Compendium.
const WEIGHTS_MET = { easy: 3.5, moderate: 5.0, hard: 6.0 };

// Sports: the first name that appears in what you typed wins; anything else gets 5.0
const SPORT_METS = [
  ["padel", 6.0], ["pickleball", 4.5], ["tennis", 6.0], ["golf", 4.5],
  ["soccer", 7.0], ["football", 7.0], ["basketball", 6.0], ["volleyball", 4.0],
  ["swim", 5.8], ["cycl", 5.0], ["bik", 5.0]
];
const DEFAULT_MET = 5.0;

// Running speed (mph) -> MET, from the Compendium; in-between speeds are blended
const RUNNING_METS = [[4, 6.0], [5, 8.5], [6, 9.3], [7, 11.0], [8, 12.0], [9, 13.0], [10, 14.8]];

// Your saved profile (height, birth date, sex), or null
function getProfile() {
  return loadEntries().find(function (e) { return e.type === "profile"; }) || null;
}

// The wake-up entry for a day, or undefined
function wakeEntryFor(date) {
  return loadEntries().find(function (e) { return e.type === "wake" && e.date === date; });
}

// "07:30" -> 450 (minutes since midnight)
function minutesOf(timeText) {
  const parts = (timeText || "00:00").split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

// Your weight in kg on a day: the latest morning weigh-in up to that day
// (or any weigh-in, or failing that, the earliest one you have)
function weightKgOn(date) {
  const weighIns = loadEntries()
    .filter(function (e) { return e.type === "bodyweight"; })
    .sort(function (a, b) { return (a.date + entryTime(a)).localeCompare(b.date + entryTime(b)); });
  const upTo = weighIns.filter(function (e) { return e.date <= date; });
  const morningOnes = upTo.filter(function (e) { return e.morning; });
  const pick = morningOnes[morningOnes.length - 1] || upTo[upTo.length - 1] || weighIns[0];
  return pick ? weightIn(pick, "kg") : null;
}

// Age in whole years on a given date
function ageOn(birthDate, date) {
  const b = new Date(birthDate + "T00:00"), d = new Date(date + "T00:00");
  let age = d.getFullYear() - b.getFullYear();
  if (d < new Date(d.getFullYear(), b.getMonth(), b.getDate())) age--;
  return age;
}

// Resting burn for a whole day (kcal), or null if the profile or a weigh-in is missing
function restingPerDay(date) {
  const p = getProfile();
  const kg = weightKgOn(date);
  if (!p || !p.heightCm || !p.birthDate || !p.sex || !kg) return null;
  const formula = 10 * kg + 6.25 * p.heightCm - 5 * ageOn(p.birthDate, date) + (p.sex === "male" ? 5 : -161);
  // Personal calibration (e.g. from WHOOP data) scales resting burn, and with it everyday movement
  const factor = p.calibration && p.calibration.everyday ? p.calibration.everyday : 1;
  return formula * factor;
}

// Extra calories for doing something at a given MET for some minutes
function netKcal(met, minutes, kg) {
  return Math.max(0, met - 1) * (3.5 * kg / 200) * minutes;
}

// Extra calories for one cardio entry
function cardioKcal(e, kg) {
  const a = e.activity;
  const hasSpeed = e.speed !== undefined && e.speed > 0;
  const mph = hasSpeed ? (e.speedUnit === "mph" ? e.speed : e.speed / 1.609) : 0;
  const metersPerMin = mph * 26.8;
  const grade = Math.min(e.incline || 0, 15) / 100;   // steeper than 15% is capped (formulas overshoot)
  let kcal;

  if ((a === "Walking" || a === "Incline walking") && hasSpeed) {
    // ACSM walking formula: uses your real speed and incline
    kcal = (0.1 * metersPerMin + 1.8 * metersPerMin * grade) * kg / 200 * e.minutes;
  } else if (a === "Running" && hasSpeed) {
    // Compendium value for the speed, plus the extra cost of the incline
    let met = RUNNING_METS[0][1];
    RUNNING_METS.forEach(function (point, i) {
      const next = RUNNING_METS[i + 1];
      if (mph >= point[0]) met = next && mph < next[0]
        ? point[1] + (next[1] - point[1]) * (mph - point[0]) / (next[0] - point[0])
        : point[1];
    });
    met += 0.9 * metersPerMin * grade / 3.5;
    kcal = netKcal(met, e.minutes, kg);
  } else {
    let met = DEFAULT_MET;
    if (a === "Walking") met = 3.5;
    if (a === "Incline walking") met = 6.0;
    if (a === "Running") met = 8.0;
    if (a === "Stairmaster") met = !e.level ? 6.8 : e.level <= 4 ? 4.5 : e.level <= 8 ? 6.8 : 9.3;
    kcal = netKcal(met, e.minutes, kg);
  }
  return e.rails ? kcal * 0.8 : kcal;   // holding the handrails burns about 20% less
}

function sportKcal(e, kg) {
  const name = (e.sport || "").toLowerCase();
  // Your own values (from a calibration) come first, then the standard table
  const p = getProfile();
  const own = p && p.calibration && p.calibration.sportMets ? p.calibration.sportMets : {};
  const ownMatch = Object.keys(own).find(function (sport) { return name.includes(sport); });
  if (ownMatch) return netKcal(own[ownMatch], e.minutes, kg);
  const match = SPORT_METS.find(function (s) { return name.includes(s[0]); });
  return netKcal(match ? match[1] : DEFAULT_MET, e.minutes, kg);
}

// A workout: its cardio, plus weights for the rest of the minutes
function workoutKcal(workout, kg) {
  const parts = loadEntries().filter(function (e) { return e.workoutId === workout.id; });
  const cardio = parts.filter(function (e) { return e.type === "cardio"; });
  const hasWeights = parts.some(function (e) { return e.type === "weights"; });
  const cardioMinutes = cardio.reduce(function (sum, e) { return sum + e.minutes; }, 0);
  const weightsMinutes = hasWeights ? Math.max(0, workout.minutes - cardioMinutes) : 0;
  const met = WEIGHTS_MET[workout.effort] || WEIGHTS_MET.easy;   // older workouts: easy
  return cardio.reduce(function (sum, e) { return sum + cardioKcal(e, kg); }, 0) +
         netKcal(met, weightsMinutes, kg);
}

// Calories for any loggable entry (0 for things that aren't exercise)
function entryKcal(e, kg) {
  if (e.type === "workout") return workoutKcal(e, kg);
  if (e.type === "sports") return sportKcal(e, kg);
  if (e.type === "cardio") return cardioKcal(e, kg);
  return 0;
}

// A whole day (or today up to now): { resting, movement, exercise, total, wakeAssumed }
// upToMinutes = how many minutes of the day to count (1440 = the whole day)
function dayCalories(date, upToMinutes) {
  const resting = restingPerDay(date);
  if (resting === null) return null;
  const kg = weightKgOn(date);
  const perMinute = resting / 1440;

  let exercise = 0, exerciseMinutes = 0;
  loadEntries().forEach(function (e) {
    if (e.date !== date || minutesOf(entryTime(e)) > upToMinutes) return;
    const standaloneCardio = e.type === "cardio" && !e.workoutId;
    if (e.type === "workout" || e.type === "sports" || standaloneCardio) {
      exercise += entryKcal(e, kg);
      exerciseMinutes += e.minutes;
    }
  });

  // Awake time: from waking (7:00 if not logged) for at most 16 hours
  const wake = wakeEntryFor(date);
  const wakeMinutes = wake ? minutesOf(wake.time) : 7 * 60;
  const awake = Math.max(0, Math.min(upToMinutes, wakeMinutes + 16 * 60) - wakeMinutes);
  const movement = 0.2 * perMinute * Math.max(0, awake - exerciseMinutes);

  const restingSoFar = perMinute * upToMinutes;
  return { resting: restingSoFar, movement: movement, exercise: exercise,
           total: restingSoFar + movement + exercise, wakeAssumed: !wake };
}

// 1590.4 -> "1,590"
function kcalText(n) {
  return Math.round(n).toLocaleString("en-US");
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// The "Burned today so far" box at the top of the Log tab
function renderToday() {
  updateWeightButtons();
  const t = today();
  const wake = wakeEntryFor(t);
  document.getElementById("today-wake-text").textContent = wake
    ? "Woke up at " + formatTime(wake.time)
    : "Wake-up not logged (assuming 7:00 AM)";
  document.getElementById("wake-time").value = wake ? wake.time : "";

  const day = dayCalories(t, nowMinutes());
  const value = document.getElementById("today-kcal");
  const split = document.getElementById("today-split");
  if (!day) {
    value.textContent = "–";
    split.textContent = getProfile()
      ? "Log a weigh-in to see your calories."
      : "Add your height, birth date and sex in Profile to see your calories.";
    return;
  }
  value.textContent = "≈ " + kcalText(day.total) + " kcal";
  split.textContent = "Resting " + kcalText(day.resting) + " · Movement " + kcalText(day.movement) +
                      " · Exercise " + kcalText(day.exercise);
}
setInterval(renderToday, 60000);   // keep it current, once a minute

// Change today's wake-up time from the Today box
document.getElementById("wake-time").addEventListener("change", function (event) {
  if (event.target.value) logWake(event.target.value);
});


// =====================================================
//  9d. MORNING ROUTINE
//  Each day, before the rest of the site: 1) wake-up time, 2) weigh-in.
// =====================================================

function logWake(time) {
  const t = today();
  // One wake-up per day: its id includes the date, so saving again replaces it
  addEntry({ id: "wake-" + t, type: "wake", date: t, time: time });
  showToast("Woke up at " + formatTime(time) + " ✓");
  renderToday();
}

// Show the step that's still needed today, or nothing
function showMorning() {
  if (!getSession() || !isApproved()) return;   // locked out: nothing to log yet
  const t = today();
  const needWake = !wakeEntryFor(t) && getPref("wakeSkipped", "") !== t;
  const needWeigh = !loadEntries().some(function (e) {
    return e.type === "bodyweight" && e.date === t && e.morning;
  }) && getPref("weighLater", "") !== t;

  const morning = document.getElementById("morning");
  const wakeStep = document.getElementById("morning-wake");
  const weighStep = document.getElementById("morning-weigh");
  const wasWeighing = !weighStep.hidden;
  const step = needWake ? wakeStep : (needWeigh ? weighStep : null);

  // Getting the weigh-in ready (only when it first appears, not while you type)
  if (step === weighStep && !wasWeighing) {
    document.getElementById("mw-unit").value = getPref("weightUnit", "kg");
    document.getElementById("mw-weight").value = "";
    document.getElementById("mw-peed").checked = false;
    document.getElementById("mw-pooped").checked = false;
  }

  // The screen "materializes": it arrives slightly small and blurred, and leaves
  // the same way. Each step slides up a little as it comes in, and the step
  // before it slides up and out, so the routine reads as moving forward.
  if (!step) {
    fluid.hide(morning, { scale: 0.96, blur: 8 });
    return;
  }
  if (morning.hidden) {
    // First appearance: place the right step before the screen comes in
    wakeStep.hidden = step !== wakeStep;
    weighStep.hidden = step !== weighStep;
    fluid.show(morning, { scale: 0.96, blur: 8 });
    return;
  }
  [wakeStep, weighStep].forEach(function (s) {
    if (s === step) fluid.show(s, { y: 16 });
    else fluid.hide(s, { y: -16 });
  });
}

document.getElementById("wake-now").addEventListener("click", function () {
  logWake(timeOf());
  showMorning();
});

document.getElementById("wake-manual-save").addEventListener("click", function () {
  const time = document.getElementById("wake-manual").value;
  if (!time) { showToast("Pick the time you woke up"); return; }
  logWake(time);
  showMorning();
});

document.getElementById("wake-skip").addEventListener("click", function () {
  setPref("wakeSkipped", today());
  showMorning();
});

document.getElementById("mw-save").addEventListener("click", function () {
  const weight = Number(document.getElementById("mw-weight").value);
  if (!(weight >= 20 && weight <= 700)) { showToast("Type your weight first"); return; }
  const unit = document.getElementById("mw-unit").value;
  addEntry({
    type: "bodyweight",
    date: today(),
    time: timeOf(),
    weight: weight,
    unit: unit,
    morning: true,
    peed: document.getElementById("mw-peed").checked,
    pooped: document.getElementById("mw-pooped").checked
  });
  setPref("weightUnit", unit);
  showToast("Saved " + weight + " " + unit + " ✓");
  showMorning();
  renderToday();
});

document.getElementById("mw-later").addEventListener("click", function () {
  setPref("weighLater", today());
  showMorning();
});


// =====================================================
//  10. PROFILE: your account
// =====================================================

// ---------- Your body details ----------
// Saved as one special entry (id "profile"), so it syncs to all your devices
// like your logs, with no changes needed in Supabase.

const profileForm = document.getElementById("form-profile");

// Show cm, or feet + inches, depending on the chosen unit
function updateHeightFields() {
  const ftin = profileForm.elements.heightUnit.value === "ftin";
  profileForm.elements.heightCm.hidden = ftin;
  profileForm.querySelector(".ft-in").hidden = !ftin;
}
profileForm.elements.heightUnit.addEventListener("change", function () {
  // Carry the number over when switching units
  const f = profileForm.elements;
  if (f.heightUnit.value === "ftin" && f.heightCm.value) {
    const inches = Number(f.heightCm.value) / 2.54;
    f.heightFt.value = Math.floor(inches / 12);
    f.heightIn.value = Math.round((inches % 12) * 2) / 2;
  } else if (f.heightUnit.value === "cm" && f.heightFt.value) {
    f.heightCm.value = Math.round((Number(f.heightFt.value) * 12 + Number(f.heightIn.value || 0)) * 2.54);
  }
  setPref("heightUnit", f.heightUnit.value);
  updateHeightFields();
});

// Fill the form with what's saved
function renderProfile() {
  const p = getProfile() || {};
  const f = profileForm.elements;
  f.heightUnit.value = getPref("heightUnit", "cm");
  f.heightCm.value = p.heightCm ? Math.round(p.heightCm * 2) / 2 : "";
  if (p.heightCm) {
    const inches = p.heightCm / 2.54;
    f.heightFt.value = Math.floor(inches / 12);
    f.heightIn.value = Math.round((inches % 12) * 2) / 2;
  }
  f.birthDate.value = p.birthDate || "";
  f.sex.value = p.sex || "";
  updateHeightFields();

  const resting = restingPerDay(today());
  document.getElementById("profile-rmr").textContent = resting
    ? "Your estimated resting burn: ≈ " + kcalText(resting) + " kcal per day."
    : p.heightCm ? "Log a weigh-in to see your resting burn." : "";

  // Say so when the estimates are personally calibrated
  const c = p.calibration;
  const note = document.getElementById("profile-calibration");
  note.hidden = !c;
  if (c) {
    const sports = Object.keys(c.sportMets || {}).map(function (s) {
      return s.charAt(0).toUpperCase() + s.slice(1) + " " + c.sportMets[s];
    }).join(", ");
    note.textContent = "✓ Personally calibrated" + (c.source ? " with " + c.source : "") +
      ": everyday burn × " + c.everyday + (sports ? "; your own intensity for " + sports : "") + ".";
  }
}

profileForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const f = profileForm.elements;
  const heightCm = f.heightUnit.value === "ftin"
    ? (Number(f.heightFt.value) * 12 + Number(f.heightIn.value || 0)) * 2.54
    : Number(f.heightCm.value);
  if (!(heightCm >= 100 && heightCm <= 250)) { showToast("Check your height"); return; }

  const profile = {
    id: "profile",
    type: "profile",
    date: today(),
    heightCm: Math.round(heightCm * 10) / 10,
    birthDate: f.birthDate.value,
    sex: f.sex.value
  };
  // Keep a personal calibration if there is one (it isn't part of this form)
  const before = getProfile();
  if (before && before.calibration) profile.calibration = before.calibration;
  addEntry(profile);
  showToast("Profile saved ✓");
  renderProfile();
  renderToday();
});


// ---------- The daily reminder notification ----------
// The phone gives us an "address" for notifications (a subscription); we store it in
// Supabase, and the morning-reminder program there sends to it at your chosen time.

const REMINDER_URL = SUPABASE_URL + "/functions/v1/morning-reminder";

// The background helper (sw.js) that shows the notification
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(function () { /* not available here */ });
}

function notificationsSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// The key Supabase gives us is written in "base64url"; the phone wants raw bytes
function keyBytes(base64url) {
  const base64 = (base64url + "===".slice((base64url.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), function (c) { return c.charCodeAt(0); });
}

async function currentSubscription() {
  if (!notificationsSupported()) return null;
  // getRegistration (not "ready"), so we never wait forever if the helper didn't start
  const helper = await navigator.serviceWorker.getRegistration();
  return helper ? helper.pushManager.getSubscription() : null;
}

// Save (or update) this phone's reminder in Supabase
async function saveSubscription(subscription) {
  const s = subscription.toJSON();
  await database("push_subscriptions?on_conflict=endpoint", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      endpoint: s.endpoint,
      user_id: getSession().userId,
      p256dh: s.keys.p256dh,
      auth: s.keys.auth,
      notify_time: getPref("notifyTime", "07:00"),
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }])
  });
}

async function renderNotify() {
  const status = document.getElementById("notify-status");
  const on = document.getElementById("notify-on");
  const off = document.getElementById("notify-off");
  document.getElementById("notify-time").value = getPref("notifyTime", "07:00");

  if (!notificationsSupported()) {
    const iPhone = /iPhone|iPad|iPod/.test(navigator.userAgent);
    status.textContent = iPhone
      ? "On iPhone, add the tracker to your Home Screen first (Share → Add to Home Screen), then open it from there."
      : "This browser can't show notifications.";
    on.hidden = true;
    off.hidden = true;
    return;
  }
  const subscription = await currentSubscription();
  on.hidden = !!subscription;
  off.hidden = !subscription;
  if (subscription) {
    status.textContent = "✓ On. You'll get it at " + formatTime(getPref("notifyTime", "07:00")) + " each day.";
  } else if (Notification.permission === "denied") {
    status.textContent = "Notifications are blocked. Allow them in your phone's Settings → Notifications → Workouts.";
  } else {
    status.textContent = getSession() ? "" : "Sign in first (Account, below).";
  }
}

document.getElementById("notify-on").addEventListener("click", async function () {
  if (!getSession()) { showToast("Sign in first"); return; }
  try {
    // The phone asks: "Allow notifications?" (must happen right after a tap)
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { renderNotify(); return; }

    const helper = await navigator.serviceWorker.ready;
    const answer = await (await fetch(REMINDER_URL)).json();
    const subscription = await helper.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(answer.publicKey)
    });
    await saveSubscription(subscription);
    showToast("Reminder on ✓ Sending a test…");
    // A test notification right away, so you can see that it works
    fetch(REMINDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: subscription.endpoint })
    });
  } catch (error) {
    showToast("Couldn't turn it on: " + error.message);
  }
  renderNotify();
});

document.getElementById("notify-off").addEventListener("click", async function () {
  try {
    const subscription = await currentSubscription();
    if (subscription) {
      await database("push_subscriptions?endpoint=eq." + encodeURIComponent(subscription.endpoint), { method: "DELETE" });
      await subscription.unsubscribe();
    }
    showToast("Reminder off");
  } catch (error) {
    showToast("Couldn't turn it off: " + error.message);
  }
  renderNotify();
});

// A new time: remember it, and tell Supabase if the reminder is on
document.getElementById("notify-time").addEventListener("change", async function (event) {
  if (!event.target.value) return;
  setPref("notifyTime", event.target.value);
  const subscription = await currentSubscription();
  if (subscription && getSession()) {
    try {
      await saveSubscription(subscription);
      showToast("Reminder time saved ✓");
    } catch (error) {
      showToast("Couldn't save the time: " + error.message);
    }
  }
  renderNotify();
});


// ---------- Account ----------

const signInForm = document.getElementById("form-signin");
const signUpForm = document.getElementById("form-signup");

// ---------- Membership: are you approved? ----------
// Your row in the members table (name, status, role). A copy is kept on this
// device so the app knows at once whether to show the waiting screen.
function getMembership() {
  try { return JSON.parse(localStorage.getItem("membership")); } catch (error) { return null; }
}
function setMembership(m) {
  if (m) localStorage.setItem("membership", JSON.stringify(m));
  else localStorage.removeItem("membership");
}
function isApproved() {
  const m = getMembership();
  return !!m && m.status === "approved";
}
function isAdmin() {
  const m = getMembership();
  return !!m && m.status === "approved" && m.role === "admin";
}

async function loadMembership() {
  const session = getSession();
  if (!session) { setMembership(null); return null; }
  const rows = await database("members?select=name,status,role&user_id=eq." + session.userId, {});
  const m = rows && rows[0] ? rows[0] : { name: "", status: "pending", role: "member" };
  setMembership(m);
  renderGate();
  return m;
}

// A request to Supabase's sign-in service (create account, reset password, …)
async function authRequest(path, method, body, token) {
  const headers = { apikey: SUPABASE_KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch(SUPABASE_URL + "/auth/v1/" + path, {
    method: method, headers: headers, body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let answer = {};
  try { answer = JSON.parse(text); } catch (error) { /* no details */ }
  if (!response.ok) throw new Error(answer.error_description || answer.msg || answer.message || "Something went wrong");
  return answer;
}

// Create an account. The name travels with it and lands in the members table.
// Returns true if you're signed in right away, false if an email must be confirmed first.
async function signUp(name, email, password) {
  const answer = await authRequest("signup", "POST", { email: email, password: password, data: { name: name } });
  if (!answer.access_token) return false;
  setSessionFrom(answer);
  await loadMembership();
  return true;
}

// Links in emails (confirm your address, reset your password) open the app with
// a pass in the address bar (after the #). Take it, sign in with it, and tidy
// the address. Returns what kind of link it was, or null if there wasn't one.
async function takeTokensFromLink() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!hash.includes("access_token=") && !hash.includes("error_description=")) return null;
  const params = new URLSearchParams(hash);
  history.replaceState(null, "", location.pathname + location.search);
  if (params.get("error_description")) {
    showToast(params.get("error_description").replace(/\+/g, " "));
    return null;
  }
  const token = params.get("access_token");
  try {
    const user = await authRequest("user", "GET", null, token);
    setSession({
      accessToken: token,
      refreshToken: params.get("refresh_token"),
      expiresAt: Date.now() + Number(params.get("expires_in") || 3600) * 1000,
      userId: user.id,
      email: user.email
    });
    await loadMembership();
    return params.get("type") || "signup";
  } catch (error) {
    showToast(error.message);
    return null;
  }
}

// Sign in / Create account switch
document.querySelectorAll("#auth-mode button").forEach(function (button) {
  button.addEventListener("click", function () { setAuthMode(button.dataset.mode); });
});
function setAuthMode(mode) {
  document.querySelectorAll("#auth-mode button").forEach(function (b) {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  signInForm.hidden = mode !== "signin";
  signUpForm.hidden = mode !== "signup";
}

// Without an approved account the app is locked: no tabs, just the Account box
function applyAccess() {
  const locked = !getSession() || !isApproved();
  document.body.classList.toggle("locked", locked);
  document.querySelector("nav").hidden = locked;
  profileForm.hidden = locked;
  document.getElementById("notify-box").hidden = locked;
  if (locked) {
    sections.forEach(function (s) { s.hidden = s.id !== "profile"; });
  } else {
    const current = document.querySelector(".tab.active").dataset.section;
    sections.forEach(function (s) { s.hidden = s.id !== current; });
    moveTabIndicator(document.querySelector(".tab.active"), true);
  }
  return locked;
}

function renderAccount() {
  const session = getSession();
  const m = getMembership();
  applyAccess();
  document.getElementById("signed-out").hidden = !!session;
  document.getElementById("signed-in").hidden = !session;
  document.getElementById("members-box").hidden = !session || !isAdmin();
  if (session) {
    document.getElementById("signed-in-name").textContent = (m && m.name) || session.email;
    document.getElementById("signed-in-email").textContent = (m && m.name) ? session.email : "";
    document.getElementById("membership-note").textContent =
      !m ? "" :
      m.status === "approved" ? (m.role === "admin" ? "Approved · admin" : "Approved ✓") :
      m.status === "declined" ? "Not approved" : "Waiting for Javier's approval";
    const nameBox = document.getElementById("member-name");
    if (document.activeElement !== nameBox) nameBox.value = (m && m.name) || "";
    if (isAdmin()) renderMembers();
  }
  renderNotify();   // the reminder needs you signed in
  renderGate();
}

// The waiting screen: shown while your account is pending or declined
function renderGate() {
  const gate = document.getElementById("gate");
  const m = getMembership();
  const waiting = !!getSession() && !!m && m.status !== "approved";
  if (!waiting) { if (!gate.hidden) fluid.hide(gate, { scale: 0.96, blur: 8 }); return; }
  const declined = m.status === "declined";
  document.getElementById("gate-title").textContent = declined ? "Not approved" : "Waiting for approval";
  document.getElementById("gate-text").textContent = declined
    ? "Javier hasn't approved this account. Ask him if you think that's a mistake."
    : "Your account is created. Javier approves new members by hand — ask him, then come back here.";
  if (gate.hidden) fluid.show(gate, { scale: 0.96, blur: 8 });
}

document.getElementById("gate-check").addEventListener("click", async function () {
  try {
    const m = await loadMembership();
    if (m.status === "approved") { showToast("You're in ✓"); renderAccount(); sync(); }
    else showToast("Not yet. Javier hasn't approved you.");
  } catch (error) {
    showToast(error instanceof TypeError ? "Can't reach Supabase. Are you online?" : error.message);
  }
});
document.getElementById("gate-signout").addEventListener("click", function () { signOut(); renderAccount(); });

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
    showToast(isApproved() ? "Signed in ✓" : "Signed in · waiting for approval");
  } catch (error) {
    showToast(error instanceof TypeError ? "Can't reach Supabase. Are you online?" : error.message);
  }
});

signUpForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  const f = signUpForm.elements;
  try {
    const signedIn = await signUp(f.name.value.trim(), f.email.value.trim(), f.password.value);
    signUpForm.reset();
    renderAccount();
    showToast(signedIn ? "Account created ✓" : "Check your email to confirm your address");
    if (!signedIn) setAuthMode("signin");
  } catch (error) {
    showToast(error instanceof TypeError ? "Can't reach Supabase. Are you online?" : error.message);
  }
});

// Forgot password: Supabase emails a link that opens the "choose a new password" screen
document.getElementById("forgot-password").addEventListener("click", async function () {
  const email = signInForm.elements.email.value.trim();
  if (!email) { showToast("Type your email above first"); return; }
  try {
    await authRequest("recover", "POST", { email: email, options: { redirect_to: location.href.split("#")[0] } });
    showToast("Check your email for the reset link");
  } catch (error) {
    showToast(error instanceof TypeError ? "Can't reach Supabase. Are you online?" : error.message);
  }
});

// Change the password (from Profile, or from the reset link's screen)
async function changePassword(password) {
  const session = await validSession();
  await authRequest("user", "PUT", { password: password }, session.accessToken);
}

document.getElementById("form-password").addEventListener("submit", async function (event) {
  event.preventDefault();
  try {
    await changePassword(event.target.elements.password.value);
    event.target.reset();
    event.target.closest("details").open = false;
    showToast("Password changed ✓");
  } catch (error) { showToast(error.message); }
});

document.getElementById("form-recovery").addEventListener("submit", async function (event) {
  event.preventDefault();
  try {
    await changePassword(event.target.elements.password.value);
    event.target.reset();
    fluid.hide(document.getElementById("recovery"), { scale: 0.96, blur: 8 });
    showToast("Password saved ✓");
    renderAccount();
  } catch (error) { showToast(error.message); }
});

// Your name (only you can change it; the database allows nothing else through this door)
document.getElementById("save-name").addEventListener("click", async function () {
  const name = document.getElementById("member-name").value.trim();
  if (!name) { showToast("Type a name first"); return; }
  try {
    await database("rpc/set_my_name", { method: "POST", body: JSON.stringify({ new_name: name }) });
    const m = getMembership() || {};
    m.name = name.slice(0, 40);
    setMembership(m);
    renderAccount();
    showToast("Name saved ✓");
  } catch (error) { showToast(error.message); }
});

document.getElementById("sign-out").addEventListener("click", function () {
  const waiting = loadOutbox().length;
  const message = waiting
    ? waiting + " change(s) haven't been sent yet and will be lost."
    : "Your logs stay saved online.";
  askConfirm("Sign out?", message, "Sign out", waiting > 0).then(function (ok) {
    if (!ok) return;
    signOut();
    renderAccount();
  });
});

// ---------- Members (admin only): approve or decline people ----------
let membersToastShown = false;
async function renderMembers() {
  const list = document.getElementById("members-list");
  let rows;
  try {
    rows = await database("members?select=user_id,email,name,status,role,requested_at&order=requested_at.desc", {});
  } catch (error) {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "hint small";
    li.textContent = "Couldn't load the members list: " + error.message;
    list.appendChild(li);
    return;
  }
  list.innerHTML = "";
  const pending = rows.filter(function (r) { return r.status === "pending"; });
  if (pending.length && !membersToastShown) {
    membersToastShown = true;
    showToast(pending.length === 1 ? "1 person is waiting to join" : pending.length + " people are waiting to join");
  }
  rows.forEach(function (r) {
    const li = document.createElement("li");
    li.className = "member " + r.status;
    const who = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = r.name || "(no name)";
    const email = document.createElement("div");
    email.className = "hint small";
    email.textContent = r.email;
    const when = document.createElement("div");
    when.className = "hint small";
    when.textContent = (r.role === "admin" ? "Admin · " : "") +
      (r.status === "pending" ? "Asked to join " : r.status === "approved" ? "Approved · joined " : "Declined · asked ") +
      dayLabel(r.requested_at.slice(0, 10));
    who.append(name, email, when);
    const actions = document.createElement("div");
    actions.className = "member-actions";
    if (r.role !== "admin") {
      if (r.status !== "approved") actions.appendChild(memberButton("Approve", "save", function () { setMemberStatus(r, "approved"); }));
      if (r.status !== "declined") actions.appendChild(memberButton("Decline", "secondary", function () { setMemberStatus(r, "declined"); }));
    }
    li.append(who, actions);
    list.appendChild(li);
  });
}

function memberButton(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function setMemberStatus(member, status) {
  try {
    await database("members?user_id=eq." + member.user_id, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: status, approved_at: status === "approved" ? new Date().toISOString() : null })
    });
    showToast((member.name || member.email) + (status === "approved" ? " approved ✓" : " declined"));
    renderMembers();
  } catch (error) { showToast(error.message); }
}

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
  renderToday();
  showMorning();   // e.g. you already logged your wake-up on another device
  if (document.getElementById("history").classList.contains("active")) renderHistory();
  if (document.getElementById("weight").classList.contains("active")) renderProgress();
  // Refill the profile form, unless you're in the middle of typing in it
  if (!profileForm.contains(document.activeElement)) renderProfile();
}

// ---------- The welcome screen (first visit, not signed in) ----------
function showWelcome() {
  const welcome = document.getElementById("welcome");
  if (welcome.hidden) fluid.show(welcome, { scale: 0.96, blur: 8 });
}
function closeWelcome(mode) {
  setPref("welcomed", "1");
  fluid.hide(document.getElementById("welcome"), { scale: 0.96, blur: 8 });
  if (mode) {
    document.querySelector('.tab[data-section="profile"]').click();
    setAuthMode(mode);
  }
  showMorning();
}
document.getElementById("welcome-signup").addEventListener("click", function () { closeWelcome("signup"); });
document.getElementById("welcome-signin").addEventListener("click", function () { closeWelcome("signin"); });

// Start: first deal with a link from an email (if that's how the app was opened),
// then draw everything
async function start() {
  renderCurrentWorkout();
  renderProfile();
  renderToday();
  updateSyncStatus();

  const linkType = await takeTokensFromLink();
  if (linkType === "recovery") fluid.show(document.getElementById("recovery"), { scale: 0.96, blur: 8 });

  // Signed in from before this update, or status may have changed: ask again (quietly)
  if (getSession() && linkType === null) loadMembership().then(renderAccount).catch(function () { /* offline: use the copy */ });

  renderAccount();
  renderNotify();
  if (!getSession() && loadEntries().length === 0 && getPref("welcomed", "") !== "1") showWelcome();
  else showMorning();
  sync();
}
start();

// Coming back to the app (maybe on a new day): check the morning routine again
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") {
    showMorning();
    renderToday();
  }
});
