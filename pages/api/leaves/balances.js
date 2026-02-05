// pages/api/leaves/balances.js
// Admin/Planner can view & upsert official payslip leave balances (leave_balances).
// Sellers can view their own balance only.
// Auth: Authorization: Bearer <access_token>
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "../../../lib/admin";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m?.[1] || "";
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

function num(x, def = 0) {
  if (x === null || x === undefined || x === "") return def;
  const s = String(x).replace(",", ".").trim();
  const v = Number(s);
  return Number.isFinite(v) ? v : def;
}

async function isPlanner(admin, userId) {
  try {
    const { data, error } = await admin
      .from("planner_access")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return false;
    return !!data?.user_id;
  } catch (_) {
    return false;
  }
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sbAnon = anonClient();
    if (!sbAnon) return json(res, 500, { ok: false, error: "Missing Supabase anon env" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
    if (auErr || !au?.user) return json(res, 401, { ok: false, error: auErr?.message || "Unauthorized" });

    const caller = au.user;

    const admin = serviceClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const canAdmin = isAdminEmail((caller.email || "").toLowerCase());
    const canPlan = !canAdmin ? await isPlanner(admin, caller.id) : true;
    const canManage = canAdmin || canPlan;

    if (req.method === "GET") {
      if (!canManage) {
        const { data: b, error: bErr } = await admin
          .from("leave_balances")
          .select("seller_id,as_of,cp_acquired_n,cp_taken_n,cp_remaining_n,cp_acquired_n1,cp_taken_n1,cp_remaining_n1,updated_at")
          .eq("seller_id", caller.id)
          .maybeSingle();
        if (bErr) return json(res, 500, { ok: false, error: bErr.message });

        return json(res, 200, { ok: true, can_manage: false, balance: b || null });
      }

      // Admin/planner: list all sellers + balances
      const { data: sellers, error: sErr } = await admin
        .from("profiles")
        .select("user_id,full_name,active,role")
        .eq("role", "seller")
        .order("full_name", { ascending: true });

      if (sErr) return json(res, 500, { ok: false, error: sErr.message });

      const ids = (sellers || []).map((x) => x.user_id).filter(Boolean);
      let balances = [];
      if (ids.length > 0) {
        const { data: b, error: bErr } = await admin
          .from("leave_balances")
          .select("seller_id,as_of,cp_acquired_n,cp_taken_n,cp_remaining_n,cp_acquired_n1,cp_taken_n1,cp_remaining_n1,updated_at")
          .in("seller_id", ids);
        if (bErr) return json(res, 500, { ok: false, error: bErr.message });
        balances = b || [];
      }

      const map = new Map();
      balances.forEach((b) => map.set(b.seller_id, b));

      const rows = (sellers || []).map((s) => {
        const b = map.get(s.user_id) || null;
        return {
          seller_id: s.user_id,
          full_name: s.full_name || "",
          active: s.active ?? true,
          as_of: b?.as_of || null,
          cp_acquired_n: num(b?.cp_acquired_n, 0),
          cp_taken_n: num(b?.cp_taken_n, 0),
          cp_remaining_n: num(b?.cp_remaining_n, 0),
          cp_acquired_n1: num(b?.cp_acquired_n1, 0),
          cp_taken_n1: num(b?.cp_taken_n1, 0),
          cp_remaining_n1: num(b?.cp_remaining_n1, 0),
          updated_at: b?.updated_at || null,
        };
      });

      return json(res, 200, { ok: true, can_manage: true, rows });
    }

    if (req.method === "POST") {
      if (!canManage) return json(res, 403, { ok: false, error: "Forbidden" });

      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const seller_id = String(body.seller_id || "").trim();
      const as_of = String(body.as_of || "").trim();

      if (!seller_id) return json(res, 400, { ok: false, error: "Missing seller_id" });
      if (!as_of || !/^\d{4}-\d{2}-\d{2}$/.test(as_of)) return json(res, 400, { ok: false, error: "Bad as_of date" });

      const payload = {
        seller_id,
        as_of,
        cp_acquired_n: num(body.cp_acquired_n, 0),
        cp_taken_n: num(body.cp_taken_n, 0),
        cp_remaining_n: num(body.cp_remaining_n, 0),
        cp_acquired_n1: num(body.cp_acquired_n1, 0),
        cp_taken_n1: num(body.cp_taken_n1, 0),
        cp_remaining_n1: num(body.cp_remaining_n1, 0),
        updated_at: new Date().toISOString(),
        updated_by: caller.id,
      };

      const { error: upErr } = await admin.from("leave_balances").upsert(payload, { onConflict: "seller_id" });
      if (upErr) return json(res, 500, { ok: false, error: upErr.message });

      return json(res, 200, { ok: true });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
