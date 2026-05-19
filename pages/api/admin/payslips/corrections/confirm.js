import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
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

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(s) {
  return String(s || "").replace(/\r/g, "\n");
}

function toNumber(v) {
  const n = Number(String(v || "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseSlashNumberLine(line) {
  const nums = String(line || "").match(/\d+(?:[.,]\d+)?/g) || [];
  return nums.map((x) => toNumber(x)).filter((x) => x !== null);
}

function extractLeaveBalance(text) {
  const lines = cleanText(text)
    .split("\n")
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const soldeIdx = lines.findIndex((line) => /^Solde\s*:/i.test(line));
  if (soldeIdx < 0) return null;

  const slashRows = [];
  for (let i = soldeIdx + 1; i < Math.min(lines.length, soldeIdx + 12); i++) {
    const line = lines[i];
    if (!line.includes("/")) continue;
    const nums = parseSlashNumberLine(line);
    if (!nums.length) continue;
    slashRows.push(nums);
    if (slashRows.length >= 3) break;
  }

  if (slashRows.length < 3) return null;

  const acquiredRow = slashRows[0];
  const takenRow = slashRows[1];
  const remainingRow = slashRows[2];

  return {
    cp_acquired_n1: acquiredRow.length >= 2 ? acquiredRow[0] : null,
    cp_acquired_n: acquiredRow.length >= 2 ? acquiredRow[1] : acquiredRow[0] ?? null,
    cp_taken_n1: takenRow[0] ?? null,
    cp_taken_n: takenRow[1] ?? null,
    cp_remaining_n1: remainingRow[0] ?? null,
    cp_remaining_n: remainingRow[1] ?? null,
  };
}

function extractEmployeeName(text) {
  const lines = cleanText(text)
    .split("\n")
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  return lines.find((line) => /^(M|MR|MME)\s+/i.test(line) && !/^MONTANT\b/i.test(line)) || "";
}

function extractJobTitle(text) {
  const lines = cleanText(text)
    .split("\n")
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const line = lines.find((x) => /^Emploi\s*:/i.test(x)) || "";
  return line.replace(/^Emploi\s*:\s*/i, "").trim();
}

const MONTHS_FR = {
  janvier: "01",
  fevrier: "02",
  février: "02",
  mars: "03",
  avril: "04",
  mai: "05",
  juin: "06",
  juillet: "07",
  aout: "08",
  août: "08",
  septembre: "09",
  octobre: "10",
  novembre: "11",
  decembre: "12",
  décembre: "12",
};

function extractPayrollMonth(text) {
  const s = cleanText(text);
  const m = /P[ée]riode\s*:\s*([A-Za-zÀ-ÿ]+)\s+(\d{4})/i.exec(s);
  if (!m) return null;

  const monthKeyRaw = String(m[1] || "").trim().toLowerCase();
  const monthKey = norm(monthKeyRaw).replace(/\s+/g, "");
  const monthNumber =
    MONTHS_FR[monthKeyRaw] ||
    MONTHS_FR[monthKey] ||
    null;

  if (!monthNumber) return null;

  const year = String(m[2] || "").trim();
  return {
    iso: `${year}-${monthNumber}-01`,
    label: `${m[1]} ${year}`,
  };
}

function splitWords(s) {
  return norm(s)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function profileMatchScore(employeeName, profile) {
  const fullName = String(profile?.full_name || "").trim();
  if (!fullName) return 0;

  const employeeNorm = norm(employeeName);
  const profileNorm = norm(fullName);
  if (!employeeNorm || !profileNorm) return 0;

  // Correspondance directe sur la ligne du nom uniquement.
  if (employeeNorm.includes(profileNorm)) return 100;

  const profileTokens = splitWords(fullName);
  const employeeTokens = new Set(splitWords(employeeName));
  if (!profileTokens.length || !employeeTokens.size) return 0;

  // Très important pour les prénoms courts comme "Ana" :
  // on exige une égalité de token, jamais une simple sous-chaîne dans tout le bulletin.
  const hitCount = profileTokens.filter((token) => employeeTokens.has(token)).length;
  if (!hitCount) return 0;

  const ratio = hitCount / profileTokens.length;
  if (ratio >= 1) return 95;
  if (ratio >= 0.66) return 80;
  if (ratio >= 0.5) return 65;
  return 0;
}

function employeeNameMatchesProfile(employeeName, fullName) {
  if (!employeeName || !fullName) return false;
  const score = profileMatchScore(employeeName, { full_name: fullName });
  return score >= 80;
}

async function downloadPdf(admin, storagePath) {
  const { data, error } = await admin.storage.from(STORAGE_BUCKET).download(storagePath);
  if (error) throw error;
  if (!data) throw new Error("PDF corrigé introuvable dans le stockage.");
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

async function analyzeCorrectionPdf(admin, storagePath) {
  const buffer = await downloadPdf(admin, storagePath);
  const doc = await PDFDocument.load(buffer);
  const pageCount = doc.getPageCount();
  const parsed = await pdfParse(buffer);
  const text = String(parsed?.text || "");

  const employeeDisplayName = extractEmployeeName(text) || "Nom non détecté";
  const payrollMonth = extractPayrollMonth(text);
  const leaveBalance = extractLeaveBalance(text);
  const jobTitle = extractJobTitle(text);

  const profiles = await loadSellerProfiles(admin);
  let best = null;
  for (const profile of profiles) {
    const score = profileMatchScore(employeeDisplayName, profile);
    if (!best || score > best.score) best = { profile, score };
  }

  const score = Number(best?.score || 0);
  const matched = score >= 80 ? best?.profile : null;

  return {
    buffer,
    page_count: pageCount,
    text,
    employee_display_name: employeeDisplayName,
    employee_user_id: matched?.user_id || null,
    matched_profile_name: matched?.full_name || "",
    match_confidence: matched ? score : score || null,
    payroll_month: payrollMonth?.iso || null,
    payroll_month_label: payrollMonth?.label || null,
    extracted_leave_balance: leaveBalance,
    job_title: jobTitle || "",
  };
}

function safePart(value, fallback = "fiche-corrigee") {
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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const storagePath = String(body?.storage_path || "").trim();
    const originalFilename = String(body?.original_filename || "").trim() || "fiche-corrigee.pdf";
    const originalFileSize = body?.original_file_size == null ? null : Number(body.original_file_size || 0);
    const originalMimeType = String(body?.original_mime_type || "application/pdf").trim() || "application/pdf";

    if (!storagePath) return json(res, 400, { ok: false, error: "Missing storage_path" });

    const analysis = await analyzeCorrectionPdf(auth.admin, storagePath);

    if (!analysis.employee_user_id) {
      return json(res, 409, { ok: false, error: "La salariée n'a pas été reconnue avec assez de certitude." });
    }
    if (!analysis.payroll_month) {
      return json(res, 409, { ok: false, error: "Le mois de paie n'a pas pu être détecté sur ce bulletin." });
    }

    const { data: existing, error: existingErr } = await auth.admin
      .from("employee_payslips")
      .select("id, created_at")
      .eq("employee_user_id", analysis.employee_user_id)
      .eq("payroll_month", analysis.payroll_month)
      .not("storage_path", "is", null)
      .order("created_at", { ascending: false });

    if (existingErr) throw existingErr;
    const existingCountBefore = Array.isArray(existing) ? existing.length : 0;

    const { data: batch, error: batchErr } = await auth.admin
      .from("payslip_import_batches")
      .insert({
        payroll_month: analysis.payroll_month,
        original_filename: originalFilename,
        original_storage_path: storagePath,
        original_file_size: Number.isFinite(originalFileSize) ? Math.max(0, Math.round(originalFileSize)) : null,
        original_mime_type: originalMimeType,
        status: "completed",
        created_by: auth.user.id,
        updated_at: new Date().toISOString(),
      })
      .select("id, payroll_month, original_filename, original_storage_path, status, created_at")
      .single();

    if (batchErr) throw batchErr;

    const folder = monthFolder(analysis.payroll_month);
    const employeePart = safePart(analysis.matched_profile_name || analysis.employee_display_name || "fiche-corrigee");
    const finalStoragePath = `individual/${folder}/corrections/batch-${batch.id}-${employeePart}.pdf`;

    const { error: uploadErr } = await auth.admin.storage.from(STORAGE_BUCKET).upload(finalStoragePath, analysis.buffer, {
      contentType: "application/pdf",
      cacheControl: "3600",
      upsert: false,
    });
    if (uploadErr) throw uploadErr;

    const { data: row, error: rowErr } = await auth.admin
      .from("employee_payslips")
      .insert({
        batch_id: batch.id,
        employee_user_id: analysis.employee_user_id,
        employee_display_name: analysis.employee_display_name,
        payroll_month: analysis.payroll_month,
        storage_path: finalStoragePath,
        original_page_start: 1,
        original_page_end: analysis.page_count,
        match_status: "matched",
        match_confidence: analysis.match_confidence,
        extracted_leave_balance: analysis.extracted_leave_balance,
        updated_at: new Date().toISOString(),
      })
      .select("id, batch_id, employee_user_id, employee_display_name, payroll_month, storage_path, match_status, match_confidence, extracted_leave_balance, created_at")
      .single();

    if (rowErr) throw rowErr;

    return json(res, 200, {
      ok: true,
      result: {
        batch_id: batch.id,
        payslip_id: row.id,
        employee_user_id: analysis.employee_user_id,
        employee_display_name: analysis.employee_display_name,
        matched_profile_name: analysis.matched_profile_name,
        match_confidence: analysis.match_confidence,
        payroll_month: analysis.payroll_month,
        payroll_month_label: analysis.payroll_month_label,
        existing_count_before: existingCountBefore,
        storage_path: finalStoragePath,
      },
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Validation de correction impossible." });
  }
}
