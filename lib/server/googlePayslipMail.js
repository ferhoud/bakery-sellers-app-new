// lib/server/googlePayslipMail.js
import crypto from "crypto";

export const GOOGLE_MAIL_PROVIDER = "gmail";
export const GOOGLE_MAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
].join(" ");

export function getGoogleRedirectUri(req) {
  const configured = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  if (configured) return configured;

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const host = String(req.headers.host || "").trim();
  if (!host) throw new Error("Impossible de calculer GOOGLE_REDIRECT_URI.");
  return `${proto}://${host}/api/admin/payslips/mail/google/callback`;
}

export function requireGoogleEnv() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const tokenSecret = String(process.env.GOOGLE_MAIL_TOKEN_SECRET || "").trim();

  if (!clientId) throw new Error("GOOGLE_CLIENT_ID manquant.");
  if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET manquant.");
  if (!tokenSecret || tokenSecret.length < 24) {
    throw new Error("GOOGLE_MAIL_TOKEN_SECRET manquant ou trop court.");
  }

  return { clientId, clientSecret, tokenSecret };
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const s = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64");
}

export function randomUrlSafe(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

export function pkcePair() {
  const verifier = randomUrlSafe(48);
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function encryptionKey() {
  const { tokenSecret } = requireGoogleEnv();
  return crypto.createHash("sha256").update(tokenSecret).digest();
}

export function encryptSecret(value) {
  const text = String(value || "");
  if (!text) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [base64Url(iv), base64Url(tag), base64Url(encrypted)].join(".");
}

export function decryptSecret(payload) {
  const raw = String(payload || "").trim();
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 3) throw new Error("Secret chiffré invalide.");

  const [ivPart, tagPart, dataPart] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), fromBase64Url(ivPart));
  decipher.setAuthTag(fromBase64Url(tagPart));
  const decrypted = Buffer.concat([
    decipher.update(fromBase64Url(dataPart)),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export async function exchangeAuthorizationCode({ code, codeVerifier, redirectUri }) {
  const { clientId, clientSecret } = requireGoogleEnv();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: String(code || ""),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: String(codeVerifier || ""),
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json?.error_description || json?.error || `Échange OAuth Google impossible (${resp.status}).`);
  }

  return json;
}

export async function refreshGoogleTokens(refreshToken) {
  const { clientId, clientSecret } = requireGoogleEnv();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: String(refreshToken || ""),
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json?.error_description || json?.error || `Rafraîchissement OAuth Google impossible (${resp.status}).`);
  }

  return json;
}

export function expiresAtFromTokenResponse(tokens) {
  const seconds = Number(tokens?.expires_in || 0) || 0;
  return new Date(Date.now() + Math.max(0, seconds - 60) * 1000).toISOString();
}

export async function googleGet(accessToken, url) {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${String(accessToken || "")}`,
      Accept: "application/json",
    },
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json?.error?.message || json?.error_description || `Google API (${resp.status}).`);
  }

  return json;
}

