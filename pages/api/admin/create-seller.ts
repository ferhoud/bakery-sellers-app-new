import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // ⚠️ service role
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  // 1) Sécurité simple : vérifier que l’appel vient d’un admin connecté
  // (selon ton setup, tu peux vérifier un cookie, ou re-checker le profil via l'anon client + RLS)
  // Ici on assume que tu as déjà un middleware/guard côté admin.

  const { full_name, email, password } = req.body as {
    full_name: string;
    email: string;
    password: string;
  };

  if (!full_name || !email || !password) {
    return res.status(400).json({ error: "full_name, email, password requis" });
  }

  // 2) Créer l’utilisateur Auth
  const { data: userData, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // pas besoin d’email de confirmation
    user_metadata: { full_name },
    app_metadata: { role: "seller" },
  });
  if (error) return res.status(400).json({ error: error.message });

  // 3) Option A: si tu as déjà le trigger "profiles on auth.users", rien à faire.
  // Option B: sinon, insère le profil manuellement :
  const uid = userData.user?.id;
  if (uid) {
    await supabaseAdmin.from("profiles").upsert({
      user_id: uid,
      full_name,
      role: "seller",
    }, { onConflict: "user_id" });
  }

  return res.status(200).json({ ok: true, user_id: uid });
}
