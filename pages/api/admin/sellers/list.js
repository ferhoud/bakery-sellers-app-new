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


export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const { admin } = ctx;

  // Try RPC list_sellers first (your project already uses it)
  let sellers = null;
  let rpcErr = null;
  try {
    const { data, error } = await admin.rpc("list_sellers");
    if (error) rpcErr = error;
    else sellers = data;
  } catch (e) {
    rpcErr = e;
  }

  // Fallback to profiles
  if (!sellers) {
    const { data, error } = await admin
      .from("profiles")
      .select("user_id, full_name, role, active")
      .neq("role", "admin")
      .neq("role", "supervisor")
      .order("full_name", { ascending: true });

    if (error) return res.status(500).json({ ok: false, error: error.message || "profiles query failed" });
    sellers = data || [];
  }

  // Enrich with auth email
  const enriched = await Promise.all(
    (sellers || []).map(async (p) => {
      const user_id = p.user_id || p.id || p.userId;
      if (!user_id) return null;
      let email = "";
      let last_sign_in_at = null;

      try {
        const { data, error } = await admin.auth.admin.getUserById(user_id);
        if (!error && data?.user) {
          email = data.user.email || "";
          last_sign_in_at = data.user.last_sign_in_at || null;
        }
      } catch (_) {}

      return {
        user_id,
        full_name: p.full_name || "",
        role: p.role || "seller",
        active: p.active !== false,
        email,
        last_sign_in_at,
      };
    })
  );

  return res.status(200).json({ ok: true, sellers: enriched.filter(Boolean) });
}
