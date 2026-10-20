// =====================================================
//  SERVICE WORKER: a small helper the phone keeps in the background.
//  Its only job here: show the daily reminder notification when Supabase
//  sends it, and open the app when you tap it.
//  (It doesn't save pages for offline use, so you always get the newest version.)
// =====================================================

// Take over straight away when a new version arrives
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });

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
