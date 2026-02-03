// pages/api/leaves/balance.js
//
// Retourne le solde CP "officiel" (bulletin de paie) pour l'utilisateur connecté.
// Table attendue : public.leave_balances
//
// Réponse 200: { ok:true, balance:{ as_of, cp_acquired_n, cp_taken_n, cp_remaining_n, cp_acquired_n1, cp_taken_n1, cp_remaining_n1, updated_at } }
// Réponse 404: { ok:false, error:"NOT_SET" }
//
import { createClient } from "@supabase/supabase-js";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || "";
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sbAnon = anonClient();
    if (!sbAnon) return json(res, 500, { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
    if (auErr || !au?.user) return json(res, 401, { ok: false, error: auErr?.message || "Unauthorized" });

    const admin = adminClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const { data, error } = await admin
      .from("leave_balances")
      .select(
        "as_of, cp_acquired_n, cp_taken_n, cp_remaining_n, cp_acquired_n1, cp_taken_n1, cp_remaining_n1, updated_at"
      )
      .eq("seller_id", au.user.id)
      .maybeSingle();

    if (error) return json(res, 500, { ok: false, error: error.message });
    if (!data) return json(res, 404, { ok: false, error: "NOT_SET" });

    return json(res, 200, { ok: true, balance: data });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
