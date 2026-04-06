import { createClient } from "@supabase/supabase-js";

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed", rows: [] });
  }

  const date = String(req.query?.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date", rows: [] });
  }

  try {
    const supabase = getAdminClient();

    let rows = [];

    // 1) Priorité à la table shifts
    try {
      const { data, error } = await supabase
        .from("shifts")
        .select("date, shift_code, seller_id")
        .eq("date", date)
        .in("shift_code", ["MORNING", "MIDDAY", "EVENING", "SUNDAY_EXTRA"]);

      if (!error && Array.isArray(data) && data.length) {
        rows = data;
      }
    } catch {}

    // 2) Fallback éventuel sur la vue week assignments
    if (rows.length === 0) {
      try {
        const { data, error } = await supabase
          .from("view_week_assignments")
          .select("date, shift_code, seller_id")
          .eq("date", date);
        if (!error && Array.isArray(data) && data.length) {
          rows = data;
        }
      } catch {}
    }

    // enrich names from sellers/profiles best effort
    const ids = Array.from(new Set(rows.map((r) => r.seller_id).filter(Boolean)));
    let namesById = new Map();

    if (ids.length) {
      try {
        const { data } = await supabase.from("sellers").select("id, full_name").in("id", ids);
        if (Array.isArray(data)) {
          data.forEach((r) => namesById.set(r.id, r.full_name || ""));
        }
      } catch {}
      try {
        const missing = ids.filter((id) => !namesById.has(id));
        if (missing.length) {
          const { data } = await supabase.from("profiles").select("user_id, full_name").in("user_id", missing);
          if (Array.isArray(data)) {
            data.forEach((r) => namesById.set(r.user_id, r.full_name || ""));
          }
        }
      } catch {}
    }

    const finalRows = rows.map((r) => ({
      date: r.date,
      shift_code: r.shift_code,
      seller_id: r.seller_id,
      full_name: r.full_name || namesById.get(r.seller_id) || "",
    }));

    return res.status(200).json({ ok: true, date, planned: true, rows: finalRows });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error", rows: [] });
  }
}
