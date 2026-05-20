import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h || ""));
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

async function requireAdmin(req) {
  const jwt = getBearer(req);
  if (!jwt) return { error: { status: 401, message: "Auth session missing!" } };

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
  if (email && isAdminEmail(email)) return { admin, user };

  const { data: prof, error: pErr } = await admin
    .from("profiles")
    .select("user_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (pErr) return { error: { status: 500, message: pErr.message } };
  if (String(prof?.role || "").toLowerCase() !== "admin") {
    return { error: { status: 403, message: "FORBIDDEN" } };
  }

  return { admin, user };
}


import { parsePayrollMonth } from "@/lib/server/payrollEmail";

function bodyObject(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (_) {
      return {};
    }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const body = bodyObject(req);
    const month = parsePayrollMonth(body?.month || body?.payroll_month || "");
    const employeeId = String(body?.employee_id || "").trim();
    const note = String(body?.note || "").trim();

    if (!month) return json(res, 400, { ok: false, error: "Mois invalide." });
    if (!employeeId) return json(res, 400, { ok: false, error: "employee_id manquant." });

    if (!note) {
      const { error: delErr } = await auth.admin
        .from("payroll_email_monthly_notes")
        .delete()
        .eq("payroll_month", month.payroll_month)
        .eq("employee_id", employeeId);

      if (delErr) throw delErr;
      return json(res, 200, { ok: true, deleted: true, note: "" });
    }

    const payload = {
      payroll_month: month.payroll_month,
      employee_id: employeeId,
      note,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await auth.admin
      .from("payroll_email_monthly_notes")
      .upsert(payload, { onConflict: "payroll_month,employee_id" })
      .select("id, payroll_month, employee_id, note, updated_at")
      .single();

    if (error) throw error;
    return json(res, 200, { ok: true, row: data });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
