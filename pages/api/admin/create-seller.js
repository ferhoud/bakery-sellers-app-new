// pages/api/admin/create-seller.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const { full_name, email, password } = req.body || {};
  if (!full_name || !email || !password) {
    return res.status(400).json({ error: "full_name, email et password sont requis." });
  }

  // 1) Création de l'utilisateur Auth
  const { data: userData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
    app_metadata: { role: "seller" },
  });
  if (createErr) {
    const msg = (createErr.message || "").toLowerCase().includes("registered")
      ? "Un utilisateur avec cet email existe déjà."
      : createErr.message || "Échec de création de l'utilisateur.";
    return res.status(400).json({ error: msg });
  }

  const user = userData?.user;
  if (!user) return res.status(500).json({ error: "Utilisateur créé mais non retourné." });

  // 2) Profil (DEBUG détaillé pour diagnostiquer l'erreur)
  const { error: upsertErr } = await supabaseAdmin
    .from("profiles")
    .upsert({ user_id: user.id, full_name, role: "seller" }, { onConflict: "user_id" });

  if (upsertErr) {
    console.error("[create-seller] Upsert profils KO:", {
      message: upsertErr.message,
      code: upsertErr.code,
      details: upsertErr.details,
      hint: upsertErr.hint,
    });
    return res.status(500).json({
      error: "Upsert profil a échoué",
      message: upsertErr.message,
      code: upsertErr.code,
      details: upsertErr.details,
      hint: upsertErr.hint,
    });
  }

  // 3) OK
  return res.status(200).json({ ok: true, user_id: user.id, email: user.email });
}
