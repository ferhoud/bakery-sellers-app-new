import { createClient } from "@supabase/supabase-js";
import { refreshPayrollEmailRecord } from "@/lib/server/payrollEmail";
import {
  gmailReconnectMessage,
  isGmailReconnectRequiredError,
  sendPayrollEmailViaGmail,
} from "@/lib/server/payrollGmailSend";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

function parisParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: parts.find((p) => p.type === "year")?.value || "",
    month: parts.find((p) => p.type === "month")?.value || "",
    day: parts.find((p) => p.type === "day")?.value || "",
  };
}

function parisMonthValue(date = new Date()) {
  const p = parisParts(date);
  return /^\d{4}$/.test(p.year) && /^\d{2}$/.test(p.month) ? `${p.year}-${p.month}` : "";
}

function isLastDayOfMonthInParis(date = new Date()) {
  const today = parisParts(date);
  const tomorrowDate = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = parisParts(tomorrowDate);

  if (!today.year || !today.month || !tomorrow.year || !tomorrow.month) return false;
  return today.month !== tomorrow.month || today.year !== tomorrow.year;
}

function rowIsSafeForAutoSend(row) {
  if (!row || !row.id) return false;
  if (row.sent_at) return false;
  if (row.needs_review) return false;

  const status = String(row.status || "").toLowerCase();
  if (status && !["reviewed", "auto_ready"].includes(status)) return false;

  if (!row.reviewed_at) return false;
  if (!String(row.to_email || row.auto_to_email || "").includes("@")) return false;
  if (!String(row.subject || row.auto_subject || "").trim()) return false;
  if (!String(row.body || row.auto_body || "").trim()) return false;

  return true;
}

async function markAutoSendError(admin, row, errorMessage) {
  if (!row?.id) return null;

  const { data } = await admin
    .from("payroll_email_drafts")
    .update({
      status: "gmail_error",
      last_send_error: String(errorMessage || "Erreur envoi automatique"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select("*")
    .maybeSingle();

  return data || null;
}

async function autoSendIfAllowed(admin, row) {
  if (!rowIsSafeForAutoSend(row)) {
    return {
      attempted: false,
      sent: false,
      reason: row?.sent_at
        ? "already_sent"
        : row?.needs_review
          ? "needs_review"
          : !row?.reviewed_at
            ? "not_reviewed"
            : "not_eligible",
      row,
    };
  }

  const toEmail = String(row.to_email || row.auto_to_email || "").trim();
  const subject = String(row.subject || row.auto_subject || "").trim();
  const mailBody = String(row.body || row.auto_body || "").trim();

  try {
    const sent = await sendPayrollEmailViaGmail(admin, {
      // En cron, pas de session admin. Le helper prend la dernière connexion Gmail valide.
      userId: "",
      toEmail,
      subject,
      body: mailBody,
    });

    const now = new Date().toISOString();
    const { data: saved, error: saveErr } = await admin
      .from("payroll_email_drafts")
      .update({
        to_email: toEmail,
        subject,
        body: mailBody,
        needs_review: false,
        status: "sent",
        sent_at: now,
        sent_gmail_message_id: sent.gmail_message_id,
        last_send_error: null,
        updated_at: now,
      })
      .eq("id", row.id)
      .is("sent_at", null)
      .select("*")
      .maybeSingle();

    if (saveErr) throw saveErr;

    return {
      attempted: true,
      sent: !!saved?.sent_at,
      gmail_message_id: sent.gmail_message_id,
      row: saved || row,
    };
  } catch (e) {
    const friendly = isGmailReconnectRequiredError(e)
      ? gmailReconnectMessage("l’envoi automatique")
      : e?.message || "Erreur envoi automatique";

    const saved = await markAutoSendError(admin, row, friendly);

    return {
      attempted: true,
      sent: false,
      code: isGmailReconnectRequiredError(e) ? "GMAIL_RECONNECT_REQUIRED" : "AUTO_SEND_FAILED",
      error: friendly,
      row: saved || row,
    };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const authHeader = String(req.headers.authorization || req.headers.Authorization || "");
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return json(res, 401, { ok: false, error: "Unauthorized cron request" });
    }

    const admin = adminClient();
    if (!admin) {
      return json(res, 500, { ok: false, error: "Missing Supabase service env" });
    }

    const month = parisMonthValue();
    if (!month) {
      return json(res, 500, { ok: false, error: "Impossible de déterminer le mois courant Europe/Paris." });
    }

    const result = await refreshPayrollEmailRecord(admin, month, { source: "cron_daily" });
    const lastDayOfMonth = isLastDayOfMonthInParis();
    const autoSend = lastDayOfMonth
      ? await autoSendIfAllowed(admin, result?.row || null)
      : { attempted: false, sent: false, reason: "not_last_day_of_month" };

    return json(res, 200, {
      ok: true,
      month,
      created: !!result?.created,
      changed: !!result?.changed,
      row_id: autoSend?.row?.id || result?.row?.id || null,
      needs_review: !!(autoSend?.row || result?.row)?.needs_review,
      status: (autoSend?.row || result?.row)?.status || null,
      last_day_of_month: lastDayOfMonth,
      auto_send: {
        attempted: !!autoSend?.attempted,
        sent: !!autoSend?.sent,
        reason: autoSend?.reason || null,
        code: autoSend?.code || null,
        error: autoSend?.error || null,
        gmail_message_id: autoSend?.gmail_message_id || null,
      },
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
