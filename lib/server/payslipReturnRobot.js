import { createClient } from "@supabase/supabase-js";
import {
  GOOGLE_MAIL_PROVIDER,
  decryptSecret,
  encryptSecret,
  expiresAtFromTokenResponse,
  refreshGoogleTokens,
} from "@/lib/server/googlePayslipMail";

export const PAYSLIP_STORAGE_BUCKET = "employee-payslips";
export const ACCOUNTANT_EMAIL = "davy.azoulay@yahoo.fr";
export function gmailReconnectFriendlyMessage(e) {
  const raw = [
    e?.message,
    e?.error,
    e?.payload?.error,
    e?.payload?.error_description,
    e?.payload?.error?.message,
    e?.payload?.message,
    typeof e?.payload === "string" ? e.payload : "",
  ]
    .map((x) => String(x || ""))
    .join(" ")
    .toLowerCase();

  const expired =
    raw.includes("token has been expired or revoked") ||
    raw.includes("expired or revoked") ||
    raw.includes("invalid_grant") ||
    raw.includes("revoked") ||
    raw.includes("invalid credentials");

  return expired
    ? "Connexion Gmail expirÃ©e ou rÃ©voquÃ©e. Reconnecte Gmail depuis la page Fiches de paie, puis relance le scan."
    : "";
}

export function serviceSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Missing Supabase service env");
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function safeDateForGmailAfter(value) {
  const d = value ? new Date(String(value)) : new Date(Date.now() - 30 * 86400000);
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date(Date.now() - 30 * 86400000);
    return `${fallback.getUTCFullYear()}/${String(fallback.getUTCMonth() + 1).padStart(2, "0")}/${String(fallback.getUTCDate()).padStart(2, "0")}`;
  }

  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function safeFileName(name) {
  const base = String(name || "bulletins.pdf")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 140);
  return base || "bulletins.pdf";
}

function randomPart() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (_) {}
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function headerValue(headers, name) {
  const n = String(name || "").toLowerCase();
  const h = (headers || []).find((x) => String(x?.name || "").toLowerCase() === n);
  return String(h?.value || "");
}

function emailFromHeader(value) {
  const s = String(value || "");
  const m = /<([^>]+)>/.exec(s);
  return String(m?.[1] || s).trim().toLowerCase();
}

function walkParts(part, out = []) {
  if (!part) return out;
  out.push(part);
  const parts = Array.isArray(part.parts) ? part.parts : [];
  parts.forEach((p) => walkParts(p, out));
  return out;
}

function looksLikePayslipReturn({ subject, filename }) {
  const hay = `${subject || ""} ${filename || ""}`.toLowerCase();
  if (!hay) return false;
  const hasPaie = hay.includes("paie") || hay.includes("paies") || hay.includes("bulletin") || hay.includes("salaire");
  const notWrong =
    !hay.includes("attestation") &&
    !hay.includes("certificat") &&
    !hay.includes("solde de tout compte") &&
    !hay.includes("contrat");
  return hasPaie && notWrong;
}

async function gmailJson(accessToken, url, options = {}) {
  const resp = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await resp.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text || null;
  }

  if (!resp.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      (typeof data === "string" ? data : "") ||
      `Erreur Gmail (${resp.status})`;
    const err = new Error(message);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }

  return data;
}

