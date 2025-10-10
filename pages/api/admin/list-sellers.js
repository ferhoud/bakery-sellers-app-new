<<<<<<< HEAD
// pages/api/admin/list-sellers.js
import { createClient } from '@supabase/supabase-js';
=======
﻿import { createClient } from "@supabase/supabase-js";
>>>>>>> deploy-sellers

export default async function handler(req, res) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
<<<<<<< HEAD
      process.env.SUPABASE_SERVICE_ROLE_KEY // clé serveur (PAS NEXT_PUBLIC)
    );

    // ⚠️ On lit bien DANS "profiles" (c'est ce que ton UI attend)
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, full_name, role')
      .order('full_name', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.status(200).json({ sellers: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
=======
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, full_name, role")
      .order("full_name", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ sellers: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
>>>>>>> deploy-sellers
  }
}
