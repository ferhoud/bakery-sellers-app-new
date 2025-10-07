// pages/push-setup.js
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase-browser';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = typeof window !== 'undefined'
    ? window.atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i);
  return out;
}

async function ensurePushSubscription(role = 'admin') {
  const isStandalone =
    (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (typeof navigator !== 'undefined' && 'standalone' in navigator && navigator.standalone);

  if (typeof navigator === 'undefined') return { ok: false, reason: 'no-window' };
  if (!('serviceWorker' in navigator)) return { ok: false, reason: 'no-service-worker' };
  if (typeof Notification === 'undefined') return { ok: false, reason: 'no-notification-api' };
  if (!('PushManager' in window)) {
    return { ok: false, reason: isStandalone ? 'no-pushmanager-standalone' : 'no-pushmanager-browser' };
  }

  const registration = await navigator.serviceWorker.register('/sw.js');

  let permission = Notification.permission;
  if (permission !== 'granted') permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const existing = await registration.pushManager.getSubscription();
  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublic) return { ok: false, reason: 'no-vapid-public-key' };

  const sub = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublic),
  });

  const subJson = sub.toJSON();
  const { data: { user } } = await supabase.auth.getUser();
  const user_id = user?.id ?? null;

  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id,
    role,
    endpoint: sub.endpoint,
    p256dh: subJson.keys.p256dh,
    auth: subJson.keys.auth,
  }, { onConflict: 'endpoint' });

  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

export default function PushSetup() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle');
  const [diag, setDiag] = useState({
    standalone: false,
    hasSW: false,
    hasNotification: false,
    hasPushManager: false,
    permission: 'unknown',
    vapidPresent: !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  });

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setEmail(user?.email || ''));

    const isStandalone =
      (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      (typeof navigator !== 'undefined' && 'standalone' in navigator && navigator.standalone);

    const hasSW = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
    const hasNotification = typeof Notification !== 'undefined';
    const hasPushManager = typeof window !== 'undefined' && 'PushManager' in window;
    const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unknown';

    setDiag((d) => ({
      ...d,
      standalone: !!isStandalone,
      hasSW,
      hasNotification,
      hasPushManager,
      permission,
    }));
  }, []);

  const handleActivate = async () => {
    setStatus('working');
    const r = await ensurePushSubscription('admin');
    setStatus(r.ok ? 'ok' : `fail: ${r.reason || 'unknown'}`);
  };

  return (
    <div style={{padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '0 auto'}}>
      <h1>Activation des notifications admin</h1>
      <p>Utilisateur connecté : <b>{email || '— (connecte-toi sur /admin)'}</b></p>

      <div style={{padding:12, border:'1px solid #e5e7eb', borderRadius:12, background:'#f9fafb', marginBottom:12}}>
        <div><b>Diagnostic (cet appareil)</b></div>
        <ul style={{margin:'8px 0 0 16px'}}>
          <li>Mode : <code>{diag.standalone ? 'standalone (icône écran d’accueil)' : 'navigateur'}</code></li>
          <li>Service Worker : <code>{String(diag.hasSW)}</code></li>
          <li>Notification API : <code>{String(diag.hasNotification)}</code> (permission: <code>{diag.permission}</code>)</li>
          <li>PushManager : <code>{String(diag.hasPushManager)}</code></li>
          <li>VAPID public présent : <code>{String(diag.vapidPresent)}</code></li>
        </ul>
      </div>

      {!diag.standalone && (
        <div style={{padding:12, border:'1px solid #fde68a', borderRadius:12, background:'#fffbeb', marginBottom:12}}>
          <b>iPhone/iOS :</b> installe l’app sur l’écran d’accueil depuis <b>Safari</b>, puis relance via l’icône.
        </div>
      )}

      <button onClick={handleActivate} style={{padding:'10px 16px', fontSize:16, cursor:'pointer'}}>
        🔔 Activer les notifications admin
      </button>

      <p style={{marginTop:12}}>
        Statut : <b>{status}</b>
      </p>
    </div>
  );
}
