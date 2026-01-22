// pages/api/checkins/confirm.js
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

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

function parisTodayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sbAnon = anonClient();
    if (!sbAnon) return json(res, 500, { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
    if (auErr || !au?.user) return json(res, 401, { ok: false, error: auErr?.message || "Unauthorized" });

    const user = au.user;

    const admin = adminClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const code = (body.code || "").toString().trim();
    const day = (body.day || parisTodayISO()).toString().slice(0, 10);

    if (!code) return json(res, 400, { ok: false, error: "Missing code" });

    // Doit être planifiée ce jour-là
    const { data: shifts, error: shErr } = await admin
      .from("shifts")
      .select("shift_code")
      .eq("date", day)
      .eq("seller_id", user.id)
      .limit(1);

    if (shErr) return json(res, 500, { ok: false, error: shErr.message });
    if (!shifts?.[0]?.shift_code) return json(res, 403, { ok: false, error: "NOT_SCHEDULED_TODAY" });

    const pepper = (process.env.CHECKIN_CODE_PEPPER || "").toString();
    const codeHash = sha256Hex(`${pepper}:${code}`);

    const { data: row, error: rErr } = await admin
      .from("daily_checkins")
      .select("id,code_hash,confirmed_at,late_minutes,early_minutes,shift_code")
      .eq("day", day)
      .eq("seller_id", user.id)
      .maybeSingle();

    if (rErr) return json(res, 500, { ok: false, error: rErr.message });
    if (!row?.id) return json(res, 404, { ok: false, error: "NO_CODE_ISSUED" });

    if (row.code_hash !== codeHash) return json(res, 403, { ok: false, error: "BAD_CODE" });

    if (!row.confirmed_at) {
      const { error: uErr } = await admin
        .from("daily_checkins")
        .update({ confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.id);

      if (uErr) return json(res, 500, { ok: false, error: uErr.message });
    }

    return json(res, 200, {
      ok: true,
      day,
      shift_code: row.shift_code,
      late_minutes: row.late_minutes || 0,
      early_minutes: row.early_minutes || 0,
      already_confirmed: !!row.confirmed_at,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
