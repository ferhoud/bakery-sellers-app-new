// pages/api/leaves/balance.js
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

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

async function isPlanner(admin, userId) {
  const { data, error } = await admin
    .from("planner_access")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return !!data?.user_id;
}

function safeNum(x) {
  if (x === null || x === undefined || x === "") return 0;
  const s = String(x).replace(",", ".").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sbAnon = anonClient();
    const sbAdmin = adminClient();
    if (!sbAnon) return json(res, 500, { ok: false, error: "Missing public Supabase env" });
    if (!sbAdmin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
    if (auErr || !au?.user) return json(res, 401, { ok: false, error: auErr?.message || "Unauthorized" });

    const user = au.user;
    const email = (user.email || "").toLowerCase();
    const adminByEmail = isAdminEmail(email);
    const planner = adminByEmail ? true : await isPlanner(sbAdmin, user.id);
    const isPrivileged = adminByEmail || planner;

    // ---- GET ----
    if (req.method === "GET") {
      if (isPrivileged) {
        // Liste vendeuses + balances
        const { data: sellers, error: sErr } = await sbAdmin
          .from("profiles")
          .select("user_id, full_name, role, active")
          .eq("role", "seller")
          .order("full_name", { ascending: true });

        if (sErr) return json(res, 500, { ok: false, error: sErr.message });

        const sellerIds = (sellers || []).map((x) => x.user_id);

        const { data: balances, error: bErr } = await sbAdmin
          .from("leave_balances")
          .select("*")
          .in("seller_id", sellerIds);

        if (bErr) return json(res, 500, { ok: false, error: bErr.message });

        const byId = new Map();
        for (const b of balances || []) byId.set(b.seller_id, b);

        const rows = (sellers || []).map((s) => {
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
        });

        return json(res, 200, { ok: true, mode: "admin", rows });
      }

      // Vendeuse: son solde
      const { data: b, error: bErr } = await sbAdmin
        .from("leave_balances")
        .select("*")
        .eq("seller_id", user.id)
        .maybeSingle();

      if (bErr) return json(res, 500, { ok: false, error: bErr.message });

      return json(res, 200, {
        ok: true,
        mode: "seller",
        seller_id: user.id,
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
      });
    }

    // ---- POST (admin/planner) ----
    if (req.method === "POST") {
      if (!isPrivileged) return json(res, 403, { ok: false, error: "Forbidden" });

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
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
