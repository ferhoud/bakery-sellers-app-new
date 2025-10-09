// pages/api/admin/create-seller.ts
// Crée un compte Auth Supabase (email + mot de passe) et le profil associé (role = "seller").
// ⚠️ À appeler uniquement depuis l’interface admin (côté serveur avec Service Role).

import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; // ⚠️ server-only

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
  );
}

// Client admin (service role) — ne jamais l'utiliser côté navigateur
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Body = {
  full_name?: string;
  email?: string;
  password?: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // (Optionnel) Ajoute ta vérif "admin" si nécessaire

  const { full_name, email, password } = (req.body || {}) as Body;

  if (!full_name || !email || !password) {
    return res.status(400).json({ error: "full_name, email et password sont requis." });
  }

  // 1) Créer l'utilisateur Auth (confirmé immédiatement, pas d'email de confirmation)
  const { data: userData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
    app_metadata: { role: "seller" },
  });

  if (createErr) {
    const msg = createErr.message?.toLowerCase().includes("registered")
      ? "Un utilisateur avec cet email existe déjà."
      : createErr.message || "Échec de création de l'utilisateur.";
    return res.status(400).json({ error: msg });
  }

  const user = userData.user;
  if (!user) return res.status(500).json({ error: "Utilisateur créé mais non retourné." });

  // 2) Upsert profil (si pas de trigger automatique)
  const { error: upsertErr } = await supabaseAdmin
    .from("profiles")
    .upsert(
      {
        user_id: user.id,
        full_name: full_name,
        role: "seller",
      },
      { onConflict: "user_id" }
    );

  if (upsertErr) {
    return res.status(500).json({
      error: "Utilisateur créé mais échec lors de l'upsert du profil.",
      user_id: user.id,
    });
  }

  return res.status(200).json({
    ok: true,
    user_id: user.id,
    email: user.email,
  });
}
