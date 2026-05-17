import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function getBearerToken(req) {
  const raw = String(req?.headers?.authorization || "");
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function createAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
  }

  const admin = createAdminClient();
  if (!admin) {
    return res.status(500).json({ ok: false, error: "Missing Supabase server configuration." });
  }

  const from = String(req.query?.from || "").trim();
  const to = String(req.query?.to || "").trim();

  if (!isIsoDate(from) || !isIsoDate(to)) {
    return res.status(400).json({ ok: false, error: "INVALID_DATE_RANGE" });
  }

  if (from > to) {
    return res.status(400).json({ ok: false, error: "INVALID_DATE_ORDER" });
  }

  try {
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    const userId = userData?.user?.id || null;

    if (userErr || !userId) {
      return res.status(401).json({ ok: false, error: "INVALID_SESSION" });
    }

    const { data, error } = await admin
      .from("daily_checkins")
      .select("day, late_minutes, early_minutes, confirmed_at")
      .eq("seller_id", userId)
      .gte("day", from)
      .lte("day", to)
      .not("confirmed_at", "is", null)
      .order("day", { ascending: true });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "CHECKINS_HISTORY_LOAD_FAILED",
      });
    }

    const items = (data || []).map((row) => ({
      day: row?.day || null,
      late_minutes: Number(row?.late_minutes || 0) || 0,
      early_minutes: Number(row?.early_minutes || 0) || 0,
      confirmed_at: row?.confirmed_at || null,
    }));

    return res.status(200).json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "CHECKINS_HISTORY_EXCEPTION",
    });
  }
}
