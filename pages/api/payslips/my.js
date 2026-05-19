// pages/api/payslips/my.js
import { createClient } from "@supabase/supabase-js";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || "";
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
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
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing bearer token" });

    const sbAnon = anonClient();
    const admin = adminClient();
    if (!sbAnon) return json(res, 500, { ok: false, error: "Missing public Supabase env" });
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
    if (auErr || !au?.user) {
      return json(res, 401, { ok: false, error: auErr?.message || "Unauthorized" });
    }

    const user = au.user;

    const { data, error } = await admin
      .from("employee_payslips")
      .select("id, payroll_month, employee_display_name, storage_path, extracted_leave_balance, created_at, updated_at")
      .eq("employee_user_id", user.id)
      .not("storage_path", "is", null)
      .order("payroll_month", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) return json(res, 500, { ok: false, error: error.message });

    return json(res, 200, { ok: true, rows: data || [] });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
