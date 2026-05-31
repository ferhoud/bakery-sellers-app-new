import {
  GOOGLE_MAIL_PROVIDER,
  decryptSecret,
  encryptSecret,
  expiresAtFromTokenResponse,
  refreshGoogleTokens,
} from "@/lib/server/googlePayslipMail";

export function isGmailReconnectRequiredError(e) {
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

  return (
    raw.includes("token has been expired or revoked") ||
    raw.includes("expired or revoked") ||
    raw.includes("invalid_grant") ||
    raw.includes("revoked") ||
    raw.includes("invalid credentials")
  );
}

export function gmailReconnectMessage(action = "l’envoi") {
  return `Connexion Gmail expirée ou révoquée. Reconnecte Gmail depuis la page Fiches de paie, puis réessaie ${action}.`;
}

export function hasSendScope(scopeValue) {
  const scope = String(scopeValue || "");
  return (
    scope.includes("https://www.googleapis.com/auth/gmail.compose") ||
    scope.includes("https://www.googleapis.com/auth/gmail.send") ||
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

export function buildRawPayrollMail({ toEmail, subject, body }) {
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

export async function loadPayrollGmailConnectionWithAccessToken(admin, { userId = "" } = {}) {
  let query = admin
    .from("admin_mail_connections")
    .select("*")
    .eq("provider", GOOGLE_MAIL_PROVIDER);

  if (userId) query = query.eq("user_id", userId);

  const { data: exactConn, error: exactErr } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (exactErr) throw exactErr;

  let conn = exactConn || null;

  // En mode cron, on n'a pas de session admin. On prend donc la dernière connexion Gmail disponible.
  if (!conn && !userId) {
    const { data: fallbackConn, error: fallbackErr } = await admin
      .from("admin_mail_connections")
      .select("*")
      .eq("provider", GOOGLE_MAIL_PROVIDER)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fallbackErr) throw fallbackErr;
    conn = fallbackConn || null;
  }

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

    let updateQuery = admin
      .from("admin_mail_connections")
      .update({
        access_token_encrypted: encryptSecret(accessToken),
        refresh_token_encrypted: encryptSecret(nextRefresh),
        access_token_expires_at: expiresAtFromTokenResponse(refreshed),
        scope,
        updated_at: new Date().toISOString(),
      })
      .eq("provider", GOOGLE_MAIL_PROVIDER);

    if (conn?.user_id) {
      updateQuery = updateQuery.eq("user_id", conn.user_id);
    }

    const { error: updateErr } = await updateQuery;
    if (updateErr) throw updateErr;
  }

  return { accessToken, scope, connection: conn };
}

export async function sendPayrollEmailViaGmail(admin, { userId = "", toEmail, subject, body }) {
  const { accessToken, scope, connection } = await loadPayrollGmailConnectionWithAccessToken(admin, { userId });

  if (!hasSendScope(scope)) {
    const err = new Error(
      "La boîte Gmail connectée n’a pas encore le droit d’envoyer. Reconnecte Gmail avec le droit de composition/envoi."
    );
    err.code = "GMAIL_SEND_SCOPE_REQUIRED";
    throw err;
  }

  const raw = buildRawPayrollMail({ toEmail, subject, body });
  const gmailMessage = await gmailJson(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      body: { raw },
    }
  );

  return {
    gmail_message_id: String(gmailMessage?.id || "").trim() || null,
    connection,
  };
}
