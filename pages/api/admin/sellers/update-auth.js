// pages/api/admin/sellers/update-auth.js
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

function getEnv(name) {
  const v = process.env[name];
  return (v ?? "").toString();
}
function getBearer(req) {
  const h = (req.headers.authorization || "").toString();
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}
async function requireAdmin(req) {
  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anon = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const token = getBearer(req);
  if (!token) return { ok: false, status: 401, error: "Missing Authorization (Bearer token)" };
  if (!url || !anon) return { ok: false, status: 500, error: "Missing Supabase env (URL/ANON)" };

  const supa = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await supa.auth.getUser();
  const user = data?.user;
  if (error || !user) return { ok: false, status: 401, error: "Invalid session" };

  const email = (user.email || "").toLowerCase();
  let isAdmin = isAdminEmail(email);

  if (!isAdmin) {
    const { data: prof } = await supa.from("profiles").select("role").eq("user_id", user.id).maybeSingle();
    if (prof?.role === "admin") isAdmin = true;
  }
  if (!isAdmin) return { ok: false, status: 403, error: "Forbidden" };
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const gate = await requireAdmin(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const service = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!service) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const body = req.body || {};
    const user_id = (body.user_id || "").toString();
    const email = (body.email || "").toString().trim().toLowerCase();
    const password = (body.password || "").toString();

    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!email && !password) return res.status(400).json({ error: "Nothing to update" });

    const payload = {};
    if (email) {
      payload.email = email;
      // évite d'attendre une confirmation email si ta config l'impose
      payload.email_confirm = true;
    }
    if (password) payload.password = password;

    const { data, error } = await admin.auth.admin.updateUserById(user_id, payload);
    if (error) throw error;

    return res.status(200).json({ ok: true, user: { id: data?.user?.id, email: data?.user?.email } });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
