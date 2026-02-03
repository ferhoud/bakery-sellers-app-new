// pages/api/cron/monthly-hours.js
import { createClient } from "@supabase/supabase-js";

function monthStartUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function addMonthsUTC(d, delta) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
}
function fmtDate(d) {
  // YYYY-MM-DD
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Sécurisation: Vercel envoie automatiquement Authorization: Bearer <CRON_SECRET>
  // si la variable CRON_SECRET est définie dans Vercel.
  const authHeader = req.headers.authorization || "";
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;

  if (!expected || authHeader !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      ok: false,
      error: "Missing env: NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY",
    });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Par défaut: mois courant + mois précédent (UTC)
  const now = new Date();
  const current = monthStartUTC(now);
  const prev = addMonthsUTC(current, -1);

  // Optionnel: ?month=YYYY-MM-01 pour forcer un mois
  const qMonth = (req.query.month || "").toString().trim();
  const months = [];
  if (qMonth) {
    // petite validation simple
    if (!/^\d{4}-\d{2}-\d{2}$/.test(qMonth)) {
      return res.status(400).json({ ok: false, error: "Invalid month param (expected YYYY-MM-DD)" });
    }
    months.push(qMonth);
  } else {
    months.push(fmtDate(prev), fmtDate(current));
  }

  const results = [];
  for (const m of months) {
    const { error } = await supabaseAdmin.rpc("upsert_monthly_hours_for_active_sellers", {
      p_month_start: m,
    });
    results.push({ month_start: m, ok: !error, error: error?.message || null });
    if (error) {
      // on continue quand même, mais on remonte l'info
      console.error("[cron monthly-hours] RPC error for", m, error);
    }
  }

  const okAll = results.every((r) => r.ok);
  return res.status(okAll ? 200 : 207).json({
    ok: okAll,
    months,
    results,
  });
}
