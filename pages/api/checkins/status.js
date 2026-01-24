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

function boundaryFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING" || sc === "EVENING_START") return "EVENING_START";
  // Matin/Midi/Dimanche => même fenêtre d’arrivée
  return "MORNING_START";
}

function plannedStartHHMM(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING" || sc === "EVENING_START") return "13:30";
  if (sc === "SUNDAY_EXTRA") return "09:00";
  // MORNING / MIDDAY (et défaut)
  return "06:30";
}

function hhmmToMinutes(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function parisHHMMFromISO(iso) {
  try {
    const d = new Date(String(iso));
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const hh = parts.find((p) => p.type === "hour")?.value;
    const mm = parts.find((p) => p.type === "minute")?.value;
    if (!hh || !mm) return null;
    return `${hh}:${mm}`;
  } catch {
    return null;
  }
}

function monthStartISO(dayISO) {
  const s = String(dayISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return `${s.slice(0, 8)}01`;
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

    // Planning du jour (peut aider à deviner le shift_code si daily_checkins ne le contient pas)
    const { data: shifts, error: shErr } = await admin
      .from("shifts")
      .select("shift_code")
      .eq("date", day)
      .eq("seller_id", user.id);

    if (shErr) return json(res, 500, { ok: false, error: shErr.message });

    const scheduledShiftCodes = (shifts || []).map((s) => s.shift_code).filter(Boolean);
    const scheduled = scheduledShiftCodes.length > 0;
    const scheduledMain = scheduledShiftCodes[0] || null;

    // Ligne daily_checkins (créée quand le superviseur génère le code)
    const { data: row, error: rErr } = await admin
      .from("daily_checkins")
      .select("day, shift_code, confirmed_at, late_minutes, early_minutes, created_at, updated_at")
      .eq("day", day)
      .eq("seller_id", user.id)
      .maybeSingle();

    if (rErr) return json(res, 500, { ok: false, error: rErr.message });

    const effectiveShift = (row?.shift_code || scheduledMain || null) ? String(row?.shift_code || scheduledMain || "").toUpperCase() : null;
    const boundary = boundaryFromShift(effectiveShift);

    // ✅ Calcule/normalise late_minutes & early_minutes à partir de confirmed_at (heure réelle)
    let lateMinutes = Number(row?.late_minutes || 0) || 0;
    let earlyMinutes = Number(row?.early_minutes || 0) || 0;

    if (row?.confirmed_at) {
      const planned = plannedStartHHMM(effectiveShift);
      const plannedMin = hhmmToMinutes(planned);
      const actualHHMM = parisHHMMFromISO(row.confirmed_at);
      const actualMin = actualHHMM ? hhmmToMinutes(actualHHMM) : null;

      if (plannedMin != null && actualMin != null) {
        const delta = Math.max(-360, Math.min(360, actualMin - plannedMin)); // borne de sécurité
        const newLate = delta > 0 ? delta : 0;
        const newEarly = delta < 0 ? -delta : 0;

        // Si différent, on met à jour la DB (utile pour admin / exports)
        if (newLate !== lateMinutes || newEarly !== earlyMinutes) {
          lateMinutes = newLate;
          earlyMinutes = newEarly;
          try {
            await admin
              .from("daily_checkins")
              .update({ late_minutes: lateMinutes, early_minutes: earlyMinutes })
              .eq("day", day)
              .eq("seller_id", user.id);
          } catch {}
        }
      }
    }

    // ✅ Sommes du mois (retard/avance cumulés)
    const mStart = monthStartISO(day);
    let monthDelay = 0;
    let monthExtra = 0;

    if (mStart) {
      const { data: monthRows } = await admin
        .from("daily_checkins")
        .select("late_minutes, early_minutes, confirmed_at, day")
        .eq("seller_id", user.id)
        .gte("day", mStart)
        .lte("day", day);

      for (const rr of monthRows || []) {
        // On compte seulement si confirmé (sinon late/early peut rester à 0)
        if (!rr?.confirmed_at) continue;
        monthDelay += Number(rr.late_minutes || 0) || 0;
        monthExtra += Number(rr.early_minutes || 0) || 0;
      }
    }

    const item = row
      ? {
          boundary,
          shift_code: effectiveShift,
          confirmed_at: row.confirmed_at,
          late_minutes: lateMinutes,
          early_minutes: earlyMinutes,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }
      : null;

    const byBoundary = {};
    if (item) {
      byBoundary[boundary] = item;
      if (item.shift_code) byBoundary[String(item.shift_code).toUpperCase()] = item;
    }

    return json(res, 200, {
      ok: true,
      day,
      scheduled,
      scheduled_shift_codes: scheduledShiftCodes,
      issued: !!row,
      confirmed: !!row?.confirmed_at,
      shift_code: effectiveShift,
      late_minutes: lateMinutes,
      early_minutes: earlyMinutes,
      // ✅ totaux utiles pour l'UI vendeuse
      today_delay_minutes: lateMinutes,
      today_extra_minutes: earlyMinutes,
      month_delay_minutes: monthDelay,
      month_extra_minutes: monthExtra,
      byBoundary,
      items: item ? [item] : [],
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
