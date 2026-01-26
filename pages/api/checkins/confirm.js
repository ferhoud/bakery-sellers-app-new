// pages/api/checkins/confirm.js
//
// Confirme un pointage vendeuse via code 6 chiffres.
// Règle importante : si la vendeuse pointe "trop tard", on refuse (sinon ça crée des retards absurdes).
// - Matin/Midi : heure prévue 06:30, fenêtre autorisée jusqu'à 08:30 (2h)
// - Soir      : heure prévue 13:30, fenêtre autorisée jusqu'à 15:30 (2h)
// - Dimanche  : heure prévue 09:00, fenêtre autorisée jusqu'à 11:00 (2h)
// Si la vendeuse oublie de pointer, on ne compte rien (pas de retard).
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

function parisNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
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

function parisTodayISO() {
  const p = parisNowParts();
  return `${p.y}-${p.m}-${p.d}`;
}

function nowParisMinutes() {
  const p = parisNowParts();
  return (parseInt(p.hh || "0", 10) || 0) * 60 + (parseInt(p.mm || "0", 10) || 0);
}

function plannedMinutesFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return 13 * 60 + 30; // 13:30
  if (sc === "SUNDAY_EXTRA") return 9 * 60;  // 09:00
  // MORNING + MIDDAY -> même arrivée 06:30
  return 6 * 60 + 30; // 06:30
}

function windowEndMinutes(planned) {
  // 2h de tolérance (120 minutes) — ajustable
  return planned + 120;
}

function windowStartMinutes(planned) {
  // 30 min avant l'heure prévue (ex 06:00 pour une arrivée prévue 06:30)
  return planned - 30;
}


function maxLateAllowed() { return 120; }
function maxEarlyAllowed(){ return 30; }

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

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const day = (body.day || body.date || body.d || parisTodayISO()).toString().slice(0, 10);
    const code = (body.code || "").toString().trim();

    if (!/^\d{6}$/.test(code)) return json(res, 400, { ok: false, error: "BAD_CODE_FORMAT" });

    // Refuse si ce n'est pas le jour courant (heure Paris)
    const todayParis = parisTodayISO();
    if (day !== todayParis) {
      return json(res, 400, { ok: false, error: "CHECKIN_NOT_TODAY" });
    }

    // On récupère le "code du jour" émis (daily_checkins existe quand le superviseur génère un code)
    const { data: row, error: rErr } = await admin
      .from("daily_checkins")
      .select("id, day, seller_id, shift_code, code_hash, confirmed_at, late_minutes, early_minutes")
      .eq("day", day)
      .eq("seller_id", user.id)
      .maybeSingle();

    if (rErr) return json(res, 500, { ok: false, error: rErr.message });
    if (!row) return json(res, 400, { ok: false, error: "NO_CODE_ISSUED" });

    // Déjà confirmé => idempotent
    if (row.confirmed_at) {
      return json(res, 200, {
        ok: true,
        already_confirmed: true,
        day,
        shift_code: row.shift_code,
        late_minutes: Number(row.late_minutes || 0) || 0,
        early_minutes: Number(row.early_minutes || 0) || 0,
      });
    }
    }

    // Vérification du hash du code (compat: si code_hash absent, on ne valide pas)
    const expected = (row.code_hash || "").toString();
    if (!expected) return json(res, 500, { ok: false, error: "MISSING_CODE_HASH" });

    // Hash simple: sha256(code + secret). On reproduit le même côté serveur.
    const secret = process.env.CHECKIN_CODE_SECRET || "";
    if (!secret) return json(res, 500, { ok: false, error: "MISSING_CHECKIN_CODE_SECRET" });

    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(`${code}:${secret}`));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

    if (hex !== expected) return json(res, 400, { ok: false, error: "BAD_CODE" });

    // Fenêtre autorisée
    const planned = plannedMinutesFromShift(row.shift_code);
    const start = windowStartMinutes(planned);
    const end = windowEndMinutes(planned);
    const nowMin = nowParisMinutes();
    if (nowMin < start) {
      return json(res, 400, {
        ok: false,
        error: "CHECKIN_TOO_EARLY",
        opens_at: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
      });
    }

    if (nowMin > end) {
      // Trop tard => on refuse et on ne compte pas de retard.
      return json(res, 400, {
        ok: false,
        error: "CHECKIN_WINDOW_CLOSED",
        planned_hhmm: `${String(Math.floor(planned / 60)).padStart(2, "0")}:${String(planned % 60).padStart(2, "0")}`,
        window_end_hhmm: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
      });
    }

    // Calcul retard/avance
    const delta = nowMin - planned;
    const late = delta > 0 ? Math.min(delta, 120) : 0;
    const early = delta < 0 ? Math.min(Math.abs(delta), 30) : 0;

    const now = new Date();

    // Confirme
    const { error: upErr } = await admin
      .from("daily_checkins")
      .update({
        confirmed_at: now.toISOString(),
        late_minutes: late,
        early_minutes: early,
      })
      .eq("id", row.id);

    if (upErr) return json(res, 500, { ok: false, error: upErr.message });

    return json(res, 200, {
      ok: true,
      day,
      shift_code: row.shift_code,
      confirmed_at: now.toISOString(),
      late_minutes: late,
      early_minutes: early,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
