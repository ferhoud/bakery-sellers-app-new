// pages/api/admin/users/update.js
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { user_id, full_name, email, password, color, active, suspend } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const supa = getSupabaseAdmin();

    // 1) Auth updates
    if (email || password || typeof suspend === 'boolean') {
      const payload = {};
      if (email) payload.email = email;
      if (password) payload.password = password;
      if (typeof suspend === 'boolean') {
        payload.banned_until = suspend ? '9999-12-31T00:00:00Z' : null;
      }
      const { error: aErr } = await supa.auth.admin.updateUserById(user_id, payload);
      if (aErr) return res.status(500).json({ error: 'auth update failed: ' + aErr.message });
    }

    // 2) Profile updates
    if (full_name != null || color !== undefined || active !== undefined) {
      const patch = {};
      if (full_name != null) patch.full_name = full_name;
      if (color !== undefined) patch.color = color || null;
      if (active !== undefined) patch.active = !!active;

      patch.user_id = user_id;

      const { error: pErr } = await supa
        .from('profiles')
        .upsert(patch, { onConflict: 'user_id' });
      if (pErr) return res.status(500).json({ error: 'profile update failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
