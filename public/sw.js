/* public/sw.js
   Mode dépannage: Service Worker "push-only".
   ➜ Pas de cache, pas d'interception fetch (évite /login -> /app et chunks figés).
*/

self.addEventListener("install", (event) => {
  // Active immédiatement la nouvelle version
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Nettoie tous les caches (anciens SW)
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {}
      // Prend le contrôle des onglets ouverts
      try {
        await self.clients.claim();
      } catch (_) {}
    })()
  );
});

// --- PUSH (si tu l'utilises) ---
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    try {
      payload = { body: event.data?.text?.() };
    } catch (_) {
      payload = {};
    }
  }

  const title = payload.title || "Boulangerie";
  const body = payload.body || payload.message || "Nouvelle notification";
  const url = payload.url || "/app";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/app";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        try {
          if ("focus" in client) {
            await client.focus();
            client.postMessage?.({ type: "nav", url });
            return;
          }
        } catch (_) {}
      }
      if (self.clients?.openWindow) {
        await self.clients.openWindow(url);
      }
    })()
  );
});

// Optionnel: permettre "SKIP_WAITING" depuis le client si besoin
self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") {
    try {
      self.skipWaiting();
    } catch (_) {}
  }
});
