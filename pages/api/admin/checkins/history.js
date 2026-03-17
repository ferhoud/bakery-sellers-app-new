// pages/api/admin/checkins/history.js
import { createClient } from "@supabase/supabase-js";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1] : "";
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return null;
  return createClient(url, service, { auth: { persistSession: false } });
}

function nowParisYmd() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseMonth(value) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!y || mo < 1 || mo > 12) return null;
  return { year: y, month: mo };
}

function rangeForMonth(monthValue) {
  const parsed = parseMonth(monthValue);
  const now = new Date();
  const year = parsed?.year || now.getFullYear();
  const month = parsed?.month || now.getMonth() + 1;
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    month: `${year}-${String(month).padStart(2, "0")}`,
    from: iso(first),
    to: iso(last),
  };
}

function parseIsoDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}


function plannedTimeFromShift(code) {
  const sc = String(code || "").toUpperCase();
  if (sc === "EVENING") return "13:30";
  if (sc === "SUNDAY_EXTRA") return "09:00";
  return "06:30";
}

function shiftLabel(code) {
  const sc = String(code || "").toUpperCase();
  if (sc === "MORNING") return "Matin";
  if (sc === "MIDDAY") return "Midi";
  if (sc === "EVENING") return "Soir";
  if (sc === "SUNDAY_EXTRA") return "Dimanche 9h-13h30";
  return code || "-";
}

