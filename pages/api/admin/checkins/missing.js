// pages/api/admin/checkins/missing.js
// Admin-only: liste les vendeuses planifiées aujourd’hui (Europe/Paris) qui n’ont PAS pointé
// après 60 minutes suivant l’heure de début du shift.
// ⚠️ Ne marque pas "absent" : ça sert uniquement à notifier / alerter l’admin.

import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "../../../../lib/admin";

function json(res, status, body) {
  res.status(status).json(body);
}
function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1] : null;
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
function parisNowMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const hh = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const mm = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  return hh * 60 + mm;
}
function shiftStartMinutes(shiftCode) {
  // Tes règles actuelles
  if (shiftCode === "EVENING") return 13 * 60 + 30; // 13:30
  if (shiftCode === "SUNDAY_EXTRA") return 9 * 60; // 09:00
  // MORNING + MIDDAY = 06:30 chez toi
  return 6 * 60 + 30; // 06:30
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !anon || !srv) return json(res, 500, { ok: false, error: "MISSING_SUPABASE_ENV" });

    const token = getBearer(req);
    if (!token) return json(res, 401, { ok: false, error: "NO_AUTH" });

    // Auth user + check admin email
    const sbAnon = createClient(url, anon, { auth: { persistSession: false } });
    const { data: au, error: auErr } = await sbAnon.auth.getUser(token);
    if (auErr || !au?.user) return json(res, 401, { ok: false, error: "BAD_AUTH" });

    const email = (au.user.email || "").toLowerCase();
    if (!isAdminEmail(email)) return json(res, 403, { ok: false, error: "FORBIDDEN" });

    const admin = createClient(url, srv, { auth: { persistSession: false } });

    const day = (req.query?.day || parisTodayISO()).toString().slice(0, 10);
    const nowMin = parisNowMinutes();

    // Planning du jour
    const { data: shifts, error: shErr } = await admin
      .from("shifts")
      .select("seller_id, shift_code")
      .eq("date", day)
      .not("seller_id", "is", null);

    if (shErr) return json(res, 500, { ok: false, error: shErr.message || "SHIFTS_QUERY_FAILED" });

    const planned = (shifts || []).filter((s) => s?.seller_id && s?.shift_code);
    if (planned.length === 0) return json(res, 200, { ok: true, day, items: [] });

    // Candidates = shifts dont l’heure de début est dépassée de 60 min
    const THRESHOLD_MIN = 60;

    // sellerIds uniques
    const sellerIds = Array.from(new Set(planned.map((x) => x.seller_id)));

    // Absences approuvées du jour
    const { data: abs, error: absErr } = await admin
      .from("absences")
      .select("seller_id")
      .eq("date", day)
      .eq("status", "approved")
      .in("seller_id", sellerIds);

    if (absErr) return json(res, 500, { ok: false, error: absErr.message || "ABS_QUERY_FAILED" });

    const absentSet = new Set((abs || []).map((a) => a.seller_id));

    // Congés approuvés couvrant le jour
    const { data: leaves, error: lErr } = await admin
      .from("leaves")
      .select("seller_id")
      .lte("start_date", day)
      .gte("end_date", day)
      .eq("status", "approved")
      .in("seller_id", sellerIds);

    if (lErr) return json(res, 500, { ok: false, error: lErr.message || "LEAVES_QUERY_FAILED" });

    const leaveSet = new Set((leaves || []).map((l) => l.seller_id));

    // Checkins confirmés
    const { data: chk, error: cErr } = await admin
      .from("daily_checkins")
      .select("seller_id, confirmed_at")
      .eq("day", day)
      .in("seller_id", sellerIds);

    if (cErr) return json(res, 500, { ok: false, error: cErr.message || "CHECKINS_QUERY_FAILED" });

    const confirmedSet = new Set((chk || []).filter((r) => !!r.confirmed_at).map((r) => r.seller_id));

    // Noms
    const { data: prof, error: pErr } = await admin
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", sellerIds);

    if (pErr) return json(res, 500, { ok: false, error: pErr.message || "PROFILES_QUERY_FAILED" });

    const nameById = new Map((prof || []).map((p) => [p.user_id, p.full_name || ""]));

    // Build items (une ligne par shift du jour, pas juste par vendeur)
    const items = [];
    for (const s of planned) {
      const sellerId = s.seller_id;
      const shiftCode = s.shift_code;

      // ignore si absent/congé approuvé
      if (absentSet.has(sellerId)) continue;
      if (leaveSet.has(sellerId)) continue;

      // ignore si déjà pointé
      if (confirmedSet.has(sellerId)) continue;

      const startMin = shiftStartMinutes(shiftCode);
      if (nowMin < startMin + THRESHOLD_MIN) continue; // trop tôt pour alerter

      const minutesSinceStart = Math.max(0, nowMin - startMin);
      items.push({
        seller_id: sellerId,
        full_name: nameById.get(sellerId) || "",
        shift_code: shiftCode,
        day,
        minutes_since_start: minutesSinceStart,
      });
    }

    // Tri: plus urgent d’abord
    items.sort((a, b) => (b.minutes_since_start || 0) - (a.minutes_since_start || 0));

    return json(res, 200, { ok: true, day, items });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "SERVER_ERROR" });
  }
}
