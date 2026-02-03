// pages/api/supervisor/checkin-code.js
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "../../../lib/admin";

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
async function isSupervisor(admin, userId) {
  const { data, error } = await admin
    .from("supervisors")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return !!data?.user_id;
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
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function plannedMinutesFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return 13 * 60 + 30; // 13:30
  if (sc === "SUNDAY_EXTRA") return 9 * 60;  // 09:00
  // MORNING + MIDDAY -> même arrivée 06:30
  return 6 * 60 + 30; // 06:30
}

function genCode6() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function getCheckinSecret() {
  // On préfère CHECKIN_CODE_SECRET, mais on garde CHECKIN_CODE_PEPPER en fallback
  return (process.env.CHECKIN_CODE_SECRET || process.env.CHECKIN_CODE_PEPPER || "").toString();
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

    const caller = au.user;

    const admin = adminClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const email = (caller.email || "").toLowerCase();
    const allowAdmin = isAdminEmail(email);
    const allowSupervisor = !allowAdmin ? await isSupervisor(admin, caller.id) : true;
    if (!allowAdmin && !allowSupervisor) return json(res, 403, { ok: false, error: "Forbidden" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const sellerId = (body.seller_id || "").toString();
    const password = (body.password || "").toString();
    const day = (body.day || parisTodayISO()).toString().slice(0, 10);

    if (!sellerId) return json(res, 400, { ok: false, error: "Missing seller_id" });
    if (!password) return json(res, 400, { ok: false, error: "Missing password" });

    // Shift du jour
    const { data: shifts, error: shErr } = await admin
      .from("shifts")
      .select("shift_code")
      .eq("date", day)
      .eq("seller_id", sellerId)
      .limit(1);

    if (shErr) return json(res, 500, { ok: false, error: shErr.message });
    const shiftCode = shifts?.[0]?.shift_code;
    if (!shiftCode) return json(res, 403, { ok: false, error: "NOT_SCHEDULED_TODAY" });

    // Email vendeur
    const { data: userById, error: uErr } = await admin.auth.admin.getUserById(sellerId);
    if (uErr || !userById?.user?.email) return json(res, 400, { ok: false, error: "SELLER_EMAIL_NOT_FOUND" });
    const sellerEmail = userById.user.email;

    // Check password (auth vendeur) — ne valide PAS le pointage, juste vérifie le mdp
    const { error: pwErr } = await sbAnon.auth.signInWithPassword({ email: sellerEmail, password });
    if (pwErr) return json(res, 403, { ok: false, error: "BAD_PASSWORD" });

    const EARLY_WINDOW = 30;

    // Heure Paris (DEV: simulation possible)
    let nowMin = parisNowMinutes();
    if (process.env.NODE_ENV !== "production") {
      const sim = parseHHMM(body.now_time);
      if (typeof sim === "number") nowMin = sim;
    }

    const planned = plannedMinutesFromShift(shiftCode);
    const openAt = planned - EARLY_WINDOW;

    // Trop tôt (anti-triche)
    if (nowMin < openAt) {
      return json(res, 409, { ok: false, error: "TOO_EARLY" });
    }

    // Preview uniquement (pour affichage du superviseur)
    const delta = nowMin - planned;
    const previewLate = delta > 0 ? delta : 0;
    const previewEarlyRaw = delta < 0 ? Math.min(Math.abs(delta), EARLY_WINDOW) : 0;
    const previewEarly = String(shiftCode || "").toUpperCase() === "MORNING" ? previewEarlyRaw : 0;

    // Générer code + hash cohérent avec /api/checkins/confirm
    const code = genCode6();
    const secret = getCheckinSecret();
    if (!secret) return json(res, 500, { ok: false, error: "MISSING_CHECKIN_CODE_SECRET" });

    const codeHash = sha256Hex(`${code}:${secret}`);

    const { data: existing } = await admin
      .from("daily_checkins")
      .select("id,confirmed_at")
      .eq("day", day)
      .eq("seller_id", sellerId)
      .maybeSingle();

    if (existing?.confirmed_at) return json(res, 409, { ok: false, error: "ALREADY_CONFIRMED" });

    // IMPORTANT: on n'écrit plus early/late ici (sinon ça peut être compté comme "pointage fait")
    const nowIso = new Date().toISOString();
    const { error: upErr } = await admin.from("daily_checkins").upsert(
      {
        day,
        seller_id: sellerId,
        shift_code: shiftCode,
        code_hash: codeHash,
        issued_at: nowIso,
        issued_by: caller.id,
        confirmed_at: null,
        late_minutes: 0,
        early_minutes: 0,
        updated_at: nowIso,
      },
      { onConflict: "day,seller_id" }
    );

    if (upErr) return json(res, 500, { ok: false, error: upErr.message });

    return json(res, 200, {
      ok: true,
      day,
      seller_id: sellerId,
      shift_code: shiftCode,
      // preview pour affichage superviseur (pas écrit en base)
      late_minutes: previewLate,
      early_minutes: previewEarly,
      code,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
