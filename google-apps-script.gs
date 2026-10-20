// =====================================================
//  WORKOUT TRACKER — Google Apps Script
//  This code runs on Google's computers, inside your Google Sheet.
//  The website sends it changes; it writes them into the sheet and
//  sends back the full list of entries.
//
//  How to install: see SETUP.md.
//
//  IMPORTANT: change the password below ONLY inside Google's script
//  editor, never in this file (this file is public on GitHub).
// =====================================================

const PASSWORD = "CHANGE-ME";


// -----------------------------------------------------
//  The tabs and their columns: [field name in the app, column title]
// -----------------------------------------------------

const TABS = {
  workout: { name: "Workouts", columns: [
    ["date", "Date"], ["minutes", "Total minutes"], ["notes", "Notes"]
  ]},
  weights: { name: "Weights", columns: [
    ["date", "Date"], ["exercise", "Exercise"], ["sets", "Sets (reps × weight)"],
    ["unit", "Unit"], ["notes", "Notes"]
  ]},
  cardio: { name: "Cardio", columns: [
    ["date", "Date"], ["activity", "Activity"], ["minutes", "Minutes"],
    ["speed", "Speed"], ["speedUnit", "Speed unit"], ["incline", "Incline %"],
    ["level", "Level"], ["floors", "Floors"], ["notes", "Notes"]
  ]},
  sports: { name: "Sports", columns: [
    ["date", "Date"], ["sport", "Sport"], ["minutes", "Minutes"],
    ["temperature", "Temperature"], ["tempUnit", "Temp unit"], ["score", "Score"],
    ["notes", "Notes"]
  ]},
  bodyweight: { name: "Body weight", columns: [
    ["date", "Date"], ["weight", "Weight"], ["unit", "Unit"], ["morning", "Morning weigh-in"],
    ["peed", "Peed before"], ["pooped", "Pooped before"]
  ]}
};

// Every tab also gets these at the end (used by the app, safe to ignore)
const EXTRA_COLUMNS = [
  ["workoutId", "Workout id"], ["id", "Id"], ["user", "User"], ["createdAt", "Created at"]
];

// Fields that hold numbers (everything else is text)
const NUMBER_FIELDS = ["minutes", "speed", "incline", "level", "floors",
                       "temperature", "score", "weight"];

// Fields that are yes/no
const YES_NO_FIELDS = ["morning", "peed", "pooped"];


// -----------------------------------------------------
//  The web address: the website "posts" a request here
// -----------------------------------------------------

// Opening the address in a browser just shows that it works
function doGet() {
  return reply({ ok: true, message: "Workout tracker script is running." });
}

// Request: { password: "...", ops: [ {op: "add", entry}, {op: "update", id, changes}, {op: "delete", id} ] }
// Answer:  { ok: true, entries: [ ...every entry... ] }
function doPost(e) {
  let request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (error) {
    return reply({ ok: false, error: "Bad request" });
  }
  if (request.password !== PASSWORD) {
    return reply({ ok: false, error: "Wrong password" });
  }

  // Only one request at a time, so two devices can't mix up rows
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    (request.ops || []).forEach(applyOp);
    return reply({ ok: true, entries: readAll() });
  } finally {
    lock.releaseLock();
  }
}

function reply(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


// -----------------------------------------------------
//  Applying one change
// -----------------------------------------------------

function applyOp(op) {
  if (op.op === "add") {
    // If it's already there (e.g. sent twice), replace it instead of duplicating
    const existing = findRow(op.entry.id);
    if (existing) existing.sheet.deleteRow(existing.row);
    const sheet = getTab(op.entry.type);
    writeRow(sheet, sheet.getLastRow() + 1, op.entry);
  }
  if (op.op === "update") {
    const existing = findRow(op.id);
    if (!existing) return;
    const entry = Object.assign(existing.entry, op.changes);
    writeRow(existing.sheet, existing.row, entry);
  }
  if (op.op === "delete") {
    const existing = findRow(op.id);
    if (existing) existing.sheet.deleteRow(existing.row);
  }
}


// -----------------------------------------------------
//  Tabs and rows
// -----------------------------------------------------

function columnsOf(type) {
  return TABS[type].columns.concat(EXTRA_COLUMNS);
}

function titlesOf(type) {
  return columnsOf(type).map(function (c) { return c[1]; });
}

// Get a tab, creating it (with bold column titles) the first time.
// If its columns are from an older version of this script, update it.
function getTab(type) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(TABS[type].name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(TABS[type].name);
    writeTitles(sheet, type);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
    if (current.join("|") !== titlesOf(type).join("|")) upgradeTab(sheet, type, current);
  }
  return sheet;
}

