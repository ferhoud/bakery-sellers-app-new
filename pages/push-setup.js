// pages/push-setup.js
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getExistingSubscription, ensurePushEnabled } from '@/utils/push';

const isBrowser = () => typeof window !== 'undefined';

export default function PushSetup() {
  // 'checking' (détection en cours), 'enabled' (ok), 'disabled' (pas encore activé), 'unsupported' (navigateur)
  const [status, setStatus] = useState('checking');
  const [checking, setChecking] = useState(false);
  const [log, setLog] = useState('');
  const [error, setError] = useState('');

  // Détection après montage (ne bloque jamais le rendu)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!isBrowser()) return;
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
          if (mounted) setStatus('unsupported');
          return;
        }
        const sub = await getExistingSubscription(); // a un timeout interne
        if (!mounted) return;
        const granted = Notification.permission === 'granted';
        setStatus(granted && sub ? 'enabled' : 'disabled');
        setLog(`Permission: ${Notification.permission} · Subscription: ${sub ? 'oui' : 'non'}`);
      } catch {
        if (mounted) setStatus('disabled');
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Fallback : si le check n’aboutit pas, on sort de "checking" au bout de 1,5s
  useEffect(() => {
    const t = setTimeout(() => {
      setStatus((s) => (s === 'checking' ? 'disabled' : s));
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  const checkStatus = async () => {
    setError('');
    setLog('');
    if (!isBrowser()) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
      setStatus('unsupported');
      setLog("Navigateur non compatible avec les notifications push.");
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    const granted = Notification.permission === 'granted';
    setStatus(granted && sub ? 'enabled' : 'disabled');
    setLog(`Permission: ${Notification.permission} · Subscription: ${sub ? 'oui' : 'non'}`);
  };

  const onEnable = async () => {
    setChecking(true);
    setError('');
    setLog('');
    try {
      await ensurePushEnabled(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
      setStatus('enabled');
      setLog('Notifications activées ✅');
      alert('Notifications activées ✅');
    } catch (e) {
      const msg = e?.message || 'Impossible d’activer';
      setError(msg);
      setStatus('disabled');
      setLog(msg);
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

      {status === 'unsupported' && (
        <div className="text-sm">
          Ce navigateur ne supporte pas les notifications push sur le web.
        </div>
      )}

      {status === 'checking' && (
        <div className="text-sm text-gray-600">Vérification en cours…</div>
      )}

      {(status === 'disabled' || status === 'enabled') && (
        <div className="space-y-2">
          <div className="text-sm">
            État : <b>{status === 'enabled' ? 'activées' : 'désactivées'}</b>
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={checkStatus}>Vérifier l’état</button>
            <button className="btn" onClick={onEnable} disabled={checking}>
              {checking ? 'Activation…' : '🔔 Activer les notifications'}
            </button>
          </div>
          {log && <div className="text-sm text-gray-700">{log}</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          <div className="text-xs text-gray-500">
            Astuce : l’autorisation est par navigateur/appareil et par domaine. Sur iOS, installer l’app sur l’écran d’accueil.
          </div>
        </div>
      )}
    </div>
  );
}
