// public/sw.js — SW robuste (push + focus + broadcast)

// Activer immédiatement la nouvelle version
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Utilitaire : envoyer un message à toutes les fenêtres clientes
async function broadcast(message) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of all) {
    try { client.postMessage(message); } catch (e) { /* ignore */ }
  }
}

// Réception push : affiche une notif + informe les pages ouvertes
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event?.data?.json?.() ?? {};
  } catch {
    try { data = JSON.parse(event.data.text()); } catch { data = {}; }
  }

  const title = data.title || "Notification";
  const body = data.body || "";
  const icon = data.icon || "/icon-192.png"; // assure-toi que l'icône existe dans /public
  const url = data.url || "/";               // cible au clic sur la notification

  event.waitUntil((async () => {
    // 1) informer immédiatement les pages (permet reloadAll côté app)
    await broadcast({ type: "push", payload: data });

    // 2) afficher la notification
    await self.registration.showNotification(title, {
      body,
      icon,
      data: { url },
      tag: data.tag || undefined,         // tag identique => remplace notif précédente (optionnel)
      renotify: !!data.renotify,          // optionnel
      requireInteraction: !!data.sticky,  // garder la notif jusqu'au clic (optionnel)
    });
  })());
});

// Clic sur la notification : focus une fenêtre existante ou en ouvrir une
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/";

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    // Cherche une fenêtre sur le même origin déjà ouverte
    for (const client of allClients) {
      // Si une fenêtre correspond déjà à l’URL, focus-la
      if (client.url.includes(new URL(targetUrl, self.location.origin).pathname)) {
        try { await client.focus(); } catch {}
        // informe la page qu’un clic de notif a eu lieu (optionnel)
        try { client.postMessage({ type: "notification-click", url: targetUrl }); } catch {}
        return;
      }
    }

    // Sinon, ouvre une nouvelle fenêtre
    const newClient = await self.clients.openWindow(targetUrl);
    if (newClient) {
      try { newClient.postMessage({ type: "notification-click", url: targetUrl }); } catch {}
    }
  })());
});

// (optionnel) fermeture : rien à faire, mais hook présent si tu veux tracer
self.addEventListener("notificationclose", () => {
  // noop
});

// Pas de stratégie cache ici => on laisse Next/Vercel gérer. Si tu veux un cache offline, je t’ajoute Workbox plus tard.
