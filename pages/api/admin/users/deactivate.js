// pages/api/admin/users/deactivate.js
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  try {
    // 1) bloquer l’accès (ban long)
    const { error: e1 } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
      ban_duration: "100y",
    });
    if (e1) throw e1;

    // 2) set active=false dans profiles
    const { error: e2 } = await supabaseAdmin.from("profiles").update({ active: false }).eq("user_id", user_id);
    if (e2) throw e2;

    // 3) la retirer des affectations futures si besoin (optionnel)
    // await supabaseAdmin.from("shifts").update({ seller_id: null }).gte("date", new Date().toISOString().slice(0,10)).eq("seller_id", user_id);

    // 4) la retirer de la table sellers (sans supprimer l’historique)
    try { await supabaseAdmin.from("sellers").delete().eq("user_id", user_id); } catch {}

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "deactivate failed" });
  }
}
