// pages/api/push/save-sub.js
import { supabase } from '@/lib/supabaseClient';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const sub = req.body || {};
    // Dédupli par endpoint
    const endpoint = sub?.endpoint;
    if (!endpoint) return res.status(400).json({ ok: false, error: 'No endpoint' });

    // Optionnel: lier à l’utilisateur courant si tu veux
    // const { data: { user } } = await supabase.auth.getUser();

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        { endpoint, subscription: sub },     // + (user_id: user?.id) si tu veux
        { onConflict: 'endpoint' }
      );
    if (error) throw error;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
