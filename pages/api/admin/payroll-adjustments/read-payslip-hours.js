
import pdfParse from "pdf-parse";
import { requireAdmin } from "@/lib/server/adminApi";
import { parsePayrollMonth, round2, normalizeLoose } from "@/lib/server/payrollAdjustments";

const PAYSLIP_BUCKET = "employee-payslips";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function getServiceClient(auth) {
  if (!auth) return null;
  if (typeof auth.from === "function") return auth;
  if (auth.service && typeof auth.service.from === "function") return auth.service;
  if (auth.admin && typeof auth.admin.from === "function") return auth.admin;
  return null;
}

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

function toNumberFr(value) {
  const raw = String(value || "")
    .replace(/\s+/g, "")
    .replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function numbersInLine(line) {
  const out = [];
  const re = /(?<!\d)(\d{1,3}(?:[\s\u00a0]?\d{3})*(?:[,.]\d{1,2})?|\d+[,.]\d{1,2})(?!\d)/g;
  let m;
  while ((m = re.exec(String(line || "")))) {
    const n = toNumberFr(m[1]);
    if (n != null) out.push(n);
  }
  return out;
}

function scoreLine(line) {
  const n = normalizeLoose(line);
  let score = 0;

  if (n.includes("salaire de base")) score += 100;
  if (n.includes("heures normales")) score += 90;
  if (n.includes("heures payees") || n.includes("heures paye")) score += 90;
  if (n.includes("horaire mensuel")) score += 80;
  if (n.includes("mensuel")) score += 35;
  if (n.includes("nombre d heures") || n.includes("nb heures")) score += 70;
  if (n.includes("base")) score += 25;

  // Évite les lignes d'absence/congé/compteur CP qui contiennent aussi des nombres.
  if (n.includes("absence")) score -= 80;
  if (n.includes("conge") || n.includes("cp ") || n.includes("cp-")) score -= 70;
  if (n.includes("solde")) score -= 60;
  if (n.includes("acquis")) score -= 60;
  if (n.includes("pris")) score -= 60;
  if (n.includes("reste")) score -= 60;
  if (n.includes("net a payer")) score -= 100;
  if (n.includes("total cotisation")) score -= 100;
  if (n.includes("brut")) score -= 25;

  return score;
}

function looksLikeMonthlyHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return n >= 1 && n <= 230;
}

function pickBestHoursFromText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const candidates = [];

  lines.forEach((line, index) => {
    const baseScore = scoreLine(line);
    if (baseScore <= 0) return;

    const nums = numbersInLine(line).filter(looksLikeMonthlyHours);
    nums.forEach((num, pos) => {
      let score = baseScore;

      // Dans les lignes "Salaire de base 151,67 11,88 1801,80",
      // les heures sont très souvent le premier nombre exploitable.
      if (pos === 0) score += 20;

      // Valeurs très fréquentes de contrats mensuels.
      if (Math.abs(num - 151.67) < 0.02) score += 45;
      if (Math.abs(num - 86.66) < 0.03 || Math.abs(num - 86.67) < 0.03) score += 35;
      if (Math.abs(num - 65) < 0.02 || Math.abs(num - 43.33) < 0.03) score += 25;

      // Les taux horaires type 10, 11,65, 12 sont possibles dans la ligne,
      // mais ce ne sont généralement pas les heures.
      if (num >= 8 && num <= 20) score -= 30;

      candidates.push({
        hours: round2(num),
        line,
        line_index: index,
        score,
      });
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0] || null;
  if (!best || best.score < 30) {
    return {
      hours: null,
      confidence: 0,
      line: "",
      candidates: candidates.slice(0, 5),
    };
  }

  return {
    hours: best.hours,
    confidence: Math.min(100, Math.max(10, Math.round(best.score))),
    line: best.line,
    candidates: candidates.slice(0, 5),
  };
}

async function getLatestMatchedPayslips(service, payrollMonth) {
  const { data, error } = await service
    .from("employee_payslips")
    .select("id, employee_user_id, employee_display_name, payroll_month, storage_path, match_status, match_confidence, created_at")
    .eq("payroll_month", payrollMonth)
    .not("employee_user_id", "is", null)
    .not("storage_path", "is", null)
    .eq("match_status", "matched")
    .order("created_at", { ascending: false });

  if (error) throw error;

  const bySeller = new Map();
  (data || []).forEach((row) => {
    const sellerId = String(row?.employee_user_id || "").trim();
    if (!sellerId || bySeller.has(sellerId)) return;
    bySeller.set(sellerId, row);
  });

  return Array.from(bySeller.values());
}

async function extractTextFromStoragePdf(service, storagePath) {
  const { data, error } = await service.storage.from(PAYSLIP_BUCKET).download(storagePath);
  if (error) throw error;
  if (!data) throw new Error("PDF introuvable dans le stockage.");

  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const parsed = await pdfParse(buffer);
  return String(parsed?.text || "");
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Méthode non autorisée" });
    }

    const auth = await requireAdmin(req, res);
    if (!auth) return;

    const service = getServiceClient(auth);
    if (!service) {
      return json(res, 500, { ok: false, error: "Client Supabase admin introuvable." });
    }

    const body = bodyObject(req);
    const month = parsePayrollMonth(body?.month || body?.payroll_month || "");
    if (!month) return json(res, 400, { ok: false, error: "Mois invalide" });

    const payslips = await getLatestMatchedPayslips(service, month.payroll_month);

    const rows = [];
    for (const payslip of payslips) {
      try {
        const text = await extractTextFromStoragePdf(service, payslip.storage_path);
        const extracted = pickBestHoursFromText(text);

        rows.push({
          ok: extracted.hours != null,
          seller_id: payslip.employee_user_id,
          employee_display_name: payslip.employee_display_name,
          payslip_id: payslip.id,
          storage_path: payslip.storage_path,
          hours: extracted.hours,
          confidence: extracted.confidence,
          source_line: extracted.line,
          candidates: extracted.candidates,
        });
      } catch (e) {
        rows.push({
          ok: false,
          seller_id: payslip.employee_user_id,
          employee_display_name: payslip.employee_display_name,
          payslip_id: payslip.id,
          storage_path: payslip.storage_path,
          hours: null,
          confidence: 0,
          error: e?.message || "Lecture PDF impossible",
        });
      }
    }

    return json(res, 200, {
      ok: true,
      month: month.value,
      found_payslips: payslips.length,
      extracted_count: rows.filter((r) => r.hours != null).length,
      rows,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Erreur serveur" });
  }
}
