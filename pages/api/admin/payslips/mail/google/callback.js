import { createClient } from "@supabase/supabase-js";
import {
  GOOGLE_MAIL_PROVIDER,
  encryptSecret,
  exchangeAuthorizationCode,
  expiresAtFromTokenResponse,
  getGoogleRedirectUri,
  googleGet,
} from "@/lib/server/googlePayslipMail";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

function appRedirect(req, suffix) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const host = String(req.headers.host || "").trim();
  const base = host ? `${proto}://${host}` : "";
  return `${base}/admin/payslips${suffix || ""}`;
}

export default async function handler(req, res) {
  const admin = adminClient();
  if (!admin) {
    res.writeHead(302, { Location: appRedirect(req, "?mail=error") });
    return res.end();
  }

  try {
    const error = String(req.query?.error || "").trim();
    const code = String(req.query?.code || "").trim();
    const state = String(req.query?.state || "").trim();

    if (error || !code || !state) {
      res.writeHead(302, { Location: appRedirect(req, "?mail=error") });
      return res.end();
    }

    const { data: stateRow, error: stateErr } = await admin
      .from("admin_mail_oauth_states")
      .select("state, user_id, code_verifier, expires_at")
      .eq("state", state)
      .maybeSingle();

    if (stateErr || !stateRow?.user_id || !stateRow?.code_verifier) {
      res.writeHead(302, { Location: appRedirect(req, "?mail=error") });
      return res.end();
    }

    if (stateRow.expires_at && new Date(stateRow.expires_at).getTime() < Date.now()) {
      await admin.from("admin_mail_oauth_states").delete().eq("state", state);
      res.writeHead(302, { Location: appRedirect(req, "?mail=error") });
      return res.end();
    }

    const redirectUri = getGoogleRedirectUri(req);
    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: stateRow.code_verifier,
      redirectUri,
    });

    const accessToken = String(tokens?.access_token || "");
    const refreshToken = String(tokens?.refresh_token || "");
    if (!accessToken || !refreshToken) {
      throw new Error("Tokens Google incomplets.");
    }

    const profile = await googleGet(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/profile");

    const payload = {
      provider: GOOGLE_MAIL_PROVIDER,
      user_id: stateRow.user_id,
      email: profile?.emailAddress || null,
      display_name: null,
      access_token_encrypted: encryptSecret(accessToken),
      refresh_token_encrypted: encryptSecret(refreshToken),
      access_token_expires_at: expiresAtFromTokenResponse(tokens),
      scope: String(tokens?.scope || ""),
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await admin
      .from("admin_mail_connections")
      .upsert(payload, { onConflict: "provider,user_id" });

    if (upsertErr) throw upsertErr;

    await admin.from("admin_mail_oauth_states").delete().eq("state", state);

    res.writeHead(302, { Location: appRedirect(req, "?mail=connected") });
    return res.end();
  } catch (_) {
    res.writeHead(302, { Location: appRedirect(req, "?mail=error") });
    return res.end();
  }
}
