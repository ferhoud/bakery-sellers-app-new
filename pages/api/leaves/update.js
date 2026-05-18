import { createClient } from "@supabase/supabase-js";

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

async function getUserFromJwt({ url, anonKey, jwt }) {
  const authClient = createClient(url, anonKey, { auth: { persistSession: false } });

  try {
    const { data, error } = await authClient.auth.getUser(jwt);
    if (error) throw error;
    return data?.user || null;
  } catch (_) {
    try {
      const authClient2 = createClient(url, anonKey, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data, error } = await authClient2.auth.getUser();
      if (error) throw error;
      return data?.user || null;
    } catch (_) {
      return null;
    }
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey || !serviceKey) {
    return res.status(500).json({ ok: false, error: "Missing Supabase env vars" });
  }

  const jwt = getBearerToken(req);
  if (!jwt) return res.status(401).json({ ok: false, error: "Missing bearer token" });

  const user = await getUserFromJwt({ url, anonKey, jwt });
  if (!user?.id) return res.status(401).json({ ok: false, error: "Invalid token" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const id = String(body?.id || "").trim();
  const start_date = String(body?.start_date || "").trim();
  const end_date = String(body?.end_date || "").trim();
  const reason = body?.reason == null ? null : String(body.reason).slice(0, 200);

  if (!id) return res.status(400).json({ ok: false, error: "Missing leave id" });
  if (!start_date || !end_date) {
    return res.status(400).json({ ok: false, error: "start_date and end_date are required" });
  }
  if (end_date < start_date) {
    return res.status(400).json({ ok: false, error: "end_date must be >= start_date" });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  if (start_date < todayIso) {
    return res.status(400).json({ ok: false, error: "start_date must be today or later" });
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  try {
    const { data: leave, error: readErr } = await admin
      .from("leaves")
      .select("id, seller_id, status")
      .eq("id", id)
      .maybeSingle();

    if (readErr) throw readErr;
    if (!leave?.id) return res.status(404).json({ ok: false, error: "LEAVE_NOT_FOUND" });
    if (String(leave.seller_id || "") !== String(user.id || "")) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(leave.status || "").toLowerCase() !== "pending") {
      return res.status(409).json({ ok: false, error: "ONLY_PENDING_CAN_BE_UPDATED" });
    }

    const { data, error } = await admin
      .from("leaves")
      .update({
        start_date,
        end_date,
        reason,
      })
      .eq("id", id)
      .eq("seller_id", user.id)
      .eq("status", "pending")
      .select("id, seller_id, start_date, end_date, status, reason, created_at")
      .maybeSingle();

    if (error) throw error;
    if (!data?.id) return res.status(409).json({ ok: false, error: "LEAVE_NOT_UPDATED" });

    return res.status(200).json({ ok: true, leave: data });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "Update failed" });
  }
}
