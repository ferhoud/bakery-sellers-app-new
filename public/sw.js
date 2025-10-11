// public/sw.js — SW minimal pour être "prêt" rapidement
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// (optionnel) écoute basique des push pour éviter les erreurs
self.addEventListener('push', (event) => {
  const data = (() => { try { return event.data && event.data.json(); } catch { return {}; } })();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Notification', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
    })
  );
});
