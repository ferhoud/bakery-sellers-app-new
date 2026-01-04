self.addEventListener("notificationclick", (event) => {
  event.notification.close(); // ferme la notif cliquée :contentReference[oaicite:3]{index=3}
  const url = event.notification?.data?.url || "/";

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });

    for (const client of allClients) {
      if ("focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(url);
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(url);
  })());
});
