// pages/api/admin/checkins/missing-resolution.js
//
// Pointage manquant -> traitement direct depuis l'admin
// GET  : liste les vendeuses planifiées qui n'ont toujours pas de pointage après le délai d'alerte
// POST :
//   - action="absent"         -> marque la vendeuse absente via admin_mark_absent
//   - action="manual_checkin" -> crée un pointage admin avec l'heure réelle d'arrivée
//
// Le pointage manuel en retard du soir nourrit ensuite automatiquement
// /api/admin/checkins/coverage-alerts, qui demandera "qui a couvert ?".
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { isAdminEmail } from "@/lib/admin";

const ALERT_AFTER_MINUTES = 60;

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || "";
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

function toISODate(x) {
  return String(x || "").slice(0, 10);
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function hhmmFromMinutes(totalMinutes) {
  const raw = Math.round(Number(totalMinutes || 0) || 0);
  const mins = ((raw % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function parisNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value || "1970";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  const d = parts.find((p) => p.type === "day")?.value || "01";
  const hh = Number(parts.find((p) => p.type === "hour")?.value || 0) || 0;
  const mm = Number(parts.find((p) => p.type === "minute")?.value || 0) || 0;

  return {
    day: `${y}-${m}-${d}`,
    minutes: hh * 60 + mm,
  };
}

function parisNoonOffsetMinutes(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return 0;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utcNoon = Date.UTC(y, mo - 1, d, 12, 0, 0);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcNoon));

  const py = Number(parts.find((p) => p.type === "year")?.value || y);
  const pm = Number(parts.find((p) => p.type === "month")?.value || mo);
  const pd = Number(parts.find((p) => p.type === "day")?.value || d);
  const ph = Number(parts.find((p) => p.type === "hour")?.value || 12);
  const pmin = Number(parts.find((p) => p.type === "minute")?.value || 0);

  const localRenderedAsUtc = Date.UTC(py, pm - 1, pd, ph, pmin, 0);
  return Math.round((localRenderedAsUtc - utcNoon) / 60000);
}

function parisLocalDateTimeToISO(day, hhmm) {
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  const mins = parseHHMM(hhmm);
  if (!dayMatch || mins == null) return null;

  const y = Number(dayMatch[1]);
  const mo = Number(dayMatch[2]);
  const d = Number(dayMatch[3]);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  const offset = parisNoonOffsetMinutes(day);
  const utcMillis = Date.UTC(y, mo - 1, d, hh, mm, 0) - offset * 60 * 1000;
  return new Date(utcMillis).toISOString();
}

function plannedMinutesFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return 13 * 60 + 30;
  if (sc === "SUNDAY_EXTRA") return 9 * 60;
  return 6 * 60 + 30; // MORNING + MIDDAY
}

function shiftAlertId(day, sellerId, shiftCode) {
  return `${day || ""}:${sellerId || ""}:${String(shiftCode || "").toUpperCase()}`;
}

function manualAdminCodeHash(day, sellerId, shiftCode, actualTime, confirmedAt) {
  // daily_checkins.code_hash est NOT NULL dans la base actuelle.
  // Pour une régularisation admin, il n’y a pas de code vendeur à vérifier :
  // on enregistre donc une empreinte technique stable, non réutilisable.
  const raw = [
    "ADMIN_MANUAL_CHECKIN",
    String(day || ""),
    String(sellerId || ""),
    String(shiftCode || ""),
    String(actualTime || ""),
    String(confirmedAt || ""),
    String(Date.now()),
  ].join(":");
  return createHash("sha256").update(raw).digest("hex");
}

