// utils/push.js
const isBrowser = () => typeof window !== 'undefined';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// Petite aide: Promise avec timeout (pour ne pas bloquer l'UI)
async function withTimeout(promise, ms = 1500) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('sw-timeout')), ms)),
  ]);
}

export async function getExistingSubscription() {
  if (!isBrowser()) return null;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;

  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, 1500);
    return reg?.pushManager?.getSubscription
      ? await reg.pushManager.getSubscription()
      : null;
  } catch {
    // SW pas prêt -> on considère "non abonné" sans bloquer
    return null;
  }
}

export async function ensurePushEnabled(vapidPublicKey) {
  if (!isBrowser()) throw new Error("Fonction client uniquement");
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error("Les notifications ne sont pas supportées par ce navigateur");
  }
  // 1) si déjà ok: on sort
  const existing = await getExistingSubscription();
  if (typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      existing) return existing;

  // 2) permission
  if (typeof Notification === 'undefined') {
    throw new Error("API Notification indisponible");
  }
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permission refusée');
  } else if (Notification.permission === 'denied') {
    throw new Error('Permission refusée dans les réglages du navigateur');
  }

  // 3) (ré)abonnement
  let sub = await getExistingSubscription();
  if (!sub) {
    let reg;
    try {
      // on essaye d’abord ready (rapide), sinon on enregistre /sw.js
      reg = await withTimeout(navigator.serviceWorker.ready, 1500);
    } catch {
      // enregistre le SW si pas déjà prêt
      reg = await navigator.serviceWorker.register('/sw.js');
      // évite d’attendre éternellement ready
      try { await withTimeout(navigator.serviceWorker.ready, 1500); } catch {}
    }

    sub = await reg.pushManager.subscribe({
      us
