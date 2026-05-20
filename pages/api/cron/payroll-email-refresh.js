import { createClient } from "@supabase/supabase-js";
import { refreshPayrollEmailRecord } from "@/lib/server/payrollEmail";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

function parisMonthValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  return /^\d{4}$/.test(year) && /^\d{2}$/.test(month) ? `${year}-${month}` : "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const authHeader = String(req.headers.authorization || req.headers.Authorization || "");
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return json(res, 401, { ok: false, error: "Unauthorized cron request" });
    }

    const admin = adminClient();
    if (!admin) {
      return json(res, 500, { ok: false, error: "Missing Supabase service env" });
    }

    const month = parisMonthValue();
    if (!month) {
      return json(res, 500, { ok: false, error: "Impossible de déterminer le mois courant Europe/Paris." });
    }

    const result = await refreshPayrollEmailRecord(admin, month, { source: "cron_daily" });

    return json(res, 200, {
      ok: true,
      month,
      created: !!result?.created,
      changed: !!result?.changed,
      row_id: result?.row?.id || null,
      needs_review: !!result?.row?.needs_review,
      status: result?.row?.status || null,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
