// public/sw.js
// Service Worker minimal (pas d'offline caching) : juste pour l'install PWA + mode "app".
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
