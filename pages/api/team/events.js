// pages/api/team/events.js
// Retourne les absences + congés de l'équipe sur une période [from..to].
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

  const from = String(req.query?.from || req.query?.start || "").slice(0, 10);
  const to = String(req.query?.to || req.query?.end || "").slice(0, 10);

  if (!isIsoDate(from) || !isIsoDate(to)) {
    res.status(400).json({ ok: false, error: "Bad date range" });
    return;
  }

  // Vérifie le JWT
  const sbAuth = createClient(url, anon, { auth: { persistSession: false } });
  const { data: uData, error: uErr } = await sbAuth.auth.getUser(token);
  if (uErr || !uData?.user) {
    res.status(401).json({ ok: false, error: uErr?.message || "Unauthorized" });
    return;
  }

  const sb = createClient(url, service, { auth: { persistSession: false } });

  // Absences : dans la fenêtre
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

  // Congés : chevauchement avec la fenêtre
  let leaves = [];
  try {
    const { data, error } = await sb
      .from("leaves")
      .select("seller_id, start_date, end_date, status")
      .lte("start_date", to)
      .gte("end_date", from)
      .in("status", ["approved", "pending"])
      .order("start_date", { ascending: true });

    if (!error && Array.isArray(data)) leaves = data;
  } catch (_) {}

  res.status(200).json({ ok: true, absences, leaves });
}
