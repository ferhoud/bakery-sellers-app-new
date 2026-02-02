import { createClient } from "@supabase/supabase-js";

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

async function getUserFromJwt({ url, anonKey, jwt }) {
  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false },
  });

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
    } catch (e2) {
      return null;
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey || !serviceKey) {
    return res.status(500).json({ error: "Missing Supabase env vars" });
  }

  const jwt = getBearerToken(req);
  if (!jwt) return res.status(401).json({ error: "Missing bearer token" });

  const user = await getUserFromJwt({ url, anonKey, jwt });
  if (!user?.id) return res.status(401).json({ error: "Invalid token" });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  try {
    const { data, error } = await admin
      .from("leaves")
      .select("id, seller_id, start_date, end_date, status, reason, created_at")
      .eq("seller_id", user.id)
      .order("start_date", { ascending: false });

    if (error) throw error;

    return res.status(200).json({ ok: true, leaves: data || [] });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Select failed" });
  }
}