async function gmailAttachmentBuffer(accessToken, messageId, attachmentId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
  const data = await gmailJson(accessToken, url);
  const raw = String(data?.data || "");
  if (!raw) throw new Error("Pièce jointe Gmail vide.");

  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export async function getLatestGmailConnection(service) {
  const { data, error } = await service
    .from("admin_mail_connections")
    .select("*")
    .eq("provider", GOOGLE_MAIL_PROVIDER)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Aucune boîte Gmail connectée.");
  return data;
}

export async function getAccessTokenForConnection(service, conn) {
  let accessToken = decryptSecret(conn.access_token_encrypted);
  const refreshToken = decryptSecret(conn.refresh_token_encrypted);
  let scope = String(conn.scope || "");
  const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;

  if (!accessToken || expiresAt <= Date.now() + 60_000) {
    if (!refreshToken) throw new Error("Jeton de rafraîchissement Gmail manquant.");

    const refreshed = await refreshGoogleTokens(refreshToken);
    accessToken = String(refreshed?.access_token || "");
    const nextRefresh = String(refreshed?.refresh_token || refreshToken);
    scope = String(refreshed?.scope || scope);

    if (!accessToken) throw new Error("Rafraîchissement Gmail incomplet.");

    let updateQuery = service
      .from("admin_mail_connections")
      .update({
        access_token_encrypted: encryptSecret(accessToken),
        refresh_token_encrypted: encryptSecret(nextRefresh),
        access_token_expires_at: expiresAtFromTokenResponse(refreshed),
        scope,
        updated_at: new Date().toISOString(),
      })
      .eq("provider", GOOGLE_MAIL_PROVIDER);

    // La table admin_mail_connections de ton projet n'a pas forcément de colonne "id".
    // On met donc à jour la connexion Gmail par provider + user_id quand user_id existe,
    // sinon par provider uniquement.
    if (conn?.user_id) {
      updateQuery = updateQuery.eq("user_id", conn.user_id);
    }

    const { error } = await updateQuery;
    if (error) throw error;
  }

  return { accessToken, scope };
}

async function listGmailMessages(accessToken, q, maxResults = 30) {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", String(Math.max(1, Math.min(100, Number(maxResults || 30) || 30))));
  const data = await gmailJson(accessToken, url.toString());
  return Array.isArray(data?.messages) ? data.messages : [];
}

async function getGmailMessage(accessToken, messageId) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "full");
  return gmailJson(accessToken, url.toString());
}

