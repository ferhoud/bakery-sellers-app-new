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

function hmFromHmss(t) {
  const s = (t || "").toString().trim();
  const m = /^([0-2]\d):([0-5]\d)/.exec(s);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

function parseHMToMinutes(t) {
  const s = (t || "").toString().trim();
  const m = /^([0-2]\d):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function defaultPlannedTime(shiftCode) {
  // Valeurs par défaut (tu peux ensuite les rendre configurables si tu veux)
  if (shiftCode === "MORNING") return "06:30";
  if (shiftCode === "EVENING") return "13:30";
  if (shiftCode === "SUNDAY_EXTRA") return "09:00";
  if (shiftCode === "MIDDAY") return "11:30";
  return null;
}

function boundaryForShift(shiftCode) {
  if (shiftCode === "MORNING" || shiftCode === "SUNDAY_EXTRA") return "MORNING_START";
  if (shiftCode === "EVENING") return "EVENING_START";
  // MIDDAY: pas de boundary standard chez toi (on ne force pas)
  return null;
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
    const scheduledShift = shifts?.[0]?.shift_code || null;
    if (!scheduledShift) return json(res, 403, { ok: false, error: "NOT_SCHEDULED_TODAY" });

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

    const shift_code = row.shift_code || scheduledShift;

    // Déjà confirmé ? on renvoie l'état existant
    if (row.confirmed_at) {
      return json(res, 200, {
        ok: true,
        day,
        shift_code,
        late_minutes: Number(row.late_minutes || 0) || 0,
        early_minutes: Number(row.early_minutes || 0) || 0,
        already_confirmed: true,
      });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const actualHMSS = parisTimeHMSS(now);
    const actualHM = hmFromHmss(actualHMSS);

    // Calcul retard/avance vs heure prévue
    let plannedHM = defaultPlannedTime(shift_code);
    const boundary = boundaryForShift(shift_code);

    // Si un réglage existe déjà (admin a modifié l'heure prévue), on le respecte
    let existingH = null;
    if (boundary) {
      try {
        const { data: hRow, error: hErr } = await admin
          .from("shift_handover_adjustments")
          .select("planned_time, stayed_seller_id, arrived_seller_id")
          .eq("date", day)
          .eq("boundary", boundary)
          .maybeSingle();

        if (!hErr && hRow) existingH = hRow;
        const maybePlanned = hmFromHmss(hRow?.planned_time) || hmFromHmss(hRow?.planned_time?.toString?.()) || null;
        if (maybePlanned) plannedHM = maybePlanned;
        else if (typeof hRow?.planned_time === "string" && /^\d{2}:\d{2}/.test(hRow.planned_time)) plannedHM = hRow.planned_time.slice(0, 5);
      } catch (_) {}
    }

    // Si on n'a rien du tout, on calcule sans retard
    let late = 0;
    let early = 0;
    let delta = 0;

    const pMin = parseHMToMinutes(plannedHM);
    const aMin = parseHMToMinutes(actualHM);

    if (pMin != null && aMin != null) {
      delta = aMin - pMin;
      if (delta > 0) late = delta;
      else if (delta < 0) early = -delta;
    }

    // 1) Confirme le check-in + stocke minutes retard/avance
    {
      const { error: uErr } = await admin
        .from("daily_checkins")
        .update({
          confirmed_at: nowIso,
          updated_at: nowIso,
          late_minutes: late,
          early_minutes: early,
        })
        .eq("id", row.id);

      if (uErr) return json(res, 500, { ok: false, error: uErr.message });
    }

    // 2) Alimente le système "retard/relais" (pour le message vendeuse + impact heures mensuelles)
    //    On écrit un enregistrement MORNING_START / EVENING_START avec planned_time + actual_time.
    let handover_saved = false;
    if (boundary && plannedHM && actualHM) {
      try {
        const payload = {
          date: day,
          boundary,
          planned_time: plannedHM,
          actual_time: actualHM,
          // important: ne pas écraser un "stayed_seller_id" déjà posé par l'admin
          stayed_seller_id: existingH?.stayed_seller_id ?? null,
          arrived_seller_id: user.id,
        };

        const { error: hSaveErr } = await admin
          .from("shift_handover_adjustments")
          .upsert(payload, { onConflict: "date,boundary" });

        if (!hSaveErr) handover_saved = true;
      } catch (_) {}
    }

    return json(res, 200, {
      ok: true,
      day,
      shift_code,
      planned_time: plannedHM || null,
      actual_time: actualHM || null,
      actual_time_hms: actualHMSS || null,
      delta_minutes: delta || 0,
      late_minutes: late || 0,
      early_minutes: early || 0,
      handover_saved,
      already_confirmed: false,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
