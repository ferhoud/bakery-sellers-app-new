// pages/api/push/broadcast.js  (Pages Router)
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails('mailto:postmaster@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { title, body, url, role = 'admin' } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Missing title' });

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('role', role);

    if (error) return res.status(500).json({ error: error.message });

    const payload = JSON.stringify({ title, body, url });
    let sent = 0;

    await Promise.allSettled(
      (subs || []).map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          );
          sent++;
        } catch (e) {
          const status = e.statusCode || e.status || 0;
          if (status === 404 || status === 410) {
            await supabase.from('push_subscriptions').delete().eq('id', s.id);
          } else {
            console.warn('[push] send fail', status, e?.message);
          }
        }
      })
    );

    return res.status(200).json({ sent, total: subs?.length || 0 });
  } catch (e) {
    console.error('[push] handler error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
