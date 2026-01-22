// pages/api/replacements/open.js
import { createClient } from "@supabase/supabase-js";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function sortShift(a, b) {
  const order = { MORNING: 1, MIDDAY: 2, SUNDAY_EXTRA: 3, EVENING: 4 };
  return (order[a] || 99) - (order[b] || 99);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !ANON) return json(res, 500, { ok: false, error: "Missing SUPABASE env" });
  if (!SR) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

  const token = getBearer(req);
  if (!token) return json(res, 401, { ok: false, error: "NO_AUTH" });

  const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
  const admin = createClient(SUPABASE_URL, SR, { auth: { persistSession: false } });

  const { data: u, error: uErr } = await anon.auth.getUser(token);
  if (uErr || !u?.user?.id) return json(res, 401, { ok: false, error: "BAD_TOKEN" });

  const userId = u.user.id;

  const from = String(req.query?.from || "");
  const to = String(req.query?.to || "");

  if (!isISODate(from) || !isISODate(to)) {
    return json(res, 400, { ok: false, error: "BAD_RANGE" });
  }

  // Absences approuvées sur la période (hors moi)
  const { data: absRows, error: absErr } = await admin
    .from("absences")
    .select("id, seller_id, date, status")
    .eq("status", "approved")
    .neq("seller_id", userId)
    .gte("date", from)
    .lte("date", to);

  if (absErr) return json(res, 500, { ok: false, error: absErr.message || "ABSENCES_FAILED" });

  const abs = (absRows || []).filter((a) => a?.id && a?.seller_id && a?.date);
  if (abs.length === 0) return json(res, 200, { ok: true, items: [] });

  const absenceIds = Array.from(new Set(abs.map((a) => a.id)));
  const absentIds = Array.from(new Set(abs.map((a) => a.seller_id)));
  const dateSet = Array.from(new Set(abs.map((a) => a.date)));

  // Noms
  let nameById = {};
  const { data: profs } = await admin.from("profiles").select("user_id, full_name").in("user_id", absentIds);
  (profs || []).forEach((p) => {
    if (p?.user_id) nameById[p.user_id] = p.full_name || "";
  });

  // Shifts encore assignés à l'absente
  const { data: shiftsRows, error: shErr } = await admin
    .from("shifts")
    .select("date, shift_code, seller_id")
    .in("seller_id", absentIds)
    .in("date", dateSet);

  if (shErr) return json(res, 500, { ok: false, error: shErr.message || "SHIFTS_FAILED" });

  const shiftsBySellerDate = new Map();
  (shiftsRows || []).forEach((r) => {
    if (!r?.seller_id || !r?.date || !r?.shift_code) return;
    const k = `${r.seller_id}|${r.date}`;
    const arr = shiftsBySellerDate.get(k) || [];
    arr.push(r.shift_code);
    shiftsBySellerDate.set(k, arr);
  });

  // Exclure déjà acceptés
  const { data: riRows, error: riErr } = await admin
    .from("replacement_interest")
    .select("absence_id, accepted_shift_code, status")
    .eq("status", "accepted")
    .in("absence_id", absenceIds);

  if (riErr) return json(res, 500, { ok: false, error: riErr.message || "REPL_FAILED" });

  const acceptedSet = new Set();
  (riRows || []).forEach((r) => {
    const sc = r?.accepted_shift_code;
    if (r?.absence_id && sc) acceptedSet.add(`${r.absence_id}|${sc}`);
  });

  const items = [];
  for (const a of abs) {
    const k = `${a.seller_id}|${a.date}`;
    const codes = (shiftsBySellerDate.get(k) || []).slice().sort(sortShift);
    for (const c of codes) {
      if (acceptedSet.has(`${a.id}|${c}`)) continue;
      items.push({
        absence_id: a.id,
        date: a.date,
        shift_code: c,
        absent_id: a.seller_id,
        absent_name: nameById[a.seller_id] || "",
      });
    }
  }

  return json(res, 200, { ok: true, items });
}
