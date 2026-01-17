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

    const authed = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: userData, error: userErr } = await authed.auth.getUser();
    const user = userData?.user || null;
    if (userErr || !user) return res.status(401).json({ error: "Invalid session" });

    const email = (user.email || "").toLowerCase();
    if (!isAdminEmail(email)) return res.status(403).json({ error: "Admin only" });

    const body = req.body || {};
    const supervisor_id = (body.supervisor_id || "").toString();
    const full_name = (body.full_name || "").toString().trim();
    const active = body.active === false ? false : !!body.active;
    const newEmail = body.email ? body.email.toString().trim().toLowerCase() : "";
    const newPass = body.password ? body.password.toString() : "";

    if (!supervisor_id) return res.status(400).json({ error: "Missing supervisor_id" });
    if (!full_name) return res.status(400).json({ error: "Full name required" });
    if (newEmail && !newEmail.includes("@")) return res.status(400).json({ error: "Invalid email" });
    if (newPass && newPass.length < 6) return res.status(400).json({ error: "Password too short" });

    const admin = createClient(url, service);

    if (newEmail || newPass) {
      const payload = {};
      if (newEmail) payload.email = newEmail;
      if (newPass) payload.password = newPass;
      const { error: uErr } = await admin.auth.admin.updateUserById(supervisor_id, payload);
      if (uErr) return res.status(500).json({ error: uErr.message });
    }

    const { error: pErr } = await admin
      .from("profiles")
      .update({ full_name, active })
      .eq("user_id", supervisor_id)
      .eq("role", "supervisor");

    if (pErr) return res.status(500).json({ error: pErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
