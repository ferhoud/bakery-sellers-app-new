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

    const admin = createClient(url, service);

    const { data: prof, error: pErr } = await admin
      .from("profiles")
      .select("user_id, full_name, active, role")
      .eq("role", "supervisor")
      .limit(1)
      .maybeSingle();

    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!prof) return res.status(200).json({ supervisor: null });

    let supEmail = "";
    try {
      const { data: u } = await admin.auth.admin.getUserById(prof.user_id);
      supEmail = u?.user?.email || "";
    } catch {
      supEmail = "";
    }

    return res.status(200).json({
      supervisor: {
        user_id: prof.user_id,
        full_name: prof.full_name || "",
        active: !!prof.active,
        email: supEmail,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
