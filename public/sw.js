// /public/sw.js
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch (e) {
    data = { title: 'Nouvelle notification', body: event.data?.text() ?? '' };
  }

  const title = data.title ?? 'Notification';
  const options = {
    body: data.body ?? '',
    icon: '/icons/icon-192.png',   // optionnel
    badge: '/icons/badge-72.png',  // optionnel
    data: { url: data.url ?? '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const origin = self.location.origin;
      const absolute = new URL(targetUrl, origin).href;
      for (const client of clientList) {
        if (client.url === absolute) {
          client.focus();
          return;
        }
      }
      return clients.openWindow(absolute);
    })
  );
});
