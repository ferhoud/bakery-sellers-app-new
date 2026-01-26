// pages/api/checkins/status.js
//
// Retourne l'état de pointage du jour (vendeuse).
// - Ne pénalise pas une vendeuse qui n'a pas pointé.
// - Protège contre des retards absurdes (ex: 11:03 -> 301 min) : si un vieux record existe,
//   on le "clamp" à une fenêtre max et on peut ignorer côté UI si besoin.
//
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

function parisPartsFromDate(dt) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    hh: get("hour"),
    mm: get("minute"),
    ss: get("second"),
  };
}

function parisMinutesOfDay(dt) {
  const p = parisPartsFromDate(dt);
  const hh = Number(p.hh || 0) || 0;
  const mm = Number(p.mm || 0) || 0;
  return hh * 60 + mm;
}

function startOfMonthISO(dayIso) {
  const [y, m] = String(dayIso || "").split("-").slice(0, 2);
  if (!y || !m) return null;
  return `${y}-${m}-01`;
}

function clampMinutes({ late, early }) {
  const maxLate = maxLateAllowed();
  const maxEarly = maxEarlyAllowed();
  let ignored = false;
  let l = Number(late || 0) || 0;
  let e = Number(early || 0) || 0;
  if (l > maxLate) {
    ignored = true;
    l = 0;
  }
  if (e > maxEarly) {
    ignored = true;
    e = 0;
  }
  return { late: l, early: e, ignored };
}

function recomputeFromConfirmedAt(confirmedAt, plannedMinutes) {
  if (!confirmedAt) return { late: 0, early: 0, ignored: false, has: false };
  const mins = parisMinutesOfDay(new Date(confirmedAt));
  const delta = mins - plannedMinutes;
  const maxLate = maxLateAllowed();
  const maxEarly = maxEarlyAllowed();
  if (delta > 0) {
    if (delta > maxLate) return { late: 0, early: 0, ignored: true, has: true };
    return { late: delta, early: 0, ignored: false, has: true };
  }
  if (delta < 0) {
    const e = -delta;
    if (e > maxEarly) return { late: 0, early: 0, ignored: true, has: true };
    return { late: 0, early: e, ignored: false, has: true };
  }
  return { late: 0, early: 0, ignored: false, has: true };
}

function boundaryFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return "EVENING_START";
  return "MORNING_START";
}

function plannedMinutesFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return 13 * 60 + 30;
  if (sc === "SUNDAY_EXTRA") return 9 * 60;
  return 6 * 60 + 30; // MORNING / MIDDAY
}

function maxEarlyAllowed() {
  // tolérance "arriver en avance" (ex: 06:00→06:30 => +30 min)
  return 30;
}

function maxLateAllowed() {
  // Doit matcher confirm.js (2h)
  return 120;
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
    const day = (q.day || q.date || q.d || parisTodayISO()).toString().slice(0, 10);

    // shifts du jour (pour savoir quel shift la vendeuse fait)
    const { data: shifts, error: shErr } = await admin
      .from("shifts")
      .select("shift_code")
      .eq("date", day)
      .eq("seller_id", user.id);

    if (shErr) return json(res, 500, { ok: false, error: shErr.message });

    const scheduledShiftCodes = (shifts || []).map((s) => s.shift_code).filter(Boolean);
    const scheduled = scheduledShiftCodes.length > 0;
    const scheduledMain = scheduledShiftCodes[0] || null;

    // daily_checkins du jour (créée quand le superviseur génère le code)
    const { data: row, error: rErr } = await admin
      .from("daily_checkins")
      .select("day, shift_code, confirmed_at, late_minutes, early_minutes, created_at, updated_at")
      .eq("day", day)
      .eq("seller_id", user.id)
      .maybeSingle();

    if (rErr) return json(res, 500, { ok: false, error: rErr.message });

    const effectiveShift = row?.shift_code || scheduledMain || null;
    const boundary = boundaryFromShift(effectiveShift);

    const plannedMinutes = plannedMinutesFromShift(effectiveShift);


    // Clamp contre valeurs absurdes + backfill (anciennes versions)
const maxLate = maxLateAllowed();
const maxEarly = maxEarlyAllowed();

let late = Number(row?.late_minutes || 0) || 0;
let early = Number(row?.early_minutes || 0) || 0;
let ignored = false;

// Si un pointage est confirmé mais que late/early sont vides ou incohérents,
// on recalcule à partir de confirmed_at (heure Paris) et de l'heure prévue.
if (row?.confirmed_at) {
  const rec = recomputeFromConfirmedAt(row.confirmed_at, plannedMinutes);
  if (rec.has) {
    // Si les valeurs stockées sont 0/0 mais qu'on peut calculer mieux, on prend le calcul.
    const storedZero = (late === 0 && early === 0);
    const storedOutOfRange = (late > maxLate || early > maxEarly);
    if (storedZero || storedOutOfRange) {
      late = rec.late;
      early = rec.early;
      ignored = rec.ignored;
    }
  }
}

// Clamp final
const cl = clampMinutes({ late, early });
late = cl.late;
early = cl.early;
ignored = ignored || cl.ignored;

const item = row
      ? {
          boundary,
          shift_code: effectiveShift,
          confirmed_at: row.confirmed_at,
          late_minutes: late,
          early_minutes: early,
          created_at: row.created_at,
          updated_at: row.updated_at,
          ignored,
        }
      : null;

    const byBoundary = {};
    if (item) {
      byBoundary[boundary] = item;
      if (item.shift_code) byBoundary[String(item.shift_code).toUpperCase()] = item;
    }

// Totaux du mois (pointage) — uniquement les jours confirmés
const monthStart = startOfMonthISO(day);
let monthDelay = 0;
let monthExtra = 0;

if (monthStart) {
  const { data: monthRows, error: mErr } = await admin
    .from("daily_checkins")
    .select("day, shift_code, confirmed_at, late_minutes, early_minutes")
    .eq("seller_id", user.id)
    .gte("day", monthStart)
    .lte("day", day)
    .not("confirmed_at", "is", null);

  if (!mErr && Array.isArray(monthRows)) {
    for (const r of monthRows) {
      const eff = r?.shift_code || null;
      const pm = plannedMinutesFromShift(eff);
      // Recalc si besoin
      let l = Number(r?.late_minutes || 0) || 0;
      let e = Number(r?.early_minutes || 0) || 0;
      const rec = recomputeFromConfirmedAt(r?.confirmed_at, pm);
      const storedZero = (l === 0 && e === 0);
      const storedOutOfRange = (l > maxLateAllowed() || e > maxEarlyAllowed());
      if (rec.has && (storedZero || storedOutOfRange)) {
        l = rec.late;
        e = rec.early;
      }
      const cl2 = clampMinutes({ late: l, early: e });
      monthDelay += cl2.late;
      monthExtra += cl2.early;
    }
  }
}

const todayDelay = late;
const todayExtra = early;


    return json(res, 200, {
      ok: true,
      day,
      month_delay_minutes: monthDelay,
      month_extra_minutes: monthExtra,
      today_delay_minutes: todayDelay,
      today_extra_minutes: todayExtra,
      scheduled,
      scheduled_shift_codes: scheduledShiftCodes,
      issued: !!row,
      confirmed: !!row?.confirmed_at,
      shift_code: effectiveShift,
      late_minutes: late,
      early_minutes: early,
      ignored,
      byBoundary,
      items: item ? [item] : [],
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
