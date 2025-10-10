// /api/admin/list-sellers.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // serveur seulement
  );

  const { data, error } = await supabase
    .from('sellers')
    .select('*')
    .order('full_name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ sellers: data });
}
