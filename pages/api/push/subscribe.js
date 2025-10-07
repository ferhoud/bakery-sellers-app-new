// pages/api/push/subscribe.js
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const sub = req.body; // { endpoint, keys:{ p256dh, auth } }
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    const supabase = getSupabaseAdmin(); // ✅ Service Role → bypass RLS

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          user_id: null, // tu pourras lier à l’utilisateur plus tard si tu veux
        },
        { onConflict: 'endpoint' }
      );

    if (error) {
      console.error('DB upsert failed', error);
      return res.status(500).json({ error: 'DB upsert failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
