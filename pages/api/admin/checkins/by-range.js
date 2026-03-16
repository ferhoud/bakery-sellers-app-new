// pages/api/admin/checkins/by-range.js
// Retourne les retards/avances confirmés sur une plage, via service role.

import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1] : "";
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

function clampMinuteValue(n) {
  const v = Number(n || 0) || 0;
  if (v < 0) return 0;
  return Math.min(v, 360);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

    const token = getBearer(req);
    if (!token) return json(res, 401, { ok: false, error: "NO_AUTH" });

    const sbAnon = anonClient();
    const admin = adminClient();
    if (!sbAnon || !admin) return json(res, 500, { ok: false, error: "MISSING_SUPABASE_ENV" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(token);
    const user = au?.user || null;
    if (auErr || !user) return json(res, 401, { ok: false, error: "BAD_AUTH" });

    let isAdmin = false;
    try {
      isAdmin = !!isAdminEmail(user.email || "");
    } catch {}

    if (!isAdmin) {
      const { data: prof } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (String(prof?.role || "").toLowerCase() === "admin") isAdmin = true;
    }

    if (!isAdmin) return json(res, 403, { ok: false, error: "FORBIDDEN" });

    const q = req.query || {};
    const from = String(q.from || q.start || "").slice(0, 10);
    const to = String(q.to || q.end || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return json(res, 400, { ok: false, error: "BAD_RANGE" });
    }

    const { data: rows, error } = await admin
      .from("daily_checkins")
      .select("seller_id, day, confirmed_at, late_minutes, early_minutes")
      .gte("day", from)
      .lte("day", to)
      .not("confirmed_at", "is", null)
      .order("day", { ascending: true });

    if (error) return json(res, 500, { ok: false, error: error.message || "CHECKINS_READ_FAILED" });

    const items = (rows || []).map((r) => ({
      seller_id: r.seller_id,
      day: r.day,
      confirmed_at: r.confirmed_at,
      late_minutes: clampMinuteValue(r.late_minutes),
      early_minutes: clampMinuteValue(r.early_minutes),
    }));

    return json(res, 200, { ok: true, from, to, items });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "SERVER_ERROR" });
  }
}
