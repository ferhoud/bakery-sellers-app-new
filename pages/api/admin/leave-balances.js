// pages/api/admin/leave-balances.js
/* Admin API: Soldes congés (bulletin)
   - GET: liste vendeuses + balances (admin/planner seulement)
   - POST: upsert balance pour une vendeuse (admin/planner seulement)

   Sécurité:
   - Authorization: Bearer <access_token> (token Supabase)
   - Identification via Supabase Auth (robuste: global headers -> auth.getUser())
   - Autorise si isAdminEmail(email) OU présence dans planner_access
   - Lit/écrit via Service Role (SUPABASE_SERVICE_ROLE_KEY)
*/
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || "";
}

function json(res, status, body) {
  res.status(status).json(body);
}

function safeNum(x) {
  if (x === null || x === undefined || x === "") return 0;
  const s = String(x).replace(",", ".").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function createUserClientWithBearer(jwt) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;

  // ✅ Très robuste (évite le fameux "Auth session missing!" si la version supabase-js
  // ne supporte pas auth.getUser(jwt) ou ignore l’argument)
  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

async function isPlanner(sbAdmin, userId) {
  try {
    const { data, error } = await sbAdmin
      .from("planner_access")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return false;
    return !!data?.user_id;
  } catch {
    return false;
  }
}

async function listSellers(sbAdmin) {
  // 1) RPC list_sellers (si existe)
  try {
    const { data, error } = await sbAdmin.rpc("list_sellers");
    if (!error && Array.isArray(data) && data.length) {
      return data
        .map((r) => ({
          user_id: r.user_id || r.id || r.seller_id,
          full_name: r.full_name || r.name || r.display_name || "",
          active: r.active !== false,
        }))
        .filter((x) => !!x.user_id);
    }
  } catch {}

  // 2) Fallback: profiles.role='seller'
  try {
    const { data, error } = await sbAdmin
      .from("profiles")
      .select("user_id, full_name, role, active")
      .eq("role", "seller")
      .order("full_name", { ascending: true });
    if (!error && Array.isArray(data)) return data;
  } catch {}

  return [];
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const jwt = getBearer(req);
  if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

  const sbUser = createUserClientWithBearer(jwt);
  const sbAdmin = adminClient();
  if (!sbUser) return json(res, 500, { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" });
  if (!sbAdmin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

  // 1) Identify user from token
  const { data: au, error: auErr } = await sbUser.auth.getUser();
  if (auErr || !au?.user) {
    const msg = auErr?.message || "Unauthorized";
    return json(res, 401, { ok: false, error: msg });
  }

  const user = au.user;
  const email = String(user.email || "").trim().toLowerCase();
  const privileged = isAdminEmail(email) || (await isPlanner(sbAdmin, user.id));
  if (!privileged) return json(res, 403, { ok: false, error: "Forbidden" });

  // GET
  if (req.method === "GET") {
    try {
      const sellers = await listSellers(sbAdmin);
      if (!sellers.length) return json(res, 200, { ok: true, rows: [] });

      const ids = sellers.map((s) => s.user_id).filter(Boolean);

      const { data: balances, error: bErr } = await sbAdmin
        .from("leave_balances")
        .select(
          "seller_id, as_of, cp_acquired_n, cp_taken_n, cp_remaining_n, cp_acquired_n1, cp_taken_n1, cp_remaining_n1"
        )
        .in("seller_id", ids);

      if (bErr) return json(res, 500, { ok: false, error: bErr.message });

      const byId = new Map();
      for (const b of balances || []) byId.set(b.seller_id, b);

      const rows = sellers
        .map((s) => {
          const b = byId.get(s.user_id) || null;
          return {
            seller_id: s.user_id,
            full_name: s.full_name || "-",
            active: s.active !== false,
            balance: b
              ? {
                  as_of: b.as_of,
                  cp_acquired_n: Number(b.cp_acquired_n || 0),
                  cp_taken_n: Number(b.cp_taken_n || 0),
                  cp_remaining_n: Number(b.cp_remaining_n || 0),
                  cp_acquired_n1: Number(b.cp_acquired_n1 || 0),
                  cp_taken_n1: Number(b.cp_taken_n1 || 0),
                  cp_remaining_n1: Number(b.cp_remaining_n1 || 0),
                }
              : null,
          };
        })
        .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "fr", { sensitivity: "base" }));

      return json(res, 200, { ok: true, rows });
    } catch (e) {
      return json(res, 500, { ok: false, error: e?.message || "Server error" });
    }
  }

  // POST (upsert)
  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const seller_id = String(body.seller_id || "").trim();
      const as_of = String(body.as_of || "").slice(0, 10);

      if (!seller_id) return json(res, 400, { ok: false, error: "Missing seller_id" });
      if (!as_of) return json(res, 400, { ok: false, error: "Missing as_of" });

      const payload = {
        seller_id,
        as_of,

        cp_acquired_n: safeNum(body.cp_acquired_n),
        cp_taken_n: safeNum(body.cp_taken_n),
        cp_remaining_n: safeNum(body.cp_remaining_n),

        cp_acquired_n1: safeNum(body.cp_acquired_n1),
        cp_taken_n1: safeNum(body.cp_taken_n1),
        cp_remaining_n1: safeNum(body.cp_remaining_n1),

        updated_at: new Date().toISOString(),
        updated_by: user.id,
      };

      const { error: upErr } = await sbAdmin
        .from("leave_balances")
        .upsert(payload, { onConflict: "seller_id" });

      if (upErr) return json(res, 500, { ok: false, error: upErr.message });

      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: e?.message || "Server error" });
    }
  }

  return json(res, 405, { ok: false, error: "Method not allowed" });
}
