import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "../../../../lib/admin";

function getEnv(name) {
  return process.env[name] || "";
}

function getBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  if (!h) return null;
  const s = h.toString();
  if (!s.toLowerCase().startsWith("bearer ")) return null;
  return s.slice(7);
}

async function requireAdmin(req, res) {
  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anon = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const service = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !anon) {
    res.status(500).json({ ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY" });
    return null;
  }
  if (!service) {
    res.status(500).json({ ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
    return null;
  }

  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "Missing Authorization Bearer token" });
    return null;
  }

  // Validate token with anon client
  const supa = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userErr } = await supa.auth.getUser();
  if (userErr || !userData?.user) {
    res.status(401).json({ ok: false, error: "Invalid session" });
    return null;
  }

  const user = userData.user;
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  // Admin check: email allowlist OR profiles.role === 'admin'
  let ok = false;

  const email = (user.email || "").toLowerCase();
  if (email && isAdminEmail(email)) ok = true;

  if (!ok) {
    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!profErr && prof?.role === "admin") ok = true;
  }

  if (!ok) {
    res.status(403).json({ ok: false, error: "Forbidden" });
    return null;
  }

  return { user, admin };
}


function safeStr(x) {
  return (x ?? "").toString();
}

function randomPassword() {
  // 18 chars
  return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 18);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const { admin } = ctx;

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    body = req.body || {};
  }

  const user_id = safeStr(body.user_id).trim();
  if (!user_id) return res.status(400).json({ ok: false, error: "Missing user_id" });

  const full_name = safeStr(body.full_name).trim();
  const active = typeof body.active === "boolean" ? body.active : null;
  const email = safeStr(body.email).trim();
  const password = safeStr(body.password);
  const disable = !!body.disable;

  try {
    // Update profiles (name + active)
    const profPatch = {};
    if (full_name) profPatch.full_name = full_name;
    if (active !== null) profPatch.active = active;
    if (disable) profPatch.active = false;

    if (Object.keys(profPatch).length) {
      const { error } = await admin.from("profiles").update(profPatch).eq("user_id", user_id);
      if (error) return res.status(400).json({ ok: false, error: error.message });
    }

    // Update auth (email/password)
    const authPatch = {};
    if (email) authPatch.email = email;
    if (password) authPatch.password = password;
    if (disable) authPatch.password = randomPassword();

    if (Object.keys(authPatch).length) {
      const { error } = await admin.auth.admin.updateUserById(user_id, authPatch);
      if (error) return res.status(400).json({ ok: false, error: error.message });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
