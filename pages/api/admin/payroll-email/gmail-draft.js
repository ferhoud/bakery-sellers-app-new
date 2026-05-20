import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h || ""));
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


import { parsePayrollMonth } from "@/lib/server/payrollEmail";
import {
  GOOGLE_MAIL_PROVIDER,
  decryptSecret,
  encryptSecret,
  expiresAtFromTokenResponse,
  refreshGoogleTokens,
} from "@/lib/server/googlePayslipMail";

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

function hasDraftScope(scopeValue) {
  const scope = String(scopeValue || "");
  return (
    scope.includes("https://www.googleapis.com/auth/gmail.compose") ||
    scope.includes("https://www.googleapis.com/auth/gmail.modify") ||
    scope.includes("https://mail.google.com/")
  );
}

function encodeMimeHeader(value) {
  const raw = String(value || "");
  return `=?UTF-8?B?${Buffer.from(raw, "utf8").toString("base64")}?=`;
}

function base64UrlEncode(value) {
  return Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildRawMail({ toEmail, subject, body }) {
  const headers = [
    `To: ${toEmail}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    "",
  ];
  return base64UrlEncode(`${headers.join("\r\n")}${String(body || "").replace(/\n/g, "\r\n")}`);
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
  let scope = String(conn.scope || "");
  const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;

  if (!accessToken || !refreshToken || expiresAt <= Date.now() + 60_000) {
    if (!refreshToken) throw new Error("Jeton de rafraîchissement Gmail manquant.");

    const refreshed = await refreshGoogleTokens(refreshToken);
    accessToken = String(refreshed?.access_token || "");
    const nextRefresh = String(refreshed?.refresh_token || refreshToken);
    scope = String(refreshed?.scope || conn.scope || "");

    if (!accessToken) throw new Error("Rafraîchissement Gmail incomplet.");

    const { error: updateErr } = await admin
      .from("admin_mail_connections")
      .update({
        access_token_encrypted: encryptSecret(accessToken),
        refresh_token_encrypted: encryptSecret(nextRefresh),
        access_token_expires_at: expiresAtFromTokenResponse(refreshed),
        scope,
        updated_at: new Date().toISOString(),
      })
      .eq("provider", GOOGLE_MAIL_PROVIDER)
      .eq("user_id", userId);

    if (updateErr) throw updateErr;
  }

  return { accessToken, scope };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const body = bodyObject(req);
    const month = parsePayrollMonth(body?.month || body?.payroll_month || "");
    const toEmail = String(body?.to_email || "").trim();
    const subject = String(body?.subject || "").trim();
    const mailBody = String(body?.body || "").trim();

    if (!month) return json(res, 400, { ok: false, error: "Mois invalide." });
    if (!toEmail || !toEmail.includes("@")) return json(res, 400, { ok: false, error: "Adresse du comptable invalide." });
    if (!subject) return json(res, 400, { ok: false, error: "Objet du mail vide." });
    if (!mailBody) return json(res, 400, { ok: false, error: "Contenu du mail vide." });

    const { accessToken, scope } = await loadConnectionWithAccessToken(auth.admin, auth.user.id);

    if (!hasDraftScope(scope)) {
      return json(res, 409, {
        ok: false,
        code: "GMAIL_DRAFT_SCOPE_REQUIRED",
        error:
          "La boîte Gmail connectée permet de lire les paies, mais pas encore de créer des brouillons. Il faudra réautoriser Gmail avec le droit de composition.",
      });
    }

    const raw = buildRawMail({ toEmail, subject, body: mailBody });

    const { data: existingDraft, error: existingErr } = await auth.admin
      .from("payroll_email_drafts")
      .select("*")
      .eq("payroll_month", month.payroll_month)
      .maybeSingle();

    if (existingErr) throw existingErr;

    let gmailDraft = null;
    let action = "created";

    if (existingDraft?.gmail_draft_id) {
      try {
        gmailDraft = await gmailJson(
          accessToken,
          `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(existingDraft.gmail_draft_id)}`,
          {
            method: "PUT",
            body: { message: { raw } },
          }
        );
        action = "updated";
      } catch (e) {
        if (Number(e?.status || 0) !== 404) throw e;
      }
    }

    if (!gmailDraft) {
      gmailDraft = await gmailJson(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST",
        body: { message: { raw } },
      });
      action = "created";
    }

    const draftId = String(gmailDraft?.id || "").trim();
    if (!draftId) throw new Error("Gmail a répondu sans identifiant de brouillon.");

    const payload = {
      payroll_month: month.payroll_month,
      to_email: toEmail,
      subject,
      body: mailBody,
      status: "gmail_draft_ready",
      gmail_draft_id: draftId,
      gmail_draft_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: saved, error: saveErr } = await auth.admin
      .from("payroll_email_drafts")
      .upsert(payload, { onConflict: "payroll_month" })
      .select("*")
      .single();

    if (saveErr) throw saveErr;

    return json(res, 200, {
      ok: true,
      action,
      gmail_draft_id: draftId,
      row: saved,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
