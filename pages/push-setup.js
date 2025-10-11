// pages/push-setup.js
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getExistingSubscription, ensurePushEnabled } from '@/utils/push';

export default function PushSetup() {
  const [status, setStatus] = useState('checking'); // 'enabled' | 'disabled' | 'unsupported'
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (typeof window === 'undefined') return;
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
          if (mounted) setStatus('unsupported');
          return;
        }
        const sub = await getExistingSubscription();
        if (!mounted) return;
        setStatus(Notification.permission === 'granted' && sub ? 'enabled' : 'disabled');
      } catch {
        if (mounted) setStatus('disabled');
      }
    })();
    return () => { mounted = false; };
  }, []);

  const onEnable = async () => {
    setError('');
    try {
      await ensurePushEnabled(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
      setStatus('enabled');
      alert('Notifications activées ✅');
    } catch (e) {
      setError(e?.message || "Impossible d’activer les notifications");
      setStatus('disabled');
    }
  };

  return (
    <div className="p-4 max-w-xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/admin" className="btn">← Retour Admin</Link>
        <h1 className="hdr">Notifications</h1>
      </div>

      {status === 'checking' && <div className="text-sm text-gray-600">Vérification en cours…</div>}

      {status === 'unsupported' && (
        <div className="text-sm">
          Ce navigateur ne supporte pas les notifications push sur le web.
        </div>
      )}

      {status === 'enabled' && (
        <div className="text-sm">🔔 Notifications déjà activées sur cet appareil.</div>
      )}

      {status === 'disabled' && (
        <button className="btn" onClick={onEnable}>
          🔔 Activer les notifications
        </button>
      )}

      {error && <div className="text-sm text-red-600">{error}</div>}
    </div>
  );
}
