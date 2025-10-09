import { createClient } from '@supabase/supabase-js';

// ⚠ serveur uniquement
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { date } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date (YYYY-MM-DD)' });
  }

  // Auth: récupérer l’utilisateur appelant via le token client
  const supaAuth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: req.headers.authorization || '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );

  const { data: { user }, error: authErr } = await supaAuth.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const userId = user.id;

  // 1) IDs d’absences pour CET utilisateur à cette date
  const { data: absRows, error: selErr } = await supabaseAdmin
    .from('absences').select('id')
    .eq('seller_id', userId).eq('date', date);
  if (selErr) return res.status(500).json({ error: selErr.message });

  const ids = (absRows || []).map(r => r.id);
  if (!ids.length) return res.status(200).json({ ok: true, absencesDeleted: 0, replacementsDeleted: 0 });

  // 2) Supprimer d’abord les remplacements liés
  const { error: delRiErr, count: replCount } = await supabaseAdmin
    .from('replacement_interest').delete({ count: 'exact' })
    .in('absence_id', ids);
  if (delRiErr) return res.status(500).json({ error: delRiErr.message });

  // 3) Supprimer les absences
  const { error: delAbsErr, count: absCount } = await supabaseAdmin
    .from('absences').delete({ count: 'exact' })
    .in('id', ids);
  if (delAbsErr) return res.status(500).json({ error: delAbsErr.message });

  return res.status(200).json({ ok: true, absencesDeleted: absCount ?? 0, replacementsDeleted: replCount ?? 0 });
}
