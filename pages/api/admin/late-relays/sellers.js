// pages/api/admin/late-relays/sellers.js
import { createClient } from "@supabase/supabase-js";

function getAdminClient() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

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
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const supabase = getAdminClient();

    let rows = [];

    // 1) Essai via RPC list_sellers (comme l'admin principal)
    try {
      const { data, error } = await supabase.rpc("list_sellers");
      if (!error && Array.isArray(data) && data.length) {
        rows = data.map((r) => ({
          user_id: r.user_id,
          full_name: r.full_name,
        }));
      }
    } catch {}

    // 2) Fallback sur profiles
    if (rows.length === 0) {
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("user_id, full_name, role, active")
          .eq("role", "seller")
          .order("full_name", { ascending: true });

        if (!error && Array.isArray(data) && data.length) {
          rows = data.map((r) => ({
            user_id: r.user_id,
            full_name: r.full_name,
          }));
        }
      } catch {}
    }

    // 3) Fallback sur sellers si besoin
    if (rows.length === 0) {
      try {
        const { data, error } = await supabase
          .from("sellers")
          .select("id, full_name, is_active")
          .eq("is_active", true)
          .order("full_name", { ascending: true });

        if (!error && Array.isArray(data) && data.length) {
          rows = data.map((r) => ({
            user_id: r.id,
            full_name: r.full_name,
          }));
        }
      } catch {}
    }

    rows = (rows || [])
      .filter((r) => r?.user_id && r?.full_name)
      .sort((a, b) =>
        String(a.full_name || "").localeCompare(String(b.full_name || ""), "fr", {
          sensitivity: "base",
        })
      );

    return res.status(200).json({
      ok: true,
      count: rows.length,
      rows,
    });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || "Server error",
      count: 0,
      rows: [],
    });
  }
}