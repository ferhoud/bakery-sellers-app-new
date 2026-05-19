// pages/api/admin/payslips/analyze.js
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

function firstMatchingLine(lines, re) {
  return (lines || []).find((line) => re.test(String(line || "").trim())) || "";
}

function extractEmployeeName(text) {
  const lines = cleanText(text)
    .split("\n")
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const nameLine = lines.find((line) => /^(M|MR|MME)\s+/i.test(line) && !/^MONTANT\b/i.test(line)) || "";
  return nameLine.trim();
}

function extractMatricule(text) {
  const m = /Matricule\s*:\s*([^\s\n]+)/i.exec(cleanText(text));
  return m?.[1] ? String(m[1]).trim() : "";
}

function extractJobTitle(text) {
  const line = firstMatchingLine(
    cleanText(text)
      .split("\n")
      .map((x) => String(x || "").trim())
      .filter(Boolean),
    /^Emploi\s*:/i
  );
  if (!line) return "";
  return line.replace(/^Emploi\s*:\s*/i, "").trim();
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

async function parsePageTexts(buffer) {
  const [{ PDFDocument }, pdfParseMod] = await Promise.all([import("pdf-lib"), import("pdf-parse")]);
  const pdfParse = pdfParseMod?.default || pdfParseMod;
  const original = await PDFDocument.load(buffer);
  const pageCount = original.getPageCount();
  const pages = [];

  for (let idx = 0; idx < pageCount; idx++) {
    const one = await PDFDocument.create();
    const [copied] = await one.copyPages(original, [idx]);
    one.addPage(copied);
    const bytes = await one.save();
    const parsed = await pdfParse(Buffer.from(bytes));
    pages.push({
      page: idx + 1,
      text: String(parsed?.text || ""),
    });
  }

  return pages;
}

async function downloadBatchPdf(admin, storagePath) {
  const { data, error } = await admin.storage.from("employee-payslips").download(storagePath);
  if (error) throw error;
  if (!data) throw new Error("PDF introuvable dans le stockage.");
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

async function handleGet(req, res, admin) {
  const batchId = String(req.query?.batch_id || "").trim();
  if (!batchId) return json(res, 400, { ok: false, error: "Missing batch_id" });

  const [{ data: rows, error: rowsErr }, profiles] = await Promise.all([
    admin
      .from("employee_payslips")
      .select(
        "id, batch_id, employee_user_id, employee_display_name, payroll_month, storage_path, original_page_start, original_page_end, match_status, match_confidence, extracted_leave_balance, created_at, updated_at"
      )
      .eq("batch_id", batchId)
      .order("original_page_start", { ascending: true }),
    loadSellerProfiles(admin),
  ]);

  if (rowsErr) return json(res, 500, { ok: false, error: rowsErr.message });
  return json(res, 200, { ok: true, items: enrichRowsWithNames(rows || [], profiles) });
}

async function handlePost(req, res, admin) {
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

  await admin
    .from("payslip_import_batches")
    .update({ status: "processing", updated_at: new Date().toISOString(), error_message: null })
    .eq("id", batchId);

  try {
    const [buffer, profiles] = await Promise.all([
      downloadBatchPdf(admin, batch.original_storage_path),
      loadSellerProfiles(admin),
    ]);

    const pages = await parsePageTexts(buffer);
    const rows = pages.map((page) => {
      const employeeDisplayName = extractEmployeeName(page.text);
      const matricule = extractMatricule(page.text);
      const jobTitle = extractJobTitle(page.text);
      const leaveBalance = extractLeaveBalance(page.text);

      let best = null;
      for (const profile of profiles || []) {
        const score = profileMatchScore(employeeDisplayName, profile);
        if (!best || score > best.score) {
          best = { profile, score };
        }
      }

      const score = Number(best?.score || 0);
      const matched = score >= 80 ? best?.profile : null;

      return {
        batch_id: batchId,
        employee_user_id: matched?.user_id || null,
        employee_display_name: employeeDisplayName || "Nom non détecté",
        payroll_month: batch.payroll_month,
        storage_path: null,
        original_page_start: page.page,
        original_page_end: page.page,
        match_status: matched ? "matched" : "unmatched",
        match_confidence: matched ? score : score || null,
        extracted_leave_balance: leaveBalance,
        _matched_profile_name: matched?.full_name || "",
        _job_title: jobTitle,
        _matricule: matricule,
      };
    });

    const { error: delErr } = await admin.from("employee_payslips").delete().eq("batch_id", batchId);
    if (delErr) throw delErr;

    const insertRows = rows.map(({ _matched_profile_name, _job_title, _matricule, ...r }) => r);
    const { data: inserted, error: insErr } = await admin
      .from("employee_payslips")
      .insert(insertRows)
      .select(
        "id, batch_id, employee_user_id, employee_display_name, payroll_month, storage_path, original_page_start, original_page_end, match_status, match_confidence, extracted_leave_balance, created_at, updated_at"
      )
      .order("original_page_start", { ascending: true });

    if (insErr) throw insErr;

    await admin
      .from("payslip_import_batches")
      .update({ status: "needs_review", updated_at: new Date().toISOString(), error_message: null })
      .eq("id", batchId);

    const pageMetaByPage = new Map(
      rows.map((r) => [
        Number(r.original_page_start),
        {
          matched_profile_name: r._matched_profile_name || "",
          job_title: r._job_title || "",
          matricule: r._matricule || "",
        },
      ])
    );

    const items = (inserted || []).map((r) => ({
      ...r,
      ...(pageMetaByPage.get(Number(r.original_page_start)) || {}),
    }));

    return json(res, 200, { ok: true, items });
  } catch (e) {
    await admin
      .from("payslip_import_batches")
      .update({
        status: "failed",
        error_message: e?.message || "Analyse impossible",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId);

    return json(res, 500, { ok: false, error: e?.message || "Analyse impossible." });
  }
}

export default async function handler(req, res) {
  try {
    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    if (req.method === "GET") return handleGet(req, res, auth.admin);
    if (req.method === "POST") return handlePost(req, res, auth.admin);

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
