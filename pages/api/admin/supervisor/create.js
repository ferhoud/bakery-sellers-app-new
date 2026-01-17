// pages/api/admin/supervisor/create.js
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

function getEnv(name) {
  return process.env[name] || "";
}
function getBearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anon = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    const service = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon) return res.status(500).json({ error: "Missing Supabase env" });
    if (!service) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const jwt = getBearer(req);
    if (!jwt) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    // Verify caller (admin)
    const authed = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: userData, error: userErr } = await authed.auth.getUser();
    const caller = userData?.user || null;
    if (userErr || !caller) return res.status(401).json({ error: "Invalid session" });

    const callerEmail = (caller.email || "").toLowerCase();
    if (!isAdminEmail(callerEmail)) return res.status(403).json({ error: "Admin only" });

    const body = req.body || {};
    const supEmail = (body.email || "").toString().trim().toLowerCase();
    const password = (body.password || "").toString();
    const full_name = (body.full_name || "").toString().trim();

    if (!supEmail.includes("@")) return res.status(400).json({ error: "Invalid email" });
    if (password.length < 6) return res.status(400).json({ error: "Password too short" });
    if (!full_name) return res.status(400).json({ error: "Full name required" });

    const admin = createClient(url, service);

    // Enforce: ONE supervisor (by profiles)
    const { data: existing, error: exErr } = await admin
      .from("profiles")
      .select("user_id")
      .eq("role", "supervisor")
      .limit(1)
      .maybeSingle();

    if (exErr) return res.status(500).json({ error: exErr.message });
    if (existing?.user_id) return res.status(409).json({ error: "Supervisor already exists" });

    // Create Auth user
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: supEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });

    if (cErr) {
      // Common case: email already exists
      const msg = cErr.message || "Auth createUser failed";
      if (msg.toLowerCase().includes("already been registered")) {
        return res.status(409).json({
          error:
            "Email déjà enregistré dans Auth. Supprime l'utilisateur dans Supabase Auth (ou choisis un autre email), puis réessaie.",
        });
      }
      return res.status(500).json({ error: msg });
    }

    const uid = created?.user?.id;
    if (!uid) return res.status(500).json({ error: "User creation failed" });

    // Create profile row (role supervisor)
    const { error: pErr } = await admin.from("profiles").upsert({
      user_id: uid,
      full_name,
      role: "supervisor",
      active: true,
    });

    if (pErr) {
      // ROLLBACK: remove auth user to avoid "email already registered" on retry
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch {
        // ignore rollback errors
      }
      return res.status(500).json({
        error:
          `Création profil superviseur refusée: ${pErr.message}. ` +
          `J'ai supprimé l'utilisateur Auth créé pour éviter un doublon. ` +
          `=> Corrige la contrainte profiles.role puis réessaie.`,
      });
    }

    return res.status(200).json({ ok: true, user_id: uid });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Server error" });
  }
}
