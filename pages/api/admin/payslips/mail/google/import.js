import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { isAdminEmail } from "@/lib/admin";

import {
  GOOGLE_MAIL_PROVIDER,
  decryptSecret,
  encryptSecret,
  expiresAtFromTokenResponse,
  googleGet,
  refreshGoogleTokens,
} from "@/lib/server/googlePayslipMail";

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
  if (email && isAdminEmail(email)) return { admin, user, jwt };

  const { data: prof, error: pErr } = await admin
    .from("profiles")
    .select("user_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (pErr) return { error: { status: 500, message: pErr.message } };
  if (String(prof?.role || "").toLowerCase() !== "admin") {
    return { error: { status: 403, message: "FORBIDDEN" } };
  }

  return { admin, user, jwt };
}

async function loadConnectionWithAccessToken(admin, userId) {
  const { data: conn, error } = await admin
    .from("admin_mail_connections")
    .select("*")
    .eq("provider", GOOGLE_MAIL_PROVIDER)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!conn) throw new Error("Aucune boîte Gmail connectée.");

  let accessToken = decryptSecret(conn.access_token_encrypted);
  const refreshToken = decryptSecret(conn.refresh_token_encrypted);
  const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;

  if (!accessToken || !refreshToken || expiresAt <= Date.now() + 60_000) {
    if (!refreshToken) throw new Error("Jeton de rafraîchissement Gmail manquant.");
    const refreshed = await refreshGoogleTokens(refreshToken);
    accessToken = String(refreshed?.access_token || "");
    const nextRefresh = String(refreshed?.refresh_token || refreshToken);

    if (!accessToken) throw new Error("Rafraîchissement Gmail incomplet.");

    const { error: updateErr } = await admin
      .from("admin_mail_connections")
      .update({
        access_token_encrypted: encryptSecret(accessToken),
        refresh_token_encrypted: encryptSecret(nextRefresh),
        access_token_expires_at: expiresAtFromTokenResponse(refreshed),
        scope: String(refreshed?.scope || conn.scope || ""),
        updated_at: new Date().toISOString(),
      })
      .eq("provider", GOOGLE_MAIL_PROVIDER)
      .eq("user_id", userId);

    if (updateErr) throw updateErr;
  }

  return accessToken;
}

function safeFileName(name) {
  const base = String(name || "bulletins.pdf")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "bulletins.pdf";
}

function shaShort(value, len = 12) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, len);
}

function decodeBase64UrlBuffer(value) {
  const raw = String(value || "").trim();
  if (!raw) return Buffer.alloc(0);
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
  return Buffer.from(`${normalized}${pad}`, "base64");
}

function normalizeLoose(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const FR_MONTHS = {
  janvier: 1, janv: 1, jan: 1,
  fevrier: 2, fev: 2, "février": 2, "fév": 2,
  mars: 3,
  avril: 4, avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7, juil: 7,
  aout: 8, "août": 8,
  septembre: 9, sept: 9, sep: 9,
  octobre: 10, oct: 10,
  novembre: 11, nov: 11,
  decembre: 12, dec: 12, "décembre": 12, "déc": 12,
};

function monthIso(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

function twoDigitYearToFull(yy, refYear) {
  const n = Number(yy);
  if (!Number.isFinite(n)) return null;
  const base = Math.floor((Number(refYear) || new Date().getFullYear()) / 100) * 100;
  let candidate = base + n;
  const ref = Number(refYear) || new Date().getFullYear();
  if (candidate - ref > 50) candidate -= 100;
  if (ref - candidate > 50) candidate += 100;
  return candidate;
}

function receivedYear(receivedAt) {
  try {
    const y = new Date(receivedAt || Date.now()).getFullYear();
    return Number.isFinite(y) ? y : new Date().getFullYear();
  } catch (_) {
    return new Date().getFullYear();
  }
}

function detectMonthHint(value, receivedAt) {
  const raw = String(value || "");
  const normalized = normalizeLoose(raw);
  const refYear = receivedYear(receivedAt);

  const alreadyIso = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(value || "").trim());
  if (alreadyIso) return `${alreadyIso[1]}-${alreadyIso[2]}`;

  const dotted = /\b(0?[1-9]|1[0-2])[.\-_/](\d{2}|\d{4})\b/.exec(normalized);
  if (dotted) {
    const month = Number(dotted[1]);
    const yearRaw = String(dotted[2]);
    const year = yearRaw.length === 2 ? twoDigitYearToFull(yearRaw, refYear) : Number(yearRaw);
    return monthIso(year, month);
  }

  for (const [name, month] of Object.entries(FR_MONTHS)) {
    const re = new RegExp(`\\b${name}\\b(?:\\s+|\\s*[-/·]\\s*)?(20\\d{2})?`, "i");
    const m = re.exec(normalized);
    if (m) return monthIso(Number(m[1] || refYear), month);
  }

  return "";
}

function payrollMonthFromBody(body) {
  const direct =
    detectMonthHint(body?.payroll_month || "", body?.received_at) ||
    detectMonthHint(body?.detected_month || "", body?.received_at) ||
    detectMonthHint(body?.subject_month_hint || "", body?.received_at) ||
    detectMonthHint(body?.filename_month_hint || "", body?.received_at) ||
    detectMonthHint(body?.attachment_name || "", body?.received_at) ||
    detectMonthHint(body?.subject || "", body?.received_at);

  if (!direct) return "";
  return `${direct}-01`;
}

function ownBaseUrl(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();
  if (!host) return "";
  const proto = String(req.headers["x-forwarded-proto"] || "").trim() || (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function callOwnJson(req, path, jwt, body) {
  const base = ownBaseUrl(req);
  if (!base) throw new Error("URL interne de l’application introuvable.");

  const resp = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body || {}),
  });

  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || j?.ok === false) {
    throw new Error(j?.error || `Erreur API interne ${path} (${resp.status})`);
  }
  return j;
}

