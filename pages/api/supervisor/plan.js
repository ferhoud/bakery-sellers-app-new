// pages/api/supervisor/plan.js
//
// Donne au superviseur (ou admin) le planning + état des pointages.
// Auth: Bearer <jwt> (comme le reste des routes), pas de cookies requis.
//
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

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

function toISODate(x) {
  return (x || "").toString().slice(0, 10);
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function startOfWeekMonday(iso) {
  const [y, m, d] = toISODate(iso).split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  const dow = (dt.getUTCDay() + 6) % 7; // 0=lundi..6=dimanche
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

function addDaysISO(iso, n) {
  const [y, m, d] = toISODate(iso).split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + (Number(n) || 0));
  return dt.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Auth session missing!" });

    const sbAnon = anonClient();
    if (!sbAnon) return json(res, 500, { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
    if (auErr || !au?.user) return json(res, 401, { ok: false, error: auErr?.message || "Unauthorized" });

    const user = au.user;
    const email = (user.email || "").toLowerCase();

    const admin = adminClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    // Autorisation: admin OU user présent dans table supervisors
    let allowed = false;
    if (email && isAdminEmail(email)) {
      allowed = true;
    } else {
      const { data: supRow, error: supErr } = await admin
        .from("supervisors")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (supErr) return json(res, 500, { ok: false, error: supErr.message });
      allowed = !!supRow;
    }

    if (!allowed) return json(res, 403, { ok: false, error: "FORBIDDEN" });

    const q = req.query || {};
    const day = toISODate(q.date || q.day || q.d || parisTodayISO());
    const monday = startOfWeekMonday(day);
    const sunday = addDaysISO(monday, 6);
    const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));

    const { data: shifts, error: shErr } = await admin
      .from("shifts")
      .select("date, shift_code, seller_id")
      .gte("date", monday)
      .lte("date", sunday);

    if (shErr) return json(res, 500, { ok: false, error: shErr.message });

    const { data: absRows, error: abErr } = await admin
      .from("absences")
      .select("seller_id, date, status, reason")
      .gte("date", monday)
      .lte("date", sunday)
      .in("status", ["pending", "approved"]);

    if (abErr) return json(res, 500, { ok: false, error: abErr.message });

    const { data: ckRows, error: ckErr } = await admin
      .from("daily_checkins")
      .select("id, day, seller_id, shift_code, confirmed_at, late_minutes, early_minutes")
      .gte("day", monday)
      .lte("day", sunday);

    if (ckErr) return json(res, 500, { ok: false, error: ckErr.message });

    const sellerIds = uniq([
      ...(Array.isArray(shifts) ? shifts.map((s) => s.seller_id) : []),
      ...(Array.isArray(absRows) ? absRows.map((a) => a.seller_id) : []),
      ...(Array.isArray(ckRows) ? ckRows.map((c) => c.seller_id) : []),
    ]);

    let names = {};
    if (sellerIds.length) {
      const { data: profs, error: pErr } = await admin.from("profiles").select("user_id, full_name").in("user_id", sellerIds);
      if (pErr) return json(res, 500, { ok: false, error: pErr.message });
      for (const p of profs || []) {
        if (!p?.user_id) continue;
        names[p.user_id] = (p.full_name || "").toString();
      }
    }

    const assignments = {};
    for (const s of shifts || []) {
      const d = toISODate(s?.date);
      const sc = String(s?.shift_code || "").toUpperCase();
      if (!d || !sc || !s?.seller_id) continue;
      if (!assignments[d]) assignments[d] = {};
      assignments[d][sc] = { seller_id: s.seller_id, full_name: (names[s.seller_id] || "").trim() };
    }

    const checkins_week = (ckRows || []).map((c) => ({
      ...c,
      full_name: (names[c.seller_id] || "").trim(),
    }));
    const checkins_today = checkins_week.filter((c) => toISODate(c?.day) === day);

    const absences_week = (absRows || []).map((a) => ({
      ...a,
      full_name: (names[a.seller_id] || "").trim(),
    }));
    const absences_today = absences_week.filter((a) => toISODate(a?.date) === day);

    // Map pour l'UI superviseur: absences[YYYY-MM-DD] = [..]
    const absences = {};
    for (const a of absences_week) {
      const d = toISODate(a?.date);
      if (!d) continue;
      if (!absences[d]) absences[d] = [];
      absences[d].push(a);
    }

    return json(res, 200, {
      ok: true,
      day,

      // Compat UI /supervisor
      monday,
      sunday,
      dates,
      absences,

      // Champs historiques (compat)
      week_start: monday,
      week_end: sunday,
      assignments,
      checkins_today,
      checkins_week,
      absences_today,
      absences_week,
      server_now: new Date().toISOString(),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
