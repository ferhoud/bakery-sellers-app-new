// pages/api/team/events.js
// Infos équipe (absences + congés) à venir.
// Règle : on affiche une info tant qu'elle n'est pas passée.
// - Absences: date >= aujourd'hui (heure Europe/Paris)
// - Congés: end_date >= aujourd'hui (et start_date <= to pour éviter des listes infinies)
// Protégé par JWT (Authorization: Bearer <token>), requêtes serveur via SERVICE_ROLE.

import { createClient } from "@supabase/supabase-js";

function getBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
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

function addDaysISO(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const token = getBearer(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "Missing Authorization Bearer token" });
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anon || !service) {
    res.status(500).json({ ok: false, error: "Missing Supabase env" });
    return;
  }

  const today = parisTodayISO();

  // On accepte un horizon via query, mais on ne montre jamais avant today.
  const qFromRaw = String(req.query?.from || req.query?.start || "").slice(0, 10);
  const qToRaw = String(req.query?.to || req.query?.end || "").slice(0, 10);

  const from = isIsoDate(qFromRaw) ? (qFromRaw < today ? today : qFromRaw) : today;

  // horizon par défaut: 2 ans, pour couvrir les absences/congés planifiés loin
  const defaultTo = addDaysISO(today, 730);
  const to = isIsoDate(qToRaw) ? qToRaw : defaultTo;

  // Vérifie le JWT
  const sbAuth = createClient(url, anon, { auth: { persistSession: false } });
  const { data: uData, error: uErr } = await sbAuth.auth.getUser(token);
  if (uErr || !uData?.user) {
    res.status(401).json({ ok: false, error: uErr?.message || "Unauthorized" });
    return;
  }

  const sb = createClient(url, service, { auth: { persistSession: false } });

  // Absences à venir: date >= from et <= to
  let absences = [];
  try {
    const { data, error } = await sb
      .from("absences")
      .select("seller_id, date, status")
      .gte("date", from)
      .lte("date", to)
      .in("status", ["approved", "pending"])
      .order("date", { ascending: true });

    if (!error && Array.isArray(data)) absences = data;
  } catch (_) {}

  // Congés à venir ou en cours:
  // - end_date >= from (donc pas de congé terminé)
  // - start_date <= to (évite de charger des congés très lointains si tu veux limiter)
  let leaves = [];
  try {
    const { data, error } = await sb
      .from("leaves")
      .select("seller_id, start_date, end_date, status")
      .gte("end_date", from)
      .lte("start_date", to)
      .in("status", ["approved", "pending"])
      .order("start_date", { ascending: true });

    if (!error && Array.isArray(data)) leaves = data;
  } catch (_) {}

  res.status(200).json({ ok: true, today, from, to, absences, leaves });
}
