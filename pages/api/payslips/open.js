// pages/api/payslips/open.js
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

const STORAGE_BUCKET = "employee-payslips";

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

async function requireUser(req) {
  const jwt = getBearer(req);
  if (!jwt) return { error: { status: 401, message: "Missing bearer token" } };

  const sbAnon = anonClient();
  const admin = adminClient();
  if (!sbAnon) return { error: { status: 500, message: "Missing public Supabase env" } };
  if (!admin) return { error: { status: 500, message: "Missing SUPABASE_SERVICE_ROLE_KEY" } };

  const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
  if (auErr || !au?.user) {
    return { error: { status: 401, message: auErr?.message || "Unauthorized" } };
  }

  const user = au.user;
  const email = String(user.email || "").toLowerCase();
  if (email && isAdminEmail(email)) return { admin, user, isAdmin: true };

  const { data: prof, error: pErr } = await admin
    .from("profiles")
    .select("user_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (pErr) return { error: { status: 500, message: pErr.message } };

  return {
    admin,
    user,
    isAdmin: String(prof?.role || "").toLowerCase() === "admin",
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const auth = await requireUser(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const payslipId = String(body?.payslip_id || body?.id || "").trim();
    if (!payslipId) return json(res, 400, { ok: false, error: "Missing payslip_id" });

    const { data: row, error: rowErr } = await auth.admin
      .from("employee_payslips")
      .select("id, employee_user_id, employee_display_name, payroll_month, storage_path")
      .eq("id", payslipId)
      .maybeSingle();

    if (rowErr) return json(res, 500, { ok: false, error: rowErr.message });
    if (!row?.id) return json(res, 404, { ok: false, error: "PAYSLIP_NOT_FOUND" });
    if (!row?.storage_path) return json(res, 409, { ok: false, error: "PAYSLIP_PDF_NOT_READY" });

    const ownsPayslip = String(row.employee_user_id || "") === String(auth.user.id || "");
    if (!auth.isAdmin && !ownsPayslip) {
      return json(res, 403, { ok: false, error: "FORBIDDEN" });
    }

    const { data: signed, error: signedErr } = await auth.admin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(row.storage_path, 120);

    if (signedErr) return json(res, 500, { ok: false, error: signedErr.message });

    const url =
      signed?.signedUrl ||
      signed?.signedURL ||
      signed?.signed_url ||
      "";

    if (!url) return json(res, 500, { ok: false, error: "SIGNED_URL_MISSING" });

    return json(res, 200, {
      ok: true,
      url,
      expires_in_seconds: 120,
      payslip: {
        id: row.id,
        employee_display_name: row.employee_display_name || null,
        payroll_month: row.payroll_month || null,
      },
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
