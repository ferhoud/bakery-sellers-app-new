// pages/api/admin/users/create.js
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { full_name, identifier, email, password } = req.body || {};
  if (!full_name || !email || !password) return res.status(400).json({ error: "Missing fields" });

  try {
    // 1) créer l’utilisateur auth
    const { data: user, error: e1 } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, identifier: identifier || null },
      app_metadata: { role: "seller" },
    });
    if (e1) throw e1;
    const uid = user.user?.id;

    // 2) insérer profile
    const { error: e2 } = await supabaseAdmin.from("profiles").upsert({
      user_id: uid,
      full_name,
      role: "seller",
      active: true,
      email, // si ta table profiles a cette colonne
    }, { onConflict: "user_id" });
    if (e2) throw e2;

    // 3) insérer dans sellers si tu as une table dédiée
    try {
      await supabaseAdmin.from("sellers").upsert({ user_id: uid }, { onConflict: "user_id" });
    } catch {}

    return res.json({ ok: true, user_id: uid });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "create failed" });
  }
}
