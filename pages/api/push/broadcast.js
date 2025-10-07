// pages/api/push/broadcast.js
import webPush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE; // compat
const supabase = createClient(supaUrl, serviceKey);

const VAPID_PUBLIC  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

webPush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(500).json({ error: 'VAPID keys missing' });
  }

  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const role = body.role || 'admin';

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('role', role);

  if (error) {
    return res.status(500).json({ error: 'DB error', details: error.message });
  }

  // ✅ Compteur de pastille (badge) que verra iOS
  const badgeCount = typeof body.badgeCount === 'number' ? body.badgeCount : 1;

  // Charge utile envoyée au Service Worker
  const payload = JSON.stringify({
    title: body.title || 'Nouvelle demande',
    body:  body.body  || '',
    url:   body.url   || '/admin?tab=absences',
    badgeCount: typeof body.badgeCount === 'number' ? body.badgeCount : 1
  });

  let sent = 0;
  const total = subs?.length || 0;

  await Promise.all((subs || []).map(async (s) => {
    try {
      await webPush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      sent++;
    } catch (err) {
      // Nettoie les abonnements expirés
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      }
      // (on ignore les autres erreurs pour ne pas casser l’envoi aux autres)
    }
  }));

  return res.status(200).json({ sent, total });
}
