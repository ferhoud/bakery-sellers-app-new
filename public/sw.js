// public/sw.js
const SW_VERSION = 'v16';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: 'Nouvelle notification', body: event.data?.text() ?? '' };
  }

  const title = data.title ?? 'Notification';
  const body  = data.body ?? '';
  const url   = (data.data && data.data.url) || data.url || '/';

  const options = {
    body,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url },
  };

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clientsList.forEach((c) => c.postMessage({ type: 'push', sw: SW_VERSION }));
    if (title || body) await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const origin = self.location.origin;
    const absolute = new URL(targetUrl, origin).href;
    const same = all.find((c) => c.url === absolute || c.url === origin + '/');
    if (same) {
      same.focus();
      same.postMessage({ type: 'open-url', url: targetUrl });
      return;
    }
    await self.clients.openWindow(absolute);
  })());
});
