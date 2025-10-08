// public/sw.js
const SW_VERSION = 'v14';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'Notification';
  const body  = data.body || '';
  const url   = (data.data && data.data.url) || data.url || '/';
  const options = {
    body,
    data: { url },
    badge: '/icons/icon-192.png',
    icon:  '/icons/icon-192.png',
  };
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clientsList.forEach((c) => c.postMessage({ type: 'push', sw: SW_VERSION }));
    if (title || body) await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameOrigin = all.find((c) => c.url && new URL(c.url).origin === self.location.origin);
    if (sameOrigin) {
      sameOrigin.focus();
      sameOrigin.postMessage({ type: 'open-url', url });
    } else {
      await self.clients.openWindow(url);
    }
  })());
});
