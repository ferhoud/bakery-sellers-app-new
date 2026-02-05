// pages/api/team/events.js
// Upcoming team events (absences + leaves) for "Infos équipe".
// Includes seller names (full_name) + namesById map so UI can show who is concerned.
// Auth: Authorization: Bearer <access_token> required.

import { createClient } from "@supabase/supabase-js";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
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

function addDaysISO(fromISO, days) {
  const d = new Date(`${fromISO}T12:00:00`);
  d.setDate(d.getDate() + days);
  // We only need an ISO date string; using UTC conversion here is fine for a date-only value.
  return d.toISOString().slice(0, 10);
}

function clampInt(x, def, min, max) {
  const n = parseInt(String(x ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sbAnon = anonClient();
    const sbAdmin = adminClient();
    if (!sbAnon) return json(res, 500, { ok: false, error: "Missing public Supabase env" });
    if (!sbAdmin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
    if (auErr || !au?.user) return json(res, 401, { ok: false, error: auErr?.message || "Unauthorized" });

    const today = parisTodayISO();
    const horizonDays = clampInt(req.query?.days, 730, 30, 1460); // default: 2 years
    const toISO = addDaysISO(today, horizonDays);

    // 1) Seller names map (for display)
    const { data: prof, error: pErr } = await sbAdmin
      .from("profiles")
      .select("user_id, full_name, role, active")
      .eq("role", "seller");

    if (pErr) return json(res, 500, { ok: false, error: pErr.message });

    const namesById = {};
    for (const row of prof || []) {
      const id = String(row.user_id || "");
      if (!id) continue;
      const name = (row.full_name || "").toString().trim();
      namesById[id] = name || namesById[id] || "";
    }

    // 2) Upcoming absences
    const { data: abs, error: aErr } = await sbAdmin
      .from("absences")
      .select("id, seller_id, date, status")
      .gte("date", today)
      .lte("date", toISO)
      .in("status", ["pending", "approved"])
      .order("date", { ascending: true });

    if (aErr) return json(res, 500, { ok: false, error: aErr.message });

    const absences = (abs || []).map((a) => {
      const sellerId = String(a.seller_id || "");
      return {
        id: a.id,
        seller_id: sellerId,
        date: (a.date || "").toString().slice(0, 10),
        status: a.status,
        full_name: namesById[sellerId] || "",
      };
    });

    // 3) Upcoming / ongoing leaves (shown until end_date)
    const { data: lv, error: lErr } = await sbAdmin
      .from("leaves")
      .select("id, seller_id, start_date, end_date, status")
      .gte("end_date", today)
      .lte("start_date", toISO)
      .in("status", ["pending", "approved"])
      .order("start_date", { ascending: true });

    if (lErr) return json(res, 500, { ok: false, error: lErr.message });

    const leaves = (lv || []).map((l) => {
      const sellerId = String(l.seller_id || "");
      return {
        id: l.id,
        seller_id: sellerId,
        start_date: (l.start_date || "").toString().slice(0, 10),
        end_date: (l.end_date || "").toString().slice(0, 10),
        status: l.status,
        full_name: namesById[sellerId] || "",
      };
    });

    return json(res, 200, {
      ok: true,
      today,
      from: today,
      to: toISO,
      namesById,
      absences,
      leaves,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
