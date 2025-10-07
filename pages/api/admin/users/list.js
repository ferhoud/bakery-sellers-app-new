// pages/api/admin/users/list.js
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supa = getSupabaseAdmin();

    // 1) profils role='seller'
    const { data: profs, error: pErr } = await supa
      .from('profiles')
      .select('user_id, full_name, role, color, active')
      .eq('role', 'seller');
    if (pErr) return res.status(500).json({ error: 'profiles read failed' });

    const idSet = profs.map(p => p.user_id);

    // 2) users Auth (admin)
    // listUsers ne filtre pas par IDs → on le fait côté code ; 
    // on itère par pages tant qu'on n'a pas tout (dataset petit dans ton cas).
    const users = [];
    let page = 1;
    // @ts-ignore next line works with supabase-js v2
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return res.status(500).json({ error: 'auth list failed' });
      users.push(...data.users);
      if (!data.users || data.users.length < 1000) break;
      page += 1;
    }

    const byId = Object.fromEntries(users.map(u => [u.id, u]));

    const out = profs.map(p => {
      const u = byId[p.user_id];
      return {
        id: p.user_id,
        email: u?.email || null,
        full_name: p.full_name || null,
        color: p.color || null,
        active: p.active !== false,
        banned_until: u?.banned_until || null,
        created_at: u?.created_at || null,
      };
    });

    return res.status(200).json({ users: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