export async function scanPayslipReturnCandidates({ service, payrollMonth = "", draftId = "", maxMessages = 40 } = {}) {
  const conn = await getLatestGmailConnection(service);
  const { accessToken } = await getAccessTokenForConnection(service, conn);

  let draftQuery = service
    .from("payroll_email_drafts")
    .select("id, payroll_month, sent_at, subject, to_email")
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(6);

  if (draftId) draftQuery = draftQuery.eq("id", draftId);
  if (payrollMonth) draftQuery = draftQuery.eq("payroll_month", `${String(payrollMonth).slice(0, 7)}-01`);

  const { data: drafts, error: draftsErr } = await draftQuery;
  if (draftsErr) throw draftsErr;

  const rowsToInsert = [];
  const scannedDrafts = [];

  for (const draft of drafts || []) {
    const month = String(draft?.payroll_month || "").slice(0, 10);
    const after = safeDateForGmailAfter(draft?.sent_at);
    const q = `from:${ACCOUNTANT_EMAIL} has:attachment after:${after} (paie OR paies OR bulletin OR bulletins)`;
    const messages = await listGmailMessages(accessToken, q, maxMessages);

    scannedDrafts.push({ draft_id: draft.id, payroll_month: month, gmail_query: q, messages: messages.length });

    for (const msg of messages) {
      const full = await getGmailMessage(accessToken, msg.id);
      const headers = full?.payload?.headers || [];
      const subject = headerValue(headers, "Subject");
      const fromRaw = headerValue(headers, "From");
      const fromEmail = emailFromHeader(fromRaw);
      const receivedAt = full?.internalDate
        ? new Date(Number(full.internalDate)).toISOString()
        : new Date().toISOString();

      const parts = walkParts(full?.payload || {});
      const pdfParts = parts.filter((part) => {
        const filename = String(part?.filename || "").trim();
        const mime = String(part?.mimeType || "").toLowerCase();
        const attachmentId = String(part?.body?.attachmentId || "").trim();
        return attachmentId && (mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf"));
      });

      for (const part of pdfParts) {
        const filename = String(part?.filename || "bulletins.pdf").trim() || "bulletins.pdf";
        const likely = looksLikePayslipReturn({ subject, filename });

        if (!likely) continue;

        rowsToInsert.push({
          payroll_month: month,
          payroll_email_draft_id: draft.id,
          gmail_message_id: String(full?.id || msg.id),
          gmail_thread_id: String(full?.threadId || ""),
          gmail_attachment_id: String(part?.body?.attachmentId || ""),
          gmail_attachment_name: filename,
          gmail_from: fromEmail || fromRaw || null,
          gmail_subject: subject || null,
          gmail_received_at: receivedAt,
          file_size: Number(part?.body?.size || 0) || null,
          mime_type: String(part?.mimeType || "application/pdf"),
          status: "detected",
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  let upserted = [];
  if (rowsToInsert.length) {
    const { data, error } = await service
      .from("payroll_payslip_return_candidates")
      .upsert(rowsToInsert, {
        onConflict: "gmail_message_id,gmail_attachment_id",
        ignoreDuplicates: false,
      })
      .select("*");

    if (error) throw error;
    upserted = data || [];
  }

  return {
    ok: true,
    scanned_drafts: scannedDrafts,
    found_candidates: rowsToInsert.length,
    saved_candidates: upserted.length,
    rows: upserted,
  };
}

export function getBaseUrl(req) {
  const proto = String(req?.headers?.["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  const host = String(req?.headers?.host || "").trim();
  if (!host) {
    const site = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL || "";
    if (site) return site.startsWith("http") ? site : `https://${site}`;
    return "http://localhost:3000";
  }
  return `${proto}://${host}`;
}

export async function importPayslipReturnCandidate({ service, candidateId, authorization, req }) {
  const id = String(candidateId || "").trim();
  if (!id) throw new Error("Identifiant de pièce jointe manquant.");

  const { data: row, error } = await service
    .from("payroll_payslip_return_candidates")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!row) throw new Error("Pièce jointe introuvable.");
  if (row.status === "imported") {
    return { ok: true, already_imported: true, row };
  }

  const conn = await getLatestGmailConnection(service);
  const { accessToken } = await getAccessTokenForConnection(service, conn);
  const buffer = await gmailAttachmentBuffer(accessToken, row.gmail_message_id, row.gmail_attachment_id);

  if (!buffer?.length) throw new Error("PDF Gmail vide.");

  const monthValue = String(row.payroll_month || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthValue)) throw new Error("Mois de paie invalide.");

  const originalName = safeFileName(row.gmail_attachment_name || "bulletins.pdf");
  const storagePath = `original-imports/${monthValue}/${randomPart()}-${originalName}`;

  const { error: uploadErr } = await service.storage
    .from(PAYSLIP_STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      cacheControl: "3600",
      contentType: row.mime_type || "application/pdf",
      upsert: false,
    });

  if (uploadErr) throw uploadErr;

  const base = getBaseUrl(req);
  const auth = String(authorization || "").startsWith("Bearer ") ? String(authorization) : "";
  if (!auth) throw new Error("Authorization admin manquante pour lancer l'import existant.");

  const callJson = async (path, body) => {
    const resp = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify(body || {}),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j?.ok === false) {
      throw new Error(j?.error || `Erreur ${path} (${resp.status})`);
    }
    return j;
  };

  const importJson = await callJson("/api/admin/payslips/imports", {
    payroll_month: `${monthValue}-01`,
    original_filename: row.gmail_attachment_name || originalName,
    original_storage_path: storagePath,
    original_file_size: buffer.length,
    original_mime_type: row.mime_type || "application/pdf",
  });

  const batchId = String(importJson?.row?.id || "").trim();
  if (!batchId) throw new Error("Import créé mais batch_id introuvable.");

  const analyzeJson = await callJson("/api/admin/payslips/analyze", { batch_id: batchId });
  const splitJson = await callJson("/api/admin/payslips/split", { batch_id: batchId });

  const analysisCount = Array.isArray(analyzeJson?.items) ? analyzeJson.items.length : Number(analyzeJson?.analysis_count || 0) || 0;
  const createdCount = Number(splitJson?.created_count || 0) || 0;
  const skippedCount = Number(splitJson?.skipped_count || 0) || 0;

  const { data: updated, error: updErr } = await service
    .from("payroll_payslip_return_candidates")
    .update({
      status: "imported",
      import_batch_id: batchId,
      storage_path: storagePath,
      analysis_count: analysisCount,
      created_count: createdCount,
      skipped_count: skippedCount,
      imported_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updErr) throw updErr;

  return {
    ok: true,
    row: updated,
    batch_id: batchId,
    analysis_count: analysisCount,
    created_count: createdCount,
    skipped_count: skippedCount,
  };
}