function writeTitles(sheet, type) {
  const titles = titlesOf(type);
  sheet.getRange(1, 1, 1, titles.length).setValues([titles]).setFontWeight("bold");
  sheet.setFrozenRows(1);
}

// Re-write a tab with the new columns, reading the old rows by their column titles
function upgradeTab(sheet, type, oldTitles) {
  const rows = sheet.getLastRow() < 2 ? [] :
    sheet.getRange(2, 1, sheet.getLastRow() - 1, oldTitles.length).getValues();
  const entries = rows.map(function (row) {
    const entry = { type: type };
    columnsOf(type).forEach(function (c) {
      const i = oldTitles.indexOf(c[1]);
      if (i !== -1 && row[i] !== "") entry[c[0]] = fromCell(c[0], row[i]);
    });
    return entry;
  });
  sheet.clear();
  writeTitles(sheet, type);
  entries.forEach(function (entry, i) { writeRow(sheet, i + 2, entry); });
}

// Write one entry into a row. Text columns are marked as plain text first,
// so Google doesn't turn "2026-10-20" into a date or ids into numbers.
function writeRow(sheet, row, entry) {
  const columns = columnsOf(entry.type);
  const values = columns.map(function (c) { return toCell(c[0], entry[c[0]]); });
  const formats = columns.map(function (c) {
    return NUMBER_FIELDS.includes(c[0]) ? "General" : "@";
  });
  sheet.getRange(row, 1, 1, columns.length)
    .setNumberFormats([formats])
    .setValues([values]);
}

// App value -> what you see in the cell
function toCell(field, value) {
  if (value === undefined || value === null) return "";
  if (field === "sets") {
    return value.map(function (s) { return s.reps + " × " + s.weight; }).join(", ");
  }
  if (YES_NO_FIELDS.includes(field)) return value ? "yes" : "no";
  return value;
}

// What's in the cell -> app value
function fromCell(field, value) {
  if (value instanceof Date) {   // in case a date was typed into the sheet by hand
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  if (field === "sets") {
    return String(value).split(",").map(function (part) {
      const numbers = part.split(/[×x]/i);   // "8 × 60" (or "8x60" typed by hand)
      return { reps: Number(numbers[0]), weight: Number(numbers[1]) };
    });
  }
  if (YES_NO_FIELDS.includes(field)) return value === "yes";
  if (NUMBER_FIELDS.includes(field)) return Number(value);
  return String(value);
}

function rowToEntry(type, row) {
  const entry = { type: type };
  columnsOf(type).forEach(function (c, i) {
    if (row[i] !== "") entry[c[0]] = fromCell(c[0], row[i]);
  });
  return entry;
}

// Every entry from every tab
function readAll() {
  const entries = [];
  Object.keys(TABS).forEach(function (type) {
    const sheet = getTab(type);
    if (sheet.getLastRow() < 2) return;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, columnsOf(type).length).getValues();
    rows.forEach(function (row) {
      const entry = rowToEntry(type, row);
      if (entry.id) entries.push(entry);
    });
  });
  return entries;
}

// Find an entry's row by its id, in any tab
function findRow(id) {
  const types = Object.keys(TABS);
  for (let t = 0; t < types.length; t++) {
    const type = types[t];
    const sheet = getTab(type);
    if (sheet.getLastRow() < 2) continue;
    const columns = columnsOf(type);
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, columns.length).getValues();
    const idIndex = columns.findIndex(function (c) { return c[0] === "id"; });
    for (let r = 0; r < rows.length; r++) {
      if (String(rows[r][idIndex]) === String(id)) {
        return { sheet: sheet, row: r + 2, entry: rowToEntry(type, rows[r]) };
      }
    }
  }
  return null;
}
