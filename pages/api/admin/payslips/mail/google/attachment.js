import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";
import {
  GOOGLE_MAIL_PROVIDER,
  decryptSecret,
  encryptSecret,
  expiresAtFromTokenResponse,
  googleGet,
  refreshGoogleTokens,
} from "@/lib/server/googlePayslipMail";

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

function decodeGmailBase64UrlToBuffer(value) {
  const raw = String(value || "").trim();
  if (!raw) return Buffer.alloc(0);
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
  return Buffer.from(`${normalized}${pad}`, "base64");
}

function safeHeaderFilename(value) {
  const name = String(value || "bulletins.pdf")
    .replace(/[\r\n"]/g, " ")
    .trim();
  return name || "bulletins.pdf";
}

function encodeFilenameForDisposition(value) {
  return encodeURIComponent(safeHeaderFilename(value))
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
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
    if (auth.error) {
      return json(res, auth.error.status, { ok: false, error: auth.error.message });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const messageId = String(body?.message_id || "").trim();
    const attachmentId = String(body?.attachment_id || "").trim();
    const attachmentName = safeHeaderFilename(body?.attachment_name || "bulletins.pdf");

    if (!messageId) return json(res, 400, { ok: false, error: "Missing message_id" });
    if (!attachmentId) return json(res, 400, { ok: false, error: "Missing attachment_id" });

    const accessToken = await loadConnectionWithAccessToken(auth.admin, auth.user.id);
    const payload = await googleGet(
      accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    );

    const bytes = decodeGmailBase64UrlToBuffer(payload?.data || "");
    if (!bytes.length) {
      return json(res, 404, { ok: false, error: "Pièce jointe Gmail introuvable ou vide." });
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeFilenameForDisposition(attachmentName)}`
    );
    return res.status(200).send(bytes);
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
