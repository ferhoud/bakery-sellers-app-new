// pages/api/admin/users/create.js
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { email, password, full_name, color } = req.body || {};
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'full_name, email, password requis' });
    }

    const supa = getSupabaseAdmin();

    // 1) Crée l'utilisateur Auth (email confirmé)
    const { data: created, error: cErr } = await supa.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: 'seller' },
      user_metadata: { full_name },
    });
    if (cErr) return res.status(500).json({ error: 'auth create failed: ' + cErr.message });

    const user_id = created.user?.id;
    if (!user_id) return res.status(500).json({ error: 'no user_id returned' });

    // 2) Upsert profil
    const { error: pErr } = await supa
      .from('profiles')
      .upsert({
        user_id,
        full_name,
        role: 'seller',
        color: color || null,
        active: true,
      }, { onConflict: 'user_id' });
    if (pErr) return res.status(500).json({ error: 'profile upsert failed' });

    return res.status(201).json({ ok: true, user_id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
