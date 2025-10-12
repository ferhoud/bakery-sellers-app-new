import { createClient } from '@supabase/supabase-js';

// serveur uniquement
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function getAuthUser(req) {
  const supaAuth = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: req.headers.authorization || '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
  const { data: { user }, error } = await supaAuth.auth.getUser();
  if (error || !user) return null;
  return user;
}

export default async function handler(req, res) {
  // --- GET = peek/debug ---
  if (req.method === 'GET') {
    const user = await getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const date = String(req.query.date || '').trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid or missing date (YYYY-MM-DD)' });
    }
    const { data: absRows, error: selErr } = await supabaseAdmin
      .from('absences').select('id, seller_id, date, status')
      .eq('seller_id', user.id).eq('date', date);
    if (selErr) return res.status(500).json({ error: selErr.message });
    return res.status(200).json({
      ok: true,
      mode: 'peek',
      projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      userId: user.id,
      date,
      found: (absRows || []).map(r => ({ id: r.id, status: r.status })),
      count: absRows?.length || 0
    });
  }

  // --- POST = suppression ---
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { date } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date (YYYY-MM-DD)' });
  }

  const { data: absRows, error: selErr } = await supabaseAdmin
    .from('absences').select('id, admin_forced')
    .eq('seller_id', user.id).eq('date', date);
  if (selErr) return res.status(500).json({ error: selErr.message });

  // ⛔ Garde-fou serveur : pas d’annulation si admin_forced = true
  if ((absRows || []).some(r => r.admin_forced)) {
    return res.status(403).json({ error: "Cette absence a été définie par l’admin et ne peut pas être annulée." });
  }

  const ids = (absRows || []).map(r => r.id);
  if (!ids.length) {
    return res.status(200).json({
      ok: true,
      projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      userId: user.id,
      date,
      absencesDeleted: 0,
      replacementsDeleted: 0
    });
  }

  const { error: delRiErr, count: replCount } = await supabaseAdmin
    .from('replacement_interest').delete({ count: 'exact' })
    .in('absence_id', ids);
  if (delRiErr) return res.status(500).json({ error: delRiErr.message });

  const { error: delAbsErr, count: absCount } = await supabaseAdmin
    .from('absences').delete({ count: 'exact' })
    .in('id', ids);
  if (delAbsErr) return res.status(500).json({ error: delAbsErr.message });

  return res.status(200).json({
    ok: true,
    projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    userId: user.id,
    date,
    absencesDeleted: absCount ?? 0,
    replacementsDeleted: replCount ?? 0
  });
}
