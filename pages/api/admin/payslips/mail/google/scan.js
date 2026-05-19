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

import {
  GOOGLE_MAIL_PROVIDER,
  decryptSecret,
  encryptSecret,
  expiresAtFromTokenResponse,
  googleGet,
  refreshGoogleTokens,
} from "@/lib/server/googlePayslipMail";

function headerValue(headers, name) {
  const found = (headers || []).find((h) => String(h?.name || "").toLowerCase() === String(name || "").toLowerCase());
  return found?.value || "";
}

function decodeFromHeader(raw) {
  const s = String(raw || "").trim();
  const m = /^(.*)<([^>]+)>$/.exec(s);
  if (!m) return { from_name: "", from_email: s };
  return {
    from_name: String(m[1] || "").trim().replace(/^"|"$/g, ""),
    from_email: String(m[2] || "").trim(),
  };
}

function likelyPayslip({ subject, attachmentName }) {
  const blob = `${subject || ""} ${attachmentName || ""}`.toLowerCase();
  const words = [
    "paie",
    "paies",
    "paye",
    "payes",
    "bulletin",
    "bulletins",
    "salaire",
    "salaires",
    "fiche de paie",
    "fiches de paie",
    "payslip",
    "payroll",
  ];
  return words.some((word) => blob.includes(word));
}

function isPdfPart(part) {
  const filename = String(part?.filename || "").toLowerCase();
  const mimeType = String(part?.mimeType || "").toLowerCase();
  return filename.endsWith(".pdf") || mimeType === "application/pdf";
}

function walkParts(parts, out = []) {
  for (const part of parts || []) {
    if (isPdfPart(part) && part?.body?.attachmentId) {
      out.push(part);
    }
    if (Array.isArray(part?.parts) && part.parts.length) {
      walkParts(part.parts, out);
    }
  }
  return out;
}

async function mapLimited(items, limit, mapper) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await mapper(current));
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const sinceDate = String(body?.since_date || "").slice(0, 10);
    const maxMessages = Math.min(Math.max(Number(body?.max_messages || 150) || 150, 1), 250);

    const accessToken = await loadConnectionWithAccessToken(auth.admin, auth.user.id);

    const gmailAfter = /^\d{4}-\d{2}-\d{2}$/.test(sinceDate)
      ? ` after:${sinceDate.replace(/-/g, "/")}`
      : "";

    const q = `from:davy.azoulay@yahoo.fr (subject:Paie OR subject:Paies) has:attachment filename:pdf${gmailAfter}`;
    let url =
      "https://gmail.googleapis.com/gmail/v1/users/me/messages" +
      `?maxResults=50&q=${encodeURIComponent(q)}`;

    const messageRefs = [];
    while (url && messageRefs.length < maxMessages) {
      const page = await googleGet(accessToken, url);
      const values = Array.isArray(page?.messages) ? page.messages : [];
      messageRefs.push(...values);
      const token = String(page?.nextPageToken || "").trim();
      url = token
        ? "https://gmail.googleapis.com/gmail/v1/users/me/messages" +
          `?maxResults=50&q=${encodeURIComponent(q)}&pageToken=${encodeURIComponent(token)}`
        : "";
      if (!values.length) break;
    }

    const trimmed = messageRefs.slice(0, maxMessages);

    const fullMessages = await mapLimited(trimmed, 4, async (msg) => {
      const detail = await googleGet(
        accessToken,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msg.id)}?format=full`
      );
      return detail;
    });

    const candidates = [];
    for (const message of fullMessages || []) {
      const headers = message?.payload?.headers || [];
      const subject = headerValue(headers, "Subject");
      const dateHeader = headerValue(headers, "Date");
      const receivedAt = message?.internalDate
        ? new Date(Number(message.internalDate)).toISOString()
        : (dateHeader || null);
      const from = decodeFromHeader(headerValue(headers, "From"));
      const pdfParts = walkParts(message?.payload?.parts || []);

      for (const part of pdfParts) {
        candidates.push({
          message_id: message.id,
          subject,
          from_name: from.from_name,
          from_email: from.from_email,
          received_at: receivedAt,
          attachment_id: part.body.attachmentId,
          attachment_name: part.filename || "piece-jointe.pdf",
          content_type: part.mimeType || "application/pdf",
          size: Number(part.body.size || 0) || 0,
          likely_payslip: likelyPayslip({
            subject,
            attachmentName: part.filename || "",
          }),
        });
      }
    }

    candidates.sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || "")));

    return json(res, 200, {
      ok: true,
      summary: {
        messages_scanned: trimmed.length,
        pdf_candidates: candidates.length,
      },
      candidates,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
