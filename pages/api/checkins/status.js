// pages/api/checkins/status.js
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

function parisTimeHMSS(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mm = parts.find((p) => p.type === "minute")?.value || "00";
  const ss = parts.find((p) => p.type === "second")?.value || "00";
  return `${hh}:${mm}:${ss}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sbAnon = anonClient();
    if (!sbAnon) return json(res, 500, { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
    if (auErr || !au?.user) return json(res, 401, { ok: false, error: auErr?.message || "Unauthorized" });

    const user = au.user;

    const admin = adminClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const q = req.query || {};
    const day = (q.day || parisTodayISO()).toString().slice(0, 10);

    // Planifiée aujourd'hui ?
    const { data: shifts, error: shErr } = await admin
      .from("shifts")
      .select("shift_code")
      .eq("date", day)
      .eq("seller_id", user.id)
      .limit(1);

    if (shErr) return json(res, 500, { ok: false, error: shErr.message });

    const shiftCode = shifts?.[0]?.shift_code || null;
    if (!shiftCode) {
      return json(res, 200, {
        ok: true,
        day,
        now_hms: parisTimeHMSS(),
        scheduled: false,
        issued: false,
        confirmed: false,
        late_minutes: 0,
        early_minutes: 0,
        shift_code: null,
      });
    }

    const { data: row, error: rErr } = await admin
      .from("daily_checkins")
      .select("confirmed_at, late_minutes, early_minutes, shift_code")
      .eq("day", day)
      .eq("seller_id", user.id)
      .maybeSingle();

    if (rErr) return json(res, 500, { ok: false, error: rErr.message });

    return json(res, 200, {
      ok: true,
      day,
      now_hms: parisTimeHMSS(),
      scheduled: true,
      issued: !!row,
      confirmed: !!row?.confirmed_at,
      late_minutes: Number(row?.late_minutes || 0) || 0,
      early_minutes: Number(row?.early_minutes || 0) || 0,
      shift_code: row?.shift_code || shiftCode,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
