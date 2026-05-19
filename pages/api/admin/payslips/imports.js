// pages/api/admin/payslips/imports.js
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

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
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
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
  if (!sbAnon) return { error: { status: 500, message: "Missing public Supabase env" } };

  const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
  if (auErr || !au?.user) return { error: { status: 401, message: auErr?.message || "Unauthorized" } };

  const admin = adminClient();
  if (!admin) return { error: { status: 500, message: "Missing SUPABASE_SERVICE_ROLE_KEY" } };

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

function cleanText(v, max = 500) {
  return String(v || "").trim().slice(0, max);
}

function validMonthIso(v) {
  const s = cleanText(v, 10);
  return /^\d{4}-\d{2}-01$/.test(s) ? s : "";
}

export default async function handler(req, res) {
  try {
    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const { admin, user } = auth;

    if (req.method === "GET") {
      const { data, error } = await admin
        .from("payslip_import_batches")
        .select("id, payroll_month, original_filename, original_storage_path, original_file_size, original_mime_type, status, created_by, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) return json(res, 500, { ok: false, error: error.message });
      return json(res, 200, { ok: true, rows: data || [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

      const payroll_month = validMonthIso(body.payroll_month);
      const original_filename = cleanText(body.original_filename, 255);
      const original_storage_path = cleanText(body.original_storage_path, 700);
      const original_file_size = body.original_file_size == null ? null : Number(body.original_file_size || 0);
      const original_mime_type = cleanText(body.original_mime_type || "application/pdf", 120);

      if (!payroll_month) return json(res, 400, { ok: false, error: "Invalid payroll_month" });
      if (!original_filename) return json(res, 400, { ok: false, error: "Missing original_filename" });
      if (!original_storage_path) return json(res, 400, { ok: false, error: "Missing original_storage_path" });

      const payload = {
        payroll_month,
        original_filename,
        original_storage_path,
        original_file_size: Number.isFinite(original_file_size) ? Math.max(0, Math.round(original_file_size)) : null,
        original_mime_type: original_mime_type || "application/pdf",
        status: "uploaded",
        created_by: user.id,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await admin
        .from("payslip_import_batches")
        .insert(payload)
        .select("id, payroll_month, original_filename, original_storage_path, original_file_size, original_mime_type, status, created_by, created_at, updated_at")
        .single();

      if (error) return json(res, 500, { ok: false, error: error.message });
      return json(res, 200, { ok: true, row: data });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
