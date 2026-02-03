// pages/api/checkins/confirm.js
//
// Confirme un pointage vendeuse via code 6 chiffres.
// Règle importante : si la vendeuse pointe "trop tard", on confirme MAIS sans compter de retard.
// - Matin/Midi : heure prévue 06:30, fenêtre autorisée jusqu'à 08:30 (2h)
// - Soir      : heure prévue 13:30, fenêtre autorisée jusqu'à 15:30 (2h)
// - Dimanche  : heure prévue 09:00, fenêtre autorisée jusqu'à 11:00 (2h)
// Bonus "avance" : uniquement pour MORNING (max 30 min).
//
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

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
  return planned + 120; // 2h
}

function windowStartMinutes(planned) {
  return planned - 30; // 30 min avant
}

function safeParseBody(req) {
  try {
    if (typeof req.body === "string") return JSON.parse(req.body);
    return req.body || {};
  } catch {
    return {};
  }
}

function getCheckinSecret() {
  // Même secret côté génération et confirmation
  return (process.env.CHECKIN_CODE_SECRET || process.env.CHECKIN_CODE_PEPPER || "").toString();
}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

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

    const body = safeParseBody(req);
    const day = (body.day || body.date || body.d || parisTodayISO()).toString().slice(0, 10);
    const code = (body.code || "").toString().trim();

    if (!/^\d{6}$/.test(code)) return json(res, 400, { ok: false, error: "BAD_CODE_FORMAT" });

    // Refuse si ce n'est pas le jour courant (heure Paris)
    const todayParis = parisTodayISO();
    if (day !== todayParis) {
      return json(res, 400, { ok: false, error: "CHECKIN_NOT_TODAY" });
    }

    // On récupère le code émis
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

    const expected = (row.code_hash || "").toString();
    if (!expected) return json(res, 500, { ok: false, error: "MISSING_CODE_HASH" });

    const secret = getCheckinSecret();
    if (!secret) return json(res, 500, { ok: false, error: "MISSING_CHECKIN_CODE_SECRET" });

    // Hash principal (nouveau): sha256(code:secret)
    const h1 = sha256Hex(`${code}:${secret}`);

    // Compat ancien format (si jamais): sha256(secret:code)
    const h2 = sha256Hex(`${secret}:${code}`);

    if (h1 !== expected && h2 !== expected) {
      return json(res, 400, { ok: false, error: "BAD_CODE" });
    }

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

    const now = new Date();

    if (nowMin > end) {
      // Trop tard => confirmé mais sans retard/avance
      const { error: upErrLate } = await admin
        .from("daily_checkins")
        .update({
          confirmed_at: now.toISOString(),
          late_minutes: 0,
          early_minutes: 0,
        })
        .eq("id", row.id);

      if (upErrLate) return json(res, 500, { ok: false, error: upErrLate.message });

      return json(res, 200, {
        ok: true,
        day,
        shift_code: row.shift_code,
        confirmed_at: now.toISOString(),
        late_minutes: 0,
        early_minutes: 0,
        window_closed: true,
      });
    }

    // Calcul retard/avance
    const delta = nowMin - planned;
    const late = delta > 0 ? Math.min(delta, 120) : 0;

    const earlyRaw = delta < 0 ? Math.min(Math.abs(delta), 30) : 0;
    const isMorning = String(row.shift_code || "").toUpperCase() === "MORNING";
    const early = isMorning ? earlyRaw : 0;

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
