// pages/push-setup.js
'use client';

import { useEffect, useState, useCallback } from 'react';
import Head from 'next/head';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = typeof window !== 'undefined'
    ? window.atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

export default function PushSetupPage() {
  const [support, setSupport] = useState({ sw: false, push: false, notif: false });
  const [permission, setPermission] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'default');
  const [reg, setReg] = useState(null);
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(false);
  const [serverStatus, setServerStatus] = useState(null);
  const [badgeCount, setBadgeCount] = useState(0);

  // Détection des API
  useEffect(() => {
    const okSW = typeof window !== 'undefined' && 'serviceWorker' in navigator;
    const okPush = typeof window !== 'undefined' && 'PushManager' in window;
    const okNotif = typeof window !== 'undefined' && 'Notification' in window;
    setSupport({ sw: okSW, push: okPush, notif: okNotif });
  }, []);

  // Enregistre le SW + récupère l’abonnement existant
  useEffect(() => {
    let unmounted = false;
    async function init() {
      if (!support.sw) return;
      try {
        // évite double registres
        const existing = await navigator.serviceWorker.getRegistration();
        const registration = existing || (await navigator.serviceWorker.register('/sw.js?v=12'));

        if (unmounted) return;
        setReg(registration);

        // écoute des messages SW (push reçu → info UI)
        const handler = (e) => {
          if (e?.data?.type === 'push') {
            setServerStatus({ type: 'info', text: 'Notification reçue (message SW). L’app peut se rafraîchir.' });
          }
        };
        navigator.serviceWorker.addEventListener('message', handler);

        // abonnement existant ?
        const currentSub = await registration.pushManager.getSubscription();
        if (!unmounted) setSub(currentSub || null);

        return () => {
          try { navigator.serviceWorker.removeEventListener('message', handler); } catch {}
        };
      } catch (err) {
        console.error('SW register error', err);
        setServerStatus({ type: 'error', text: 'Échec enregistrement du Service Worker. Voir console.' });
      }
    }
    init();
    return () => { unmounted = true; };
  }, [support.sw]);

  // Suit l’état de permission
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    setPermission(Notification.permission);
  }, []);

  const askPermission = useCallback(async () => {
    if (!support.notif) return;
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setServerStatus({ type: 'warning', text: 'Permission refusée. Tu peux la réactiver dans les réglages du navigateur.' });
      }
    } catch (e) {
      console.error(e);
      setServerStatus({ type: 'error', text: 'Échec de la demande de permission.' });
    }
  }, [support.notif]);

  const subscribe = useCallback(async () => {
    if (!reg) { setServerStatus({ type: 'error', text: 'Service Worker non prêt.' }); return; }
    if (!VAPID_PUBLIC_KEY) {
      setServerStatus({ type: 'error', text: 'NEXT_PUBLIC_VAPID_PUBLIC_KEY manquante.' });
      return;
    }
    setBusy(true);
    try {
      // permission
      if (permission !== 'granted') {
        const perm = await Notification.requestPermission();
        setPermission(perm);
        if (perm !== 'granted') {
          setBusy(false);
          setServerStatus({ type: 'warning', text: 'Permission non accordée.' });
          return;
        }
      }
      // subscribe
      const applicationServerKey = base64UrlToUint8Array(VAPID_PUBLIC_KEY);
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      setSub(subscription);

      // save server
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `subscribe API ${res.status}`);
      }
      setServerStatus({ type: 'success', text: 'Notifications activées ✔︎' });
    } catch (e) {
      console.error(e);
      setServerStatus({ type: 'error', text: 'Échec de l’activation des notifications.' });
    } finally {
      setBusy(false);
    }
  }, [reg, permission]);

  const unsubscribe = useCallback(async () => {
    if (!sub) return;
    setBusy(true);
    try {
      // serveur
      try {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch (e) {
        console.warn('Server unsubscribe failed (ignored)', e);
      }
      // navigateur
      const ok = await sub.unsubscribe();
      setSub(null);
      setServerStatus({ type: 'success', text: ok ? 'Notifications désactivées.' : 'Désinscription locale échouée.' });
    } catch (e) {
      console.error(e);
      setServerStatus({ type: 'error', text: 'Échec de la désinscription.' });
    } finally {
      setBusy(false);
    }
  }, [sub]);

  // ➜ ENVOI TEST (bouton “Envoyer un test”)
  const sendTest = useCallback(async () => {
    if (!sub) { setServerStatus({ type: 'warning', text: 'Abonne-toi d’abord.' }); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `test API ${res.status}`);
      }
      setServerStatus({ type: 'success', text: 'Push test envoyé. Regarde la notification.' });
    } catch (e) {
      console.error(e);
      setServerStatus({ type: 'error', text: 'Échec de l’envoi test (route API manquante ?).' });
    } finally {
      setBusy(false);
    }
  }, [sub]);

  // Pastille
  const setBadge = useCallback(async (n) => {
    setBadgeCount(n);
    try { if ('setAppBadge' in navigator) await navigator.setAppBadge(n); } catch {}
  }, []);
  const clearBadge = useCallback(async () => {
    setBadgeCount(0);
    try { if ('clearAppBadge' in navigator) await navigator.clearAppBadge(); } catch {}
  }, []);

  return (
    <>
      <Head><title>Configurer les notifications</title></Head>

      <div className="p-4 max-w-2xl mx-auto space-y-6">
        <div className="card">
          <div className="hdr mb-2">Notifications — configuration</div>

          <ul className="text-sm text-gray-700 space-y-1">
            <li>Service Worker : <b>{support.sw ? 'OK' : 'Non dispo'}</b></li>
            <li>Push API : <b>{support.push ? 'OK' : 'Non dispo'}</b></li>
            <li>Notifications : <b>{support.notif ? 'OK' : 'Non dispo'}</b> (permission : <code>{permission}</code>)</li>
            <li>VAPID : <b>{VAPID_PUBLIC_KEY ? 'OK' : 'Manquant'}</b></li>
            <li>Abonnement : <b>{sub ? 'ACTIF' : 'AUCUN'}</b></li>
          </ul>

          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn" onClick={askPermission} disabled={!support.notif || busy}>
              1) Autoriser
            </button>
            <button className="btn" onClick={subscribe} disabled={!support.sw || !support.push || permission !== 'granted' || !!sub || busy}>
              2) Activer les notifications
            </button>
            <button className="btn" onClick={sendTest} disabled={!sub || busy}>
              Envoyer un test
            </button>
            <button className="btn" onClick={unsubscribe} disabled={!sub || busy} style={{ backgroundColor: '#f43f5e', color: '#fff', borderColor: 'transparent' }}>
              Désactiver
            </button>
          </div>

          {serverStatus && (
            <div className="mt-3 text-sm">
              <span className={
                serverStatus.type === 'success' ? 'text-green-700' :
                serverStatus.type === 'warning' ? 'text-amber-700' :
                serverStatus.type === 'info' ? 'text-sky-700' : 'text-red-700'
              }>
                {serverStatus.text}
              </span>
            </div>
          )}
        </div>

        <div className="card">
          <div className="hdr mb-2">Pastille (App Badge)</div>
          <p className="text-sm text-gray-600 mb-2">
            Certaines plateformes (Chrome Desktop/Android, Edge) supportent <code>navigator.setAppBadge</code>.
          </p>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => setBadge(badgeCount + 1)}>+1</button>
            <button className="btn" onClick={() => setBadge(Math.max(0, badgeCount - 1))}>-1</button>
            <button className="btn" onClick={() => setBadge(5)}>Mettre 5</button>
            <button className="btn" onClick={clearBadge}>Effacer</button>
            <span className="text-sm text-gray-700">Valeur locale : <b>{badgeCount}</b></span>
          </div>
        </div>

        <div className="card">
          <div className="hdr mb-2">Débogage</div>
          <ol className="list-decimal pl-5 text-sm space-y-1 text-gray-700">
            <li>Vérifie <code>/sw.js</code> dans <code>public/</code>. Le SW doit faire <code>self.registration.showNotification()</code> sur <code>push</code> et envoyer <code>postMessage({type:"push"})</code> aux clients.</li>
            <li>Routes API :
              <ul className="list-disc pl-5">
                <li><code>POST /api/push/subscribe</code> (Service Role) — enregistre l’abonnement.</li>
                <li><code>POST /api/push/unsubscribe</code> — supprime l’abonnement.</li>
                <li><code>POST /api/push/test</code> — envoie une notif au dernier abonnement ou à l’endpoint fourni.</li>
              </ul>
            </li>
            <li>Sur iOS, les web push nécessitent l’app **ajoutée à l’écran d’accueil** (PWA) + iOS 16.4+.</li>
          </ol>
        </div>
      </div>
    </>
  );
}
