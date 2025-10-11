// pages/push-setup.js
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getExistingSubscription, ensurePushEnabled } from '@/utils/push';

export default function PushSetup() {
  const [status, setStatus] = useState('checking'); // 'enabled' | 'disabled'
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  useEffect(() => {
    (async () => {
      try {
        const sub = await getExistingSubscription();
        setStatus(Notification.permission === 'granted' && sub ? 'enabled' : 'disabled');
      } catch { setStatus('disabled'); }
    })();
  }, []);

  return (
    <div className="p-4 max-w-xl mx-auto space-y-4">
      <Link href="/admin" className="btn">← Retour Admin</Link>
      <h1 className="hdr">Notifications</h1>

      {status === 'enabled' ? (
        <div className="text-sm">🔔 Notifications déjà activées sur cet appareil.</div>
      ) : (
        <button
          className="btn"
          onClick={async () => {
            try {
              await ensurePushEnabled(vapid);
              setStatus('enabled');
              alert('Notifications activées ✅');
            } catch (e) {
              alert(e?.message || "Impossible d’activer les notifications");
            }
          }}
        >
          🔔 Activer les notifications
        </button>
      )}
    </div>
  );
}
