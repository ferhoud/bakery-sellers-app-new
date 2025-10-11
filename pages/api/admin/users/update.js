// pages/api/admin/users/update.js
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { user_id, full_name, email } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  try {
    if (email) {
      const { error: e1 } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
        email,
        email_confirm: true,
      });
      if (e1) throw e1;
    }

    if (full_name || email) {
      const patch = {};
      if (full_name) patch.full_name = full_name;
      if (email)     patch.email = email;
      const { error: e2 } = await supabaseAdmin.from("profiles").update(patch).eq("user_id", user_id);
      if (e2) throw e2;
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "update failed" });
  }
}
