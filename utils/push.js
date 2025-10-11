// utils/push.js
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export async function getExistingSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function ensurePushEnabled(vapidPublicKey) {
  const existing = await getExistingSubscription();
  if (Notification.permission === 'granted' && existing) return existing;

  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permission refusée');
  } else if (Notification.permission === 'denied') {
    throw new Error('Permission refusée dans les réglages du navigateur');
  }

  let sub = await getExistingSubscription();
  if (!sub) {
    const reg = await navigator.serviceWorker.ready;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY),
    });
  }

  await fetch('/api/push/save-sub', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub),
  });

  return sub;
}
