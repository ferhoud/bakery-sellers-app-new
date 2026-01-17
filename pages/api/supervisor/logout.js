// pages/api/supervisor/logout.js
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "../../../lib/admin";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || "";
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
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

    const expected = (process.env.SUPERVISOR_LOGOUT_PASSWORD || "").toString();
    if (!expected) return json(res, 500, { ok: false, error: "Missing SUPERVISOR_LOGOUT_PASSWORD on server" });

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sb = anonClient();
    if (!sb) return json(res, 500, { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" });

    const { data: authData, error: authErr } = await sb.auth.getUser(jwt);
    if (authErr || !authData?.user) return json(res, 401, { ok: false, error: authErr?.message || "Unauthorized" });

    const user = authData.user;

    const admin = adminClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    // Autorisation : admin OU supervisor (mais le mot de passe est demandé quand même)
    const email = (user.email || "").toLowerCase();
    const allowAdmin = isAdminEmail(email);
    const allowSupervisor = !allowAdmin ? await isSupervisor(admin, user.id) : true;
    if (!allowAdmin && !allowSupervisor) return json(res, 403, { ok: false, error: "Forbidden" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const password = (body.password || "").toString();

    if (password !== expected) return json(res, 403, { ok: false, error: "BAD_PASSWORD" });

    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