async function findExistingImportByPath(admin, storagePath) {
  const tables = ["payslip_imports", "payslip_import_batches"];
  for (const table of tables) {
    try {
      const { data, error } = await admin
        .from(table)
        .select("*")
        .eq("original_storage_path", storagePath)
        .limit(1)
        .maybeSingle();

      if (!error && data?.id) return data;
    } catch (_) {}
  }
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const messageId = String(body?.message_id || "").trim();
    const attachmentId = String(body?.attachment_id || "").trim();
    const attachmentName = String(body?.attachment_name || "bulletins.pdf").trim() || "bulletins.pdf";
    const contentType = String(body?.content_type || "application/pdf").trim() || "application/pdf";

    if (!messageId) return json(res, 400, { ok: false, error: "message_id manquant." });
    if (!attachmentId) return json(res, 400, { ok: false, error: "attachment_id manquant." });

    const payrollMonth = payrollMonthFromBody(body);
    if (!payrollMonth) {
      return json(res, 400, {
        ok: false,
        error: "Mois de paie introuvable pour cette pièce jointe. Relance le scan ou importe ce PDF manuellement.",
      });
    }

    const monthFolder = payrollMonth.slice(0, 7);
    const originalName = safeFileName(attachmentName);
    const storagePath =
      `original-imports/${monthFolder}/gmail-${safeFileName(messageId).slice(0, 20)}-${shaShort(attachmentId)}-${originalName}`;

    const existingRow = await findExistingImportByPath(auth.admin, storagePath);
    if (existingRow?.id) {
      return json(res, 200, {
        ok: true,
        already_imported: true,
        row: existingRow,
        batch_id: existingRow.id,
        payroll_month: payrollMonth,
        original_storage_path: storagePath,
        message: "Ce PDF Gmail avait déjà été importé.",
      });
    }

    const accessToken = await loadConnectionWithAccessToken(auth.admin, auth.user.id);

    const attachment = await googleGet(
      accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    );

    const buffer = decodeBase64UrlBuffer(attachment?.data || "");
    if (!buffer.length) {
      return json(res, 500, { ok: false, error: "Pièce jointe Gmail vide ou illisible." });
    }

    const { error: uploadErr } = await auth.admin.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
      cacheControl: "3600",
      contentType,
      upsert: false,
    });

    if (uploadErr) {
      const msg = String(uploadErr.message || "");
      const duplicate =
        msg.toLowerCase().includes("already exists") ||
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("resource already exists");

      if (!duplicate) {
        return json(res, 500, { ok: false, error: uploadErr.message || "Upload Supabase Storage impossible." });
      }
    }

    const importJson = await callOwnJson(req, "/api/admin/payslips/imports", auth.jwt, {
      payroll_month: payrollMonth,
      original_filename: attachmentName,
      original_storage_path: storagePath,
      original_file_size: Number(attachment?.size || buffer.length || body?.size || 0) || null,
      original_mime_type: contentType || "application/pdf",
    });

    const row = importJson?.row || null;
    const batchId = String(row?.id || importJson?.batch_id || "").trim();
    if (!batchId) {
      return json(res, 200, {
        ok: true,
        imported: true,
        row,
        payroll_month: payrollMonth,
        original_storage_path: storagePath,
        warning: "PDF importé, mais identifiant du lot introuvable pour lancer l’analyse automatique.",
      });
    }

    let analyzeJson = null;
    let splitJson = null;
    let analyzeError = "";
    let splitError = "";

    try {
      analyzeJson = await callOwnJson(req, "/api/admin/payslips/analyze", auth.jwt, { batch_id: batchId });
    } catch (e) {
      analyzeError = e?.message || "Analyse automatique impossible.";
    }

    if (!analyzeError) {
      try {
        splitJson = await callOwnJson(req, "/api/admin/payslips/split", auth.jwt, { batch_id: batchId });
      } catch (e) {
        splitError = e?.message || "Découpage automatique impossible.";
      }
    }

    return json(res, 200, {
      ok: true,
      imported: true,
      row,
      batch_id: batchId,
      payroll_month: payrollMonth,
      original_filename: attachmentName,
      original_storage_path: storagePath,
      analysis_count: Array.isArray(analyzeJson?.items) ? analyzeJson.items.length : 0,
      created_count: Number(splitJson?.created_count || 0) || 0,
      skipped_count: Number(splitJson?.skipped_count || 0) || 0,
      analyze_error: analyzeError,
      split_error: splitError,
      items: Array.isArray(splitJson?.items)
        ? splitJson.items
        : Array.isArray(analyzeJson?.items)
        ? analyzeJson.items
        : [],
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
