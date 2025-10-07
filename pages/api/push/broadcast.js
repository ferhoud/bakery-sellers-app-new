// pages/api/push/broadcast.js
import webpush from 'web-push';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function ensureVAPID() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) throw new Error('VAPID keys missing');
  webpush.setVapidDetails('mailto:admin@example.com', publicKey, privateKey);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    ensureVAPID();
    const { title = 'Notification', body = 'Mise à jour', url = '/admin' } = req.body || {};

    const supabase = getSupabaseAdmin();
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'DB list failed' });

    const payload = JSON.stringify({ title, body, data: { url } });

    const results = await Promise.allSettled(
      (subs || []).map(s => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload))
    );

    // Nettoyage des endpoints invalides
    const toRemove = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const code = r.reason?.statusCode;
        if (code === 404 || code === 410) toRemove.push(subs[i].endpoint);
      }
    });
    if (toRemove.length) {
      await supabase.from('push_subscriptions').delete().in('endpoint', toRemove);
    }

    return res.status(200).json({
      ok: true,
      sent: results.filter(r => r.status === 'fulfilled').length,
      removed: toRemove.length,
      total: subs?.length || 0
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Broadcast failed' });
  }
}
