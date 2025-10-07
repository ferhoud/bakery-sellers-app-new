// pages/api/admin/users/delete.js
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { user_id, hard } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const supa = getSupabaseAdmin();

    if (hard) {
      // Hard delete Auth user
      const { error: dErr } = await supa.auth.admin.deleteUser(user_id);
      if (dErr) return res.status(500).json({ error: 'auth delete failed: ' + dErr.message });

      // Conserver le profil pour l’historique ? En général on le garde.
      // Si tu préfères le marquer inactif :
      await supa.from('profiles').update({ active: false }).eq('user_id', user_id);
    } else {
      // Soft delete (suspension + inactive)
      const { error: banErr } = await supa.auth.admin.updateUserById(user_id, { banned_until: '9999-12-31T00:00:00Z' });
      if (banErr) return res.status(500).json({ error: 'auth ban failed: ' + banErr.message });
      await supa.from('profiles').update({ active: false }).eq('user_id', user_id);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
