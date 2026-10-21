// =====================================================
//  SERVICE WORKER: a small helper the phone keeps in the background.
//  1. Keeps a copy of the app, so it opens even with no internet.
//     With internet it always fetches the newest version first (so updates
//     arrive by themselves); if that takes over 3 seconds or fails, it uses
//     the saved copy. Your logs themselves are stored by app.js.
//  2. Shows the daily reminder notification and opens the app when tapped.
// =====================================================

const CACHE = "workout-tracker-v2";
const CHART_JS = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
const APP_FILES = ["./", "index.html", "style.css", "app.js", "fluid.js", "motion.min.js",
                   "manifest.json", "icon-180.png", "icon-192.png", "icon-512.png", CHART_JS];

// Save the app files when the helper is first installed
self.addEventListener("install", function (event) {
  self.skipWaiting();   // take over straight away when a new version arrives
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    // One by one, so a single failure doesn't stop the rest
    return Promise.all(APP_FILES.map(function (file) {
      return cache.add(file).catch(function () { /* try again next time */ });
    }));
  }));
});

// Remove saved copies from older versions of this helper
self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

// Every file the app asks for passes through here
self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;               // saving data: let it go to Supabase as normal
  const url = new URL(request.url);

  // The chart library never changes (its address has the version in it): saved copy first
  if (request.url === CHART_JS) {
    event.respondWith(caches.match(request).then(function (saved) {
      return saved || fetch(request).then(function (response) {
        const copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        return response;
      });
    }));
    return;
  }

  // Only the app's own files (not Supabase, not other sites)
  if (url.origin !== self.location.origin) return;

  // Safety net: if anything above goes wrong, just ask the internet as normal
  event.respondWith(newestOrSaved(event, request).catch(function () { return fetch(request); }));
});

// Try the internet (and update the saved copy); fall back to the saved copy
// if there's no answer within 3 seconds or no connection at all
function newestOrSaved(event, request) {
  const fromNetwork = fetch(request).then(function (response) {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.put(request, copy); }));
    }
    return response;
  });

  const saved = function () {
    return caches.match(request, { ignoreSearch: true }).then(function (match) {
      // Opening the app itself: any saved copy of the page will do
      return match || (request.mode === "navigate" ? caches.match("./") : undefined);
    });
  };

  const tooSlow = new Promise(function (resolve) { setTimeout(resolve, 3000); }).then(saved);

  return Promise.race([
    fromNetwork.catch(saved),
    tooSlow.then(function (copy) { return copy || fromNetwork; })   // no saved copy yet: keep waiting
  ]).then(function (response) {
    return response || fromNetwork;
  });
}

// A reminder arrived from Supabase: show it
self.addEventListener("push", function (event) {
  let message = { title: "Workout Tracker", body: "Daily wake-up & weigh-in" };
  try { message = event.data.json(); } catch (error) { /* use the default text */ }
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    icon: "icon-192.png",
    tag: "morning",          // a new reminder replaces an old one instead of piling up
    data: { url: "./" }
  }));
});

// You tapped the reminder: open the app (or bring it to the front).
// Tapping logs nothing; the app's morning screens take it from there.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
    if (windows.length) return windows[0].focus();
    return self.clients.openWindow(event.notification.data.url);
  }));
});
