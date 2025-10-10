// pages/api/admin/create-seller.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const { full_name, email, password } = req.body || {};
  if (!full_name || !email || !password) {
    return res.status(400).json({ error: "full_name, email et password sont requis." });
  }

  // 1) Crée l'utilisateur
  const { data: userData, error: createErr } = await admin.auth.admin.createUser({
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

  // 2) Upsert profil avec fallbacks (table + clé)
  const attempts = [
    { table: "profiles", key: "user_id", row: { user_id: user.id, full_name, role: "seller" } },
    { table: "profiles", key: "id",      row: { id:      user.id, full_name, role: "seller" } },
    { table: "profile",  key: "user_id", row: { user_id: user.id, full_name, role: "seller" } },
    { table: "profile",  key: "id",      row: { id:      user.id, full_name, role: "seller" } },
  ];

  let lastErr = null;

  for (const a of attempts) {
    const { error } = await admin.from(a.table).upsert(a.row, { onConflict: a.key });

    if (!error) {
      // OK
      return res.status(200).json({ ok: true, user_id: user.id, email: user.email, profile_table: a.table, conflict_key: a.key });
    }

    // Garde la dernière erreur pour debug
    lastErr = {
      table: a.table,
      key: a.key,
      code: error?.code,
      message: error?.message,
      details: error?.details,
      hint: error?.hint,
    };

    // Cas typiques :
    // - 42P01: table n'existe pas → on tente la suivante
    // - 42703: colonne n'existe pas → on tente l'autre clé (id vs user_id)
    // - 42P10: "no unique or exclusion constraint matching the ON CONFLICT" → on tentera la variante suivante
    if (error?.code === "42P01" || error?.code === "42703" || error?.code === "42P10") {
      continue;
    } else {
      // Autre erreur bloquante → inutile d'insister sur cette table
      continue;
    }
  }

  // 3) Si on arrive ici, tous les essais ont échoué
  console.error("[create-seller] Upsert profil KO (toutes variantes):", lastErr);
  return res.status(500).json({
    error: "Upsert profil a échoué (fallback épuisé)",
    ...lastErr,
  });
}
