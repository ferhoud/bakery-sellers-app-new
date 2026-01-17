// pages/api/role.js
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "../../lib/admin";

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || "";
}

function json(res, status, body) {
  res.status(status).json(body);
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

async function isSupervisor(admin, userId) {
  const { data, error } = await admin.from("supervisors").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) return false;
  return !!data?.user_id;
}

export default async function handler(req, res) {
  try {
    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sb = anonClient();
    if (!sb) return json(res, 500, { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" });

    const { data, error } = await sb.auth.getUser(jwt);
    if (error || !data?.user) return json(res, 401, { ok: false, error: error?.message || "Unauthorized" });

    const user = data.user;
    const email = (user.email || "").toLowerCase();

    if (isAdminEmail(email)) {
      return json(res, 200, { ok: true, role: "admin", userId: user.id, email });
    }

    const admin = adminClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const sup = await isSupervisor(admin, user.id);
    if (sup) return json(res, 200, { ok: true, role: "supervisor", userId: user.id, email });

    return json(res, 200, { ok: true, role: "seller", userId: user.id, email });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
