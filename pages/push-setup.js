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
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

async function ensurePushSubscription(role = 'admin') {
  if (typeof window === 'undefined') return { ok: false, reason: 'ssr' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' };
  }

  // 1) SW
  const registration = await navigator.serviceWorker.register('/sw.js');

  // 2) Permission
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'denied' };

  // 3) Subscribe
  const existing = await registration.pushManager.getSubscription();
  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const sub = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublic),
  });

  // 4) Save in DB
  const subJson = sub.toJSON();
  const { data: { user } } = await supabase.auth.getUser();
  const user_id = user?.id ?? null;

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({
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

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setEmail(user?.email || ''));
  }, []);

  const handleActivate = async () => {
    setStatus('working');
    const r = await ensurePushSubscription('admin');
    setStatus(r.ok ? 'ok' : `fail: ${r.reason || 'unknown'}`);
  };

  return (
    <div style={{padding: 24, fontFamily: 'system-ui, sans-serif'}}>
      <h1>Activation des notifications admin</h1>
      <p>Utilisateur connecté : <b>{email || '— (connecte-toi sur /admin)'}</b></p>
      <ol>
        <li>Ouvre <code>/admin</code> et connecte-toi en <b>admin</b>.</li>
        <li>Revient ici et clique, puis <b>accepte</b> la permission.</li>
      </ol>
      <button onClick={handleActivate} style={{padding:'8px 16px', fontSize:16, cursor:'pointer'}}>
        🔔 Activer les notifications admin
      </button>
      <p style={{marginTop:12}}>Statut : <b>{status}</b></p>
    </div>
  );
}