function formatDateFr(iso) {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("fr-FR", {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatTimeParis(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString("fr-FR", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

function safeTs(value) {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function isBetterCheckinRow(nextRow, currentRow) {
  if (!currentRow) return true;

  const nextConfirmed = !!nextRow?.confirmed_at;
  const currentConfirmed = !!currentRow?.confirmed_at;
  if (nextConfirmed !== currentConfirmed) return nextConfirmed;

  const nextTs = Math.max(
    safeTs(nextRow?.confirmed_at),
    safeTs(nextRow?.updated_at),
    safeTs(nextRow?.created_at)
  );
  const currentTs = Math.max(
    safeTs(currentRow?.confirmed_at),
    safeTs(currentRow?.updated_at),
    safeTs(currentRow?.created_at)
  );

  if (nextTs !== currentTs) return nextTs > currentTs;
  return String(nextRow?.id || "") > String(currentRow?.id || "");
}

function buildStatus({ date, hasShift, confirmedAt, hasCheckinRow, today }) {
  if (confirmedAt) return { code: "confirmed", label: "Pointé" };
  if (date > today) return { code: "upcoming", label: "À venir" };
  if (hasShift && hasCheckinRow) return { code: "issued_unconfirmed", label: "Code émis non confirmé" };
  if (hasShift) return { code: "missing", label: "Non pointé" };
  if (hasCheckinRow) return { code: "orphan", label: "Pointage hors planning" };
  return { code: "unknown", label: "-" };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

    const token = getBearer(req);
    if (!token) return json(res, 401, { ok: false, error: "NO_AUTH" });

    const anon = anonClient();
    const admin = adminClient();
    if (!anon || !admin) return json(res, 500, { ok: false, error: "MISSING_SUPABASE_ENV" });

    const { data: authData, error: authErr } = await anon.auth.getUser(token);
    const user = authData?.user || null;
    if (authErr || !user) return json(res, 401, { ok: false, error: "BAD_AUTH" });

    const adminEmail = String(user.email || "").toLowerCase();
    const { data: meProfile } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    const isAdmin = adminEmail === "" ? false : (adminEmail === process.env.NEXT_PUBLIC_ADMIN_EMAIL || meProfile?.role === "admin");
    if (!isAdmin) return json(res, 403, { ok: false, error: "FORBIDDEN" });

    const sellerId = String(req.query.seller_id || "").trim();
    const range = rangeForMonth(req.query.month);
    const day = parseIsoDay(req.query.day);
    const from = day || range.from;
    const to = day || range.to;
    const today = nowParisYmd();

    const sellerMapObj = new Map();

    const { data: sellersRows, error: sellersErr } = await admin
      .from("sellers")
      .select("id, full_name, is_active")
      .order("full_name", { ascending: true });
    if (sellersErr) return json(res, 500, { ok: false, error: sellersErr.message || "SELLERS_FAILED" });

    for (const s of sellersRows || []) {
      sellerMapObj.set(s.id, { id: s.id, full_name: s.full_name || s.id, is_active: s.is_active !== false });
    }

    const { data: profileSellerRows } = await admin
      .from("profiles")
      .select("user_id, full_name, active, role")
      .eq("role", "seller")
      .order("full_name", { ascending: true });

    for (const p of profileSellerRows || []) {
      if (!p?.user_id) continue;
      if (!sellerMapObj.has(p.user_id)) {
        sellerMapObj.set(p.user_id, { id: p.user_id, full_name: p.full_name || p.user_id, is_active: p.active !== false });
      }
    }

    const sellers = Array.from(sellerMapObj.values()).sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""), "fr"));
    const sellerMap = Object.fromEntries(sellers.map((s) => [s.id, s]));

    let shiftsQuery = admin
      .from("shifts")
      .select("date, seller_id, shift_code")
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: false });
    if (sellerId) shiftsQuery = shiftsQuery.eq("seller_id", sellerId);
    const { data: shiftRows, error: shiftsErr } = await shiftsQuery;
    if (shiftsErr) return json(res, 500, { ok: false, error: shiftsErr.message || "SHIFTS_FAILED" });

    let checkinsQuery = admin
      .from("daily_checkins")
      .select("id, day, seller_id, shift_code, confirmed_at, late_minutes, early_minutes, created_at, updated_at")
      .gte("day", from)
      .lte("day", to)
      .order("day", { ascending: false })
      .order("created_at", { ascending: false });
    if (sellerId) checkinsQuery = checkinsQuery.eq("seller_id", sellerId);
    const { data: checkinRows, error: checkinsErr } = await checkinsQuery;
    if (checkinsErr) return json(res, 500, { ok: false, error: checkinsErr.message || "CHECKINS_FAILED" });

    const checkinMap = new Map();
    for (const row of checkinRows || []) {
      const key = `${row.day}|${row.seller_id}`;
      const current = checkinMap.get(key) || null;
      if (isBetterCheckinRow(row, current)) checkinMap.set(key, row);
    }

    const bestCheckinRows = Array.from(checkinMap.values());

    const rows = [];
    const shiftKeys = new Set();

    for (const sh of shiftRows || []) {
      const key = `${sh.date}|${sh.seller_id}`;
      shiftKeys.add(key);
      const ci = checkinMap.get(key) || null;
      const status = buildStatus({
        date: sh.date,
        hasShift: true,
        confirmedAt: ci?.confirmed_at,
        hasCheckinRow: !!ci,
        today,
      });
      rows.push({
        key: `${sh.date}|${sh.seller_id}|${sh.shift_code}`,
        date: sh.date,
        date_label: formatDateFr(sh.date),
        seller_id: sh.seller_id,
        seller_name: sellerMap[sh.seller_id]?.full_name || sh.seller_id,
        shift_code: sh.shift_code,
        shift_label: shiftLabel(sh.shift_code),
        planned_time: plannedTimeFromShift(sh.shift_code),
        actual_time: formatTimeParis(ci?.confirmed_at),
        confirmed_at: ci?.confirmed_at || null,
        late_minutes: Number(ci?.late_minutes || 0) || 0,
        early_minutes: Number(ci?.early_minutes || 0) || 0,
        status_code: status.code,
        status_label: status.label,
        source_label: ci?.confirmed_at ? "Planning + pointage" : "Planning",
        is_scheduled: true,
        is_missing: status.code === "missing" || status.code === "issued_unconfirmed",
      });
    }

    for (const ci of bestCheckinRows) {
      const key = `${ci.day}|${ci.seller_id}`;
      if (shiftKeys.has(key)) continue;
      const status = buildStatus({
        date: ci.day,
        hasShift: false,
        confirmedAt: ci.confirmed_at,
        hasCheckinRow: true,
        today,
      });
      rows.push({
        key: `${ci.day}|${ci.seller_id}|orphan|${ci.id}`,
        date: ci.day,
        date_label: formatDateFr(ci.day),
        seller_id: ci.seller_id,
        seller_name: sellerMap[ci.seller_id]?.full_name || ci.seller_id,
        shift_code: ci.shift_code,
        shift_label: shiftLabel(ci.shift_code),
        planned_time: plannedTimeFromShift(ci.shift_code),
        actual_time: formatTimeParis(ci.confirmed_at),
        confirmed_at: ci.confirmed_at || null,
        late_minutes: Number(ci.late_minutes || 0) || 0,
        early_minutes: Number(ci.early_minutes || 0) || 0,
        status_code: status.code,
        status_label: status.label,
        source_label: ci.confirmed_at ? "Pointage seul" : "Code émis seul",
        is_scheduled: false,
        is_missing: false,
      });
    }

    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.seller_name !== b.seller_name) return String(a.seller_name).localeCompare(String(b.seller_name), "fr");
      return String(a.shift_label).localeCompare(String(b.shift_label), "fr");
    });

    const summary = {
      month: range.month,
      total_rows: rows.length,
      scheduled_rows: rows.filter((r) => r.is_scheduled).length,
      confirmed_rows: rows.filter((r) => r.status_code === "confirmed").length,
      missing_rows: rows.filter((r) => r.is_missing).length,
      late_minutes: rows.reduce((n, r) => n + (Number(r.late_minutes || 0) || 0), 0),
      early_minutes: rows.reduce((n, r) => n + (Number(r.early_minutes || 0) || 0), 0),
    };

    return json(res, 200, {
      ok: true,
      month: range.month,
      from,
      to,
      selected_day: day || "",
      today,
      sellers,
      rows,
      summary,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "SERVER_ERROR" });
  }
}
