// pages/api/admin/users/delete.js
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  try {
    // 1) purger données applicatives (ordre pour éviter FK)
    await supabaseAdmin.from("replacement_interest").delete().eq("volunteer_id", user_id);
    await supabaseAdmin.from("replacement_interest").delete().eq("absence_id",
      supabaseAdmin.from("absences").select("id").eq("seller_id", user_id)
    ); // si FK, tu peux avoir un trigger ON DELETE CASCADE; sinon garde la ligne précédente uniquement.

    await supabaseAdmin.from("shifts").delete().eq("seller_id", user_id);
    await supabaseAdmin.from("absences").delete().eq("seller_id", user_id);
    await supabaseAdmin.from("leaves").delete().eq("seller_id", user_id);
    await supabaseAdmin.from("sellers").delete().eq("user_id", user_id);
    await supabaseAdmin.from("profiles").delete().eq("user_id", user_id);

    // 2) supprimer le compte auth
    const { error: eA } = await supabaseAdmin.auth.admin.deleteUser(user_id);
    if (eA) throw eA;

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "delete failed" });
  }
}
