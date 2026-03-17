// pages/api/admin/checkins/sellers.js
import { createClient } from "@supabase/supabase-js";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1] : null;
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

    const token = getBearer(req);
    if (!token) return json(res, 401, { ok: false, error: "NO_AUTH" });

    const anon = anonClient();
    const admin = adminClient();
    if (!anon || !admin) return json(res, 500, { ok: false, error: "MISSING_SUPABASE_ENV" });

    const { data: authData, error: authErr } = await anon.auth.getUser(token);
    const user = authData?.user || null;
    if (authErr || !user) return json(res, 401, { ok: false, error: "BAD_AUTH" });

    const adminEmail = String(user.email || "").toLowerCase();
    const { data: meProfile } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    const isAdmin = adminEmail === "" ? false : (adminEmail === process.env.NEXT_PUBLIC_ADMIN_EMAIL || meProfile?.role === "admin");
    if (!isAdmin) return json(res, 403, { ok: false, error: "FORBIDDEN" });

    const sellerMap = new Map();

    const { data: sellersRows, error: sellersErr } = await admin
      .from("sellers")
      .select("id, full_name, is_active")
      .order("full_name", { ascending: true });
    if (sellersErr) return json(res, 500, { ok: false, error: sellersErr.message || "SELLERS_FAILED" });

    for (const s of sellersRows || []) {
      if (!s?.id) continue;
      sellerMap.set(s.id, {
        id: s.id,
        full_name: s.full_name || s.id,
        is_active: s.is_active !== false,
      });
    }

    const { data: profileRows, error: profileErr } = await admin
      .from("profiles")
      .select("user_id, full_name, active, role")
      .eq("role", "seller")
      .order("full_name", { ascending: true });
    if (profileErr) return json(res, 500, { ok: false, error: profileErr.message || "PROFILES_FAILED" });

    for (const p of profileRows || []) {
      if (!p?.user_id) continue;
      if (!sellerMap.has(p.user_id)) {
        sellerMap.set(p.user_id, {
          id: p.user_id,
          full_name: p.full_name || p.user_id,
          is_active: p.active !== false,
        });
      }
    }

    const sellers = Array.from(sellerMap.values()).sort((a, b) =>
      String(a.full_name || "").localeCompare(String(b.full_name || ""), "fr")
    );

    return json(res, 200, { ok: true, sellers });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "SERVER_ERROR" });
  }
}