async function requireAdmin(req) {
  const jwt = getBearer(req);
  if (!jwt) return { error: { status: 401, message: "Auth session missing!" } };

  const sbAnon = anonClient();
  if (!sbAnon) return { error: { status: 500, message: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" } };

  const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
  if (auErr || !au?.user) return { error: { status: 401, message: auErr?.message || "Unauthorized" } };

  const admin = adminClient();
  if (!admin) return { error: { status: 500, message: "Missing SUPABASE_SERVICE_ROLE_KEY" } };

  const user = au.user;
  const email = String(user.email || "").toLowerCase();
  if (email && isAdminEmail(email)) return { admin, user };

  const { data: prof, error: pErr } = await admin
    .from("profiles")
    .select("user_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (pErr) return { error: { status: 500, message: pErr.message } };
  if (String(prof?.role || "").toLowerCase() !== "admin") {
    return { error: { status: 403, message: "FORBIDDEN" } };
  }

  return { admin, user };
}

async function loadNames(admin, ids) {
  const out = {};
  const clean = uniq(ids);
  if (!clean.length) return out;

  try {
    const { data, error } = await admin.from("profiles").select("user_id, full_name").in("user_id", clean);
    if (!error && Array.isArray(data)) {
      for (const p of data) {
        if (p?.user_id) out[p.user_id] = String(p.full_name || "").trim();
      }
    }
  } catch (_) {}

  const missing = clean.filter((id) => !out[id]);
  if (missing.length) {
    try {
      const { data, error } = await admin
        .from("sellers")
        .select("id, user_id, full_name, name")
        .or(`id.in.(${missing.join(",")}),user_id.in.(${missing.join(",")})`);
      if (!error && Array.isArray(data)) {
        for (const s of data) {
          const id = s?.user_id || s?.id;
          if (id) out[id] = String(s.full_name || s.name || "").trim();
        }
      }
    } catch (_) {}
  }

  return out;
}

async function loadConfirmedCheckins(admin, day) {
  const { data, error } = await admin
    .from("daily_checkins")
    .select("id, day, seller_id, shift_code, confirmed_at, late_minutes, early_minutes")
    .eq("day", day)
    .not("confirmed_at", "is", null);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadAbsenceSellerIds(admin, day) {
  const { data, error } = await admin
    .from("absences")
    .select("seller_id, status")
    .eq("date", day)
    .in("status", ["pending", "approved"]);

  if (error) {
    const msg = String(error?.message || "").toLowerCase();
    const missingTable = String(error?.code || "") === "42P01" || msg.includes("does not exist");
    if (missingTable) return new Set();
    throw error;
  }

  return new Set((data || []).map((row) => row?.seller_id).filter(Boolean));
}

function shouldRaiseForDay(day, plannedMinutes) {
  const now = parisNowParts();
  const cmp = String(day || "").localeCompare(now.day);
  if (cmp > 0) return { show: false, minutesSinceStart: 0 };
  if (cmp < 0) return { show: true, minutesSinceStart: ALERT_AFTER_MINUTES };
  const mins = Math.max(0, now.minutes - plannedMinutes);
  return { show: mins >= ALERT_AFTER_MINUTES, minutesSinceStart: mins };
}

async function handleGet(req, res, admin) {
  const q = req.query || {};
  const today = parisNowParts().day;
  const day = toISODate(q.day || q.date || q.d || today) || today;

  const { data: shifts, error: shErr } = await admin
    .from("shifts")
    .select("date, seller_id, shift_code")
    .eq("date", day);

  if (shErr) return json(res, 500, { ok: false, error: shErr.message });

  const shiftRows = Array.isArray(shifts) ? shifts.filter((s) => s?.seller_id && s?.shift_code) : [];
  if (!shiftRows.length) return json(res, 200, { ok: true, day, items: [], alert_after_minutes: ALERT_AFTER_MINUTES });

  let checkins = [];
  let absentSellerIds = new Set();
  try {
    [checkins, absentSellerIds] = await Promise.all([
      loadConfirmedCheckins(admin, day),
      loadAbsenceSellerIds(admin, day),
    ]);
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "LOAD_MISSING_CHECKINS_FAILED" });
  }

  const confirmedSellerIds = new Set((checkins || []).map((row) => row?.seller_id).filter(Boolean));
  const names = await loadNames(admin, shiftRows.map((row) => row.seller_id));

  const items = shiftRows
    .map((row) => {
      const shiftCode = String(row.shift_code || "").toUpperCase();
      const plannedMinutes = plannedMinutesFromShift(shiftCode);
      const timing = shouldRaiseForDay(day, plannedMinutes);
      return {
        id: shiftAlertId(day, row.seller_id, shiftCode),
        alert_id: shiftAlertId(day, row.seller_id, shiftCode),
        day,
        seller_id: row.seller_id,
        seller_name: names[row.seller_id] || "Vendeuse",
        shift_code: shiftCode,
        planned_time: hhmmFromMinutes(plannedMinutes),
        minutes_since_start: timing.minutesSinceStart,
        ready: timing.show,
      };
    })
    .filter((item) => item.ready)
    .filter((item) => !confirmedSellerIds.has(item.seller_id))
    .filter((item) => !absentSellerIds.has(item.seller_id))
    .sort((a, b) => {
      const t = String(a.planned_time || "").localeCompare(String(b.planned_time || ""));
      if (t !== 0) return t;
      return String(a.seller_name || "").localeCompare(String(b.seller_name || ""), "fr");
    });

  return json(res, 200, { ok: true, day, items, alert_after_minutes: ALERT_AFTER_MINUTES });
}

async function markAbsent(admin, body) {
  const day = toISODate(body.day || body.date || "");
  const sellerId = String(body.seller_id || body.sellerId || "");
  if (!day) return { error: { status: 400, message: "Missing day" } };
  if (!sellerId) return { error: { status: 400, message: "Missing seller_id" } };

  const { error } = await admin.rpc("admin_mark_absent", {
    p_seller: sellerId,
    p_date: day,
    p_reason: "Absence confirmée par l’admin après pointage manquant",
  });

  if (error) return { error: { status: 500, message: error.message || "ADMIN_MARK_ABSENT_FAILED" } };
  return { ok: true, day, seller_id: sellerId };
}

async function manualCheckin(admin, body) {
  const day = toISODate(body.day || body.date || "");
  const sellerId = String(body.seller_id || body.sellerId || "");
  const shiftCode = String(body.shift_code || body.shiftCode || "").toUpperCase();
  const actualTime = String(body.actual_time || body.actualTime || "").trim();

  if (!day) return { error: { status: 400, message: "Missing day" } };
  if (!sellerId) return { error: { status: 400, message: "Missing seller_id" } };
  if (!shiftCode) return { error: { status: 400, message: "Missing shift_code" } };
  if (parseHHMM(actualTime) == null) return { error: { status: 400, message: "INVALID_ACTUAL_TIME" } };

  const { data: shift, error: shiftErr } = await admin
    .from("shifts")
    .select("date, seller_id, shift_code")
    .eq("date", day)
    .eq("seller_id", sellerId)
    .eq("shift_code", shiftCode)
    .limit(1)
    .maybeSingle();

  if (shiftErr) return { error: { status: 500, message: shiftErr.message } };
  if (!shift?.seller_id) return { error: { status: 404, message: "SHIFT_NOT_FOUND" } };

  const { data: existing, error: existingErr } = await admin
    .from("daily_checkins")
    .select("id, day, seller_id, shift_code, confirmed_at")
    .eq("day", day)
    .eq("seller_id", sellerId)
    .maybeSingle();

  if (existingErr) return { error: { status: 500, message: existingErr.message } };
  if (existing?.confirmed_at) return { error: { status: 409, message: "CHECKIN_ALREADY_CONFIRMED" } };

  const plannedMinutes = plannedMinutesFromShift(shiftCode);
  const actualMinutes = parseHHMM(actualTime);
  const rawDelta = actualMinutes - plannedMinutes;
  const lateMinutes = rawDelta > 0 ? rawDelta : 0;
  const earlyMinutes = rawDelta < 0 && shiftCode !== "EVENING" ? Math.min(Math.abs(rawDelta), 30) : 0;
  const confirmedAt = parisLocalDateTimeToISO(day, actualTime);
  if (!confirmedAt) return { error: { status: 400, message: "INVALID_ACTUAL_DATETIME" } };

  const payload = {
    day,
    seller_id: sellerId,
    shift_code: shiftCode,
    confirmed_at: confirmedAt,
    late_minutes: lateMinutes,
    early_minutes: earlyMinutes,
  };

  const insertPayload = {
    ...payload,
    // Obligatoire sur les nouvelles lignes daily_checkins dans la base actuelle.
    code_hash: manualAdminCodeHash(day, sellerId, shiftCode, actualTime, confirmedAt),
  };

  let row = null;
  if (existing?.id) {
    const { data, error } = await admin.from("daily_checkins").update(payload).eq("id", existing.id).select("*").maybeSingle();
    if (error) return { error: { status: 500, message: error.message || "CHECKIN_UPDATE_FAILED" } };
    row = data || null;
  } else {
    const { data, error } = await admin.from("daily_checkins").insert(insertPayload).select("*").maybeSingle();
    if (error) return { error: { status: 500, message: error.message || "CHECKIN_INSERT_FAILED" } };
    row = data || null;
  }

  return {
    ok: true,
    day,
    seller_id: sellerId,
    shift_code: shiftCode,
    planned_time: hhmmFromMinutes(plannedMinutes),
    actual_time: actualTime,
    confirmed_at: row?.confirmed_at || confirmedAt,
    late_minutes: Number(row?.late_minutes ?? lateMinutes) || 0,
    early_minutes: Number(row?.early_minutes ?? earlyMinutes) || 0,
    checkin_id: row?.id || existing?.id || null,
  };
}

async function handlePost(req, res, admin) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const action = String(body.action || "").trim().toLowerCase();

  if (action === "absent") {
    const result = await markAbsent(admin, body);
    if (result?.error) return json(res, result.error.status, { ok: false, error: result.error.message });
    return json(res, 200, result);
  }

  if (action === "manual_checkin") {
    const result = await manualCheckin(admin, body);
    if (result?.error) return json(res, result.error.status, { ok: false, error: result.error.message });
    return json(res, 200, result);
  }

  return json(res, 400, { ok: false, error: "UNKNOWN_ACTION" });
}

export default async function handler(req, res) {
  try {
    const auth = await requireAdmin(req);
    if (auth?.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    if (req.method === "GET") return handleGet(req, res, auth.admin);
    if (req.method === "POST") return handlePost(req, res, auth.admin);

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
