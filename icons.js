// =====================================================
//  ICONS: small line drawings used instead of emojis, so they look the same
//  on every phone and take the text colour around them.
//  Each one is an SVG "path": a list of pen movements on a 24×24 grid
//  (M = move to, L/l = line to, h/v = horizontal/vertical line, c = curve, z = close).
//
//  Use:  icon("flame")  → an <svg> element   ·   iconHTML("flame") → the same as text
//  Any element with data-icon="name" in index.html gets its drawing filled in on load.
// =====================================================

const ICON_PATHS = {
  plus: "M12 5v14M5 12h14",
  list: "M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01",
  chart: "M3 17l6-6 4 4 8-8M15 7h6v6",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7",
  flame: "M12 3c0 4-5 6-5 10.5a5 5 0 0 0 10 0c0-2.5-1.5-4-2.5-5-.5 2-1.5 3-2.5 3 1-2.5.5-6 0-8.5z",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  scale: "M12 3v18M8 21h8M3 7h18M6 7l-3 7h6l-3-7zM18 7l-3 7h6l-3-7z",
  dumbbell: "M6 7v10M3 9v6M18 7v10M21 9v6M6 12h12",
  run: "M14 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8 21l2.5-6.5L8 12l3-5 4 1 2 3h3M11.5 14.5l2.5 2 1 4.5M8 12l-4 1.5",
  ball: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.5 5.5c3 2.5 3 10.5 0 13M18.5 5.5c-3 2.5-3 10.5 0 13",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  check: "M5 13l4 4L19 7",
  pencil: "M4 20l4-1L19 8l-3-3L5 16l-1 4zM13 7l3 3",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM16 3v4M8 3v4M3 11h18",
  chevronRight: "M9 6l6 6-6 6",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  // Muscle groups
  chest: "M4 10h16M2 8v4M22 8v4M12 10v8M8 18h8",
  back: "M3 5h18M12 5v4M9 12l3-3 3 3M12 9v9M9 21l3-3 3 3",
  arms: "M5 13c0-5 3-8 7-8s6 2 6 5v3M5 13v7h13v-4M9 10a3 3 0 0 1 6 0",
  legs: "M9 3v8l-3 10M15 3v8l3 10M9 11h6M5 21h2M17 21h2",
  abs: "M8 4h8v16H8zM8 10h8M8 15h8M12 4v16",
  stretch: "M12 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 14c3-3 5-4 8-4s5 1 8 4M12 10v6M7 20l5-4 5 4"
};

function iconHTML(name) {
  const d = ICON_PATHS[name];
  if (!d) return "";
  return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
}

function icon(name) {
  const span = document.createElement("span");
  span.className = "icon-wrap";
  span.innerHTML = iconHTML(name);
  return span;
}

document.querySelectorAll("[data-icon]").forEach(function (el) {
  el.innerHTML = iconHTML(el.dataset.icon);
});
