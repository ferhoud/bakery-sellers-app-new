// pages/push-setup.js
import Link from 'next/link';
import { useState } from 'react';

const isBrowser = () => typeof window !== 'undefined';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function ensurePushEnabled(vapidPublicKey) {
  if (!isBrowser()) throw new Error('Client only');

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error("Navigateur non compatible");
  }

  // Permission
  if (typeof Notification === 'undefined') {
    throw new Error("API Notification indisponible");
  }
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permission refusée');
  } else if (Notification.permission === 'denied') {
    throw new Error("Permission refusée dans les réglages du navigateur");
  }

  // Registre le SW si besoin (sans attendre éternellement)
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    reg = await navigator.serviceWorker.register('/sw.js');
  }

  // Subscription existante ?
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      ),
    });
  }

  // Sauvegarde côté serveur (sans bloquer l’UI si ça échoue)
  try {
    await fetch('/api/push/save-sub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
  } catch { /* no-op */ }

  return sub;
}

export default function PushSetup() {
  const [log, setLog] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [checking, setChecking] = useState(false);

  const checkStatus = async () => {
    setLog('');
    if (!isBrowser()) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
      setLog("Navigateur non compatible avec les notifications push.");
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    const granted = Notification.permission === 'granted';
    setEnabled(Boolean(granted && sub));
    setLog(`Permission: ${Notification.permission} · Subscription: ${sub ? 'oui' : 'non'}`);
  };

  const onEnable = async () => {
    setChecking(true);
    setLog('');
    try {
      await ensurePushEnabled(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
      setEnabled(true);
      setLog('Notifications activées ✅');
      alert('Notifications activées ✅');
    } catch (e) {
      setEnabled(false);
      setLog(e?.message || 'Impossible d’activer');
      alert(e?.message || 'Impossible d’activer');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="p-4 max-w-xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/admin" className="btn">← Retour Admin</Link>
        <h1 className="hdr">Notifications</h1>
      </div>

      <div className="space-y-2">
        <button className="btn" onClick={checkStatus}>Vérifier l’état</button>
        <button className="btn" onClick={onEnable} disabled={checking}>
          {checking ? 'Activation…' : '🔔 Activer les notifications'}
        </button>
        <div className="text-sm text-gray-700">{enabled ? 'État : activées' : 'État : désactivées'}</div>
        {log && <div className="text-sm">{log}</div>}
      </div>
    </div>
  );
}
