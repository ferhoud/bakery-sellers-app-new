// pages/api/admin/payslips/split.js
import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
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

function safePart(value, fallback = "fiche") {
  const s = String(value || fallback)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || fallback;
}

function monthFolder(payrollMonth) {
  const s = String(payrollMonth || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : "mois-inconnu";
}

async function downloadBatchPdf(admin, storagePath) {
  const { data, error } = await admin.storage.from(STORAGE_BUCKET).download(storagePath);
  if (error) throw error;
  if (!data) throw new Error("PDF source introuvable dans le stockage.");
  const ab = await data.arrayBuffer();
  return Buffer.from(ab);
}

async function loadSellerProfiles(admin) {
  const { data, error } = await admin
    .from("profiles")
    .select("user_id, full_name, role, active")
    .eq("role", "seller");

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function enrichRowsWithNames(rows, profiles) {
  const byId = new Map((profiles || []).map((p) => [String(p.user_id), p.full_name || ""]));
  return (rows || []).map((r) => ({
    ...r,
    matched_profile_name: r.employee_user_id ? byId.get(String(r.employee_user_id)) || "" : "",
  }));
}

async function createOnePagePdf(originalPdf, pageIndex) {
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(originalPdf, [pageIndex]);
  out.addPage(copied);
  const bytes = await out.save();
  return Buffer.from(bytes);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const { admin } = auth;
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const batchId = String(body.batch_id || "").trim();
    if (!batchId) return json(res, 400, { ok: false, error: "Missing batch_id" });

    const { data: batch, error: batchErr } = await admin
      .from("payslip_import_batches")
      .select("id, payroll_month, original_storage_path, status")
      .eq("id", batchId)
      .maybeSingle();

    if (batchErr) return json(res, 500, { ok: false, error: batchErr.message });
    if (!batch?.id) return json(res, 404, { ok: false, error: "IMPORT_BATCH_NOT_FOUND" });

    const { data: rows, error: rowsErr } = await admin
      .from("employee_payslips")
      .select(
        "id, batch_id, employee_user_id, employee_display_name, payroll_month, storage_path, original_page_start, original_page_end, match_status, match_confidence, extracted_leave_balance, created_at, updated_at"
      )
      .eq("batch_id", batchId)
      .order("original_page_start", { ascending: true });

    if (rowsErr) return json(res, 500, { ok: false, error: rowsErr.message });
    if (!Array.isArray(rows) || rows.length === 0) {
      return json(res, 409, { ok: false, error: "NO_ANALYSIS_FOUND_FOR_BATCH" });
    }

    const sourceBuffer = await downloadBatchPdf(admin, batch.original_storage_path);
    const sourcePdf = await PDFDocument.load(sourceBuffer);
    const totalPages = sourcePdf.getPageCount();

    let createdCount = 0;
    let skippedCount = 0;

    for (const row of rows) {
      if (row?.storage_path) {
        skippedCount += 1;
        continue;
      }

      const pageStart = Number(row?.original_page_start || 0);
      const pageEnd = Number(row?.original_page_end || pageStart || 0);
      if (!Number.isInteger(pageStart) || pageStart < 1 || pageStart > totalPages) {
        throw new Error(`Page invalide pour la fiche ${row?.employee_display_name || row?.id || "?"}.`);
      }
      if (pageEnd !== pageStart) {
        throw new Error("Le découpage multi-page sera pris en charge dans une étape ultérieure.");
      }

      const pageIndex = pageStart - 1;
      const pdfBytes = await createOnePagePdf(sourcePdf, pageIndex);

      const folder = monthFolder(row?.payroll_month || batch.payroll_month);
      const pageLabel = String(pageStart).padStart(2, "0");
      const personPart = safePart(row?.employee_display_name || `page_${pageLabel}`);
      const storagePath = `individual/${folder}/batch-${batchId}/page-${pageLabel}-${personPart}.pdf`;

      const { error: uploadErr } = await admin.storage.from(STORAGE_BUCKET).upload(storagePath, pdfBytes, {
        contentType: "application/pdf",
        cacheControl: "3600",
        upsert: false,
      });

      if (uploadErr) {
        const msg = String(uploadErr.message || "").toLowerCase();
        if (msg.includes("already exists") || msg.includes("duplicate")) {
          skippedCount += 1;
        } else {
          throw uploadErr;
        }
      } else {
        createdCount += 1;
      }

      const { error: updateErr } = await admin
        .from("employee_payslips")
        .update({
          storage_path: storagePath,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      if (updateErr) throw updateErr;
    }

    const [{ data: refreshed, error: refreshedErr }, profiles] = await Promise.all([
      admin
        .from("employee_payslips")
        .select(
          "id, batch_id, employee_user_id, employee_display_name, payroll_month, storage_path, original_page_start, original_page_end, match_status, match_confidence, extracted_leave_balance, created_at, updated_at"
        )
        .eq("batch_id", batchId)
        .order("original_page_start", { ascending: true }),
      loadSellerProfiles(admin),
    ]);

    if (refreshedErr) return json(res, 500, { ok: false, error: refreshedErr.message });

    return json(res, 200, {
      ok: true,
      created_count: createdCount,
      skipped_count: skippedCount,
      items: enrichRowsWithNames(refreshed || [], profiles),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Découpage impossible." });
  }
}
