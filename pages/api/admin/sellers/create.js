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

function safeStr(x) {
  return (x ?? "").toString();
}

function isValidEmail(email) {
  const e = safeStr(email).trim();
  return e.includes("@") && e.includes(".");
}

async function requireAdmin(req, res) {
  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anon = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const service = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !anon) {
    res
      .status(500)
      .json({ ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY" });
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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const { admin } = ctx;

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    body = req.body || {};
  }

  const full_name = safeStr(body.full_name).trim();
  const email = safeStr(body.email).trim();
  const password = safeStr(body.password);

  if (!full_name) return res.status(400).json({ ok: false, error: "Missing full_name" });
  if (!email || !isValidEmail(email)) return res.status(400).json({ ok: false, error: "Invalid email" });
  if (!password || password.length < 6)
    return res.status(400).json({ ok: false, error: "Password too short (min 6)" });

  try {
    // Create Auth user (email confirmed so the seller can login immediately)
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });

    if (createErr || !created?.user?.id) {
      return res.status(400).json({ ok: false, error: createErr?.message || "Auth create failed" });
    }

    const user_id = created.user.id;

    // Create / upsert profile
    const { error: profErr } = await admin
      .from("profiles")
      .upsert(
        {
          user_id,
          full_name,
          role: "seller",
          active: true,
        },
        { onConflict: "user_id" }
      );

    if (profErr) {
      // If profile insert fails, we keep the auth user, but report error.
      return res.status(400).json({ ok: false, error: profErr.message || "Profile upsert failed" });
    }

    return res.status(200).json({ ok: true, user_id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
