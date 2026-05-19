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

// Filtre volontairement strict pour ne garder que les vraies fiches de paie mensuelles
// envoyées par le cabinet, dont les PDF commencent par "Paie" ou "Paies".
function isMonthlyPayslipAttachmentName(filename) {
  const name = String(filename || "").trim();
  return /^(paie|paies)\b/i.test(name);
}

// Certains mails mensuels du cabinet ont un objet très clair
// ("Paie juillet 2025") mais un nom de PDF moins standard.
// On les autorise à passer au classement au lieu de les jeter trop tôt.
function subjectLooksLikeMonthlyPayslip(subject, receivedAt) {
  const text = String(subject || "");
  const normalized = normalizeLoose(text);

  const mentionsPaie = /\b(paie|paies|paye|payes)\b/.test(normalized);
  const monthHint = detectSingleMonthHint(text, receivedAt);

  return mentionsPaie && Boolean(monthHint?.iso);
}

const FR_MONTHS = {
  janvier: 1,
  janv: 1,
  jan: 1,
  fevrier: 2,
  février: 2,
  fev: 2,
  fév: 2,
  mars: 3,
  avril: 4,
  avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  juil: 7,
  aout: 8,
  août: 8,
  septembre: 9,
  sept: 9,
  sep: 9,
  octobre: 10,
  oct: 10,
  novembre: 11,
  nov: 11,
  decembre: 12,
  décembre: 12,
  dec: 12,
  déc: 12,
};

function normalizeLoose(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text, words) {
  const hay = normalizeLoose(text);
  return (words || []).some((word) => hay.includes(normalizeLoose(word)));
}

function decodeGmailBase64Url(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
    return Buffer.from(`${normalized}${pad}`, "base64").toString("utf8");
  } catch (_) {
    return "";
  }
}

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMessageText(payload, fallback = "") {
  const plain = [];
  const html = [];

  function visit(part) {
    if (!part) return;
    const mime = String(part?.mimeType || "").toLowerCase();
    const decoded = decodeGmailBase64Url(part?.body?.data || "");

    if (decoded) {
      if (mime === "text/plain") plain.push(decoded);
      if (mime === "text/html") html.push(htmlToPlainText(decoded));
    }

    for (const child of part?.parts || []) {
      visit(child);
    }
  }

  visit(payload);

  const picked = plain.length ? plain.join("\n") : html.join("\n");
  const text = String(picked || fallback || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 4000);
}

function receivedYear(receivedAt) {
  try {
    const y = new Date(receivedAt || Date.now()).getFullYear();
    return Number.isFinite(y) ? y : new Date().getFullYear();
  } catch (_) {
    return new Date().getFullYear();
  }
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

function monthIso(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

function detectSingleMonthHint(value, receivedAt) {
  const raw = String(value || "");
  const normalized = normalizeLoose(raw);
  const refYear = receivedYear(receivedAt);

  const dotted = /\b(0?[1-9]|1[0-2])[.\-_/](\d{2}|\d{4})\b/.exec(normalized);
  if (dotted) {
    const month = Number(dotted[1]);
    const yearRaw = String(dotted[2]);
    const year = yearRaw.length === 2 ? twoDigitYearToFull(yearRaw, refYear) : Number(yearRaw);
    const iso = monthIso(year, month);
    if (iso) {
      return {
        iso,
        month,
        year,
        source: "numeric",
        raw: dotted[0],
      };
    }
  }

  for (const [name, month] of Object.entries(FR_MONTHS)) {
    const re = new RegExp(`\\b${name}\\b(?:\\s+|\\s*[-/·]\\s*)?(20\\d{2})?`, "i");
    const m = re.exec(normalized);
    if (m) {
      const year = Number(m[1] || refYear);
      const iso = monthIso(year, month);
      if (iso) {
        return {
          iso,
          month,
          year,
          source: "french_month",
          raw: m[0],
        };
      }
    }
  }

  return null;
}

function monthHintLabel(hint) {
  if (!hint?.iso) return "";
  const [year, month] = hint.iso.split("-");
  return `${month}/${year}`;
}

function looksLikeMultiMonthArchive(value) {
  const text = normalizeLoose(value);
  return (
    /\b(jan|janv|janvier)\s*(a|à|-)\s*(sep|sept|septembre)\b/.test(text) ||
    /\b(jan|janv|janvier)\s*(a|à|-)\s*(dec|decembre)\b/.test(text) ||
    /\b(plusieurs mois|multi mois|multi-mois|archive)\b/.test(text)
  );
}

function finalLabel(type) {
  if (type === "monthly_payroll") return "Paies mensuelles BM";
  if (type === "correction") return "Correction / paie modifiée";
  if (type === "individual_payslip") return "Fiche individuelle";
  if (type === "exit_documents") return "Paie liée à une sortie";
  if (type === "archive_multi_month") return "Archive multi-mois";
  return "À vérifier";
}

function heuristicClassification({ subject, attachmentName, mailBodyText, receivedAt }) {
  const subjectText = String(subject || "");
  const attachmentText = String(attachmentName || "");
  const bodyText = String(mailBodyText || "");
  const allText = `${subjectText}\n${attachmentText}\n${bodyText}`;

  const normalizedSubject = normalizeLoose(subjectText);
  const normalizedAttachment = normalizeLoose(attachmentText);
  const normalizedAll = normalizeLoose(allText);

  const exitWords = [
    "doc de sortie",
    "docs de sortie",
    "document de sortie",
    "documents de sortie",
    "solde de tout compte",
    "certificat de travail",
    "attestation france travail",
    "fin de contrat",
    "sortie",
  ];

  const correctionWords = [
    "modifie",
    "modifier",
    "modifiee",
    "corrige",
    "corrigee",
    "correction",
    "rectificatif",
    "rectifie",
    "rectifiee",
    "remplace",
    "annule et remplace",
  ];

  const fileMonth = detectSingleMonthHint(attachmentText, receivedAt);
  const subjectMonth = detectSingleMonthHint(subjectText, receivedAt);
  const bodyMonth = detectSingleMonthHint(bodyText, receivedAt);
  const detectedMonth = subjectMonth || fileMonth || bodyMonth || null;

  const warnings = [];
  if (fileMonth?.iso && subjectMonth?.iso && fileMonth.iso !== subjectMonth.iso) {
    warnings.push(
      `Mois incohérent entre le nom du PDF (${monthHintLabel(fileMonth)}) et l’objet du mail (${monthHintLabel(subjectMonth)}).`
    );
  }

  const fileLooksBm =
    normalizedAttachment.includes("bm boulangerie") ||
    normalizedAttachment.includes("bm boul") ||
    /\bbm\b/.test(normalizedAttachment);

  const attachmentStartsPaie = /^(paie|paies)\b/i.test(String(attachmentName || "").trim());
  const isPluralPaies = /^paies\b/i.test(String(attachmentName || "").trim());
  // On distingue volontairement les signaux "forts" visibles dans l'objet ou le nom
  // du PDF des mots éventuellement présents dans le corps du mail.
  // Un cabinet peut écrire "à corriger si besoin" dans un mail parfaitement normal :
  // cela ne doit pas faire sortir un vrai lot mensuel BM de la liste principale.
  const hasExitSignalsStrong =
    hasAny(normalizedSubject, exitWords) ||
    hasAny(normalizedAttachment, exitWords);
  const hasExitSignalsBody = hasAny(bodyText, exitWords);

  const hasCorrectionSignalsStrong =
    hasAny(normalizedSubject, correctionWords) ||
    hasAny(normalizedAttachment, correctionWords);
  const hasCorrectionSignalsBody = hasAny(bodyText, correctionWords);

  const hasArchiveSignalsStrong =
    looksLikeMultiMonthArchive(subjectText) ||
    looksLikeMultiMonthArchive(attachmentText);
  const hasArchiveSignalsBody = looksLikeMultiMonthArchive(bodyText);

  const subjectLooksMonthly = subjectLooksLikeMonthlyPayslip(subjectText, receivedAt);

  const strongMonthlyBm =
    fileLooksBm &&
    Boolean(detectedMonth?.iso) &&
    (attachmentStartsPaie || subjectLooksMonthly);

  let type = "needs_review";
  let reason = "Le scan n’a pas assez d’indices fiables pour classer ce PDF automatiquement.";
  let confidence = 55;

  if (hasArchiveSignalsStrong || (!strongMonthlyBm && hasArchiveSignalsBody)) {
    type = "archive_multi_month";
    reason = "Le mail ou le nom du PDF évoque un lot couvrant plusieurs mois.";
    confidence = hasArchiveSignalsStrong ? 96 : 82;
  } else if (hasExitSignalsStrong || (!strongMonthlyBm && hasExitSignalsBody)) {
    type = "exit_documents";
    reason = "Le contenu du mail évoque une sortie de salarié ou des documents de fin de contrat.";
    confidence = hasExitSignalsStrong ? 95 : 80;
  } else if (hasCorrectionSignalsStrong || (!strongMonthlyBm && hasCorrectionSignalsBody)) {
    type = "correction";
    reason = "Le mail ou le nom du PDF indique une modification, une correction ou un remplacement.";
    confidence = hasCorrectionSignalsStrong ? 94 : 78;
  } else if (strongMonthlyBm) {
    type = "monthly_payroll";
    reason = "Le PDF ressemble au lot mensuel BM : nom collectif BM + mois détecté.";
    confidence = 98;
  } else if (attachmentStartsPaie && isPluralPaies && fileLooksBm) {
    type = "monthly_payroll";
    reason = "Le PDF ressemble à un lot collectif BM de paies mensuelles.";
    confidence = 92;
  } else if (attachmentStartsPaie && detectedMonth?.iso && !fileLooksBm) {
    type = "individual_payslip";
    reason = "Le PDF ressemble à une fiche individuelle avec un mois détecté, sans marqueur BM collectif.";
    confidence = 91;
  } else if (attachmentStartsPaie && !fileLooksBm) {
    type = "individual_payslip";
    reason = "Le PDF ressemble davantage à une fiche individuelle qu’à un lot mensuel BM.";
    confidence = 82;
  }

  if (warnings.length && type === "monthly_payroll") {
    confidence = Math.min(confidence, 88);
  }

  return {
    type,
    label: finalLabel(type),
    reason,
    confidence,
    detected_month: detectedMonth?.iso || "",
    detected_month_source: detectedMonth?.source || "",
    filename_month_hint: fileMonth?.iso || "",
    subject_month_hint: subjectMonth?.iso || "",
    warnings,
  };
}

function parseJsonLoose(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {}

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

function outputTextFromResponsesApi(payload) {
  const direct = String(payload?.output_text || "").trim();
  if (direct) return direct;

  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      const text = content?.text || content?.value || "";
      if (text) chunks.push(String(text));
    }
  }
  return chunks.join("\n").trim();
}

function shouldAskAi(heuristic) {
  if (!heuristic) return false;
  return heuristic.type === "needs_review" || (heuristic.warnings || []).length > 0;
}

async function maybeAiClassifyCandidate({ subject, attachmentName, mailBodyText, heuristic }) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || !shouldAskAi(heuristic)) return null;

  const model = String(process.env.OPENAI_PAYSLIP_MAIL_MODEL || "gpt-4o-mini").trim();
  if (!model) return null;

  const prompt = [
    "Tu classes un PDF trouvé dans un email de comptable pour une boulangerie.",
    "Réponds uniquement en JSON valide, sans texte autour.",
    'Valeurs autorisées pour "type": "monthly_payroll", "correction", "individual_payslip", "exit_documents", "archive_multi_month", "needs_review".',
    "Règle métier : monthly_payroll = lot mensuel collectif BM à importer comme PDF global du mois.",
    "correction = paie modifiée / rectifiée / remplacement.",
    "individual_payslip = fiche isolée d’un salarié.",
    "exit_documents = contexte de départ ou documents de fin de contrat.",
    "archive_multi_month = lot couvrant plusieurs mois.",
    "needs_review = ambigu.",
    'Format exact : {"type":"...","reason":"...","confidence":0}.',
    "",
    `Objet : ${String(subject || "").slice(0, 240)}`,
    `Nom du PDF : ${String(attachmentName || "").slice(0, 240)}`,
    `Texte du mail : ${String(mailBodyText || "").slice(0, 1800)}`,
    `Classement heuristique actuel : ${JSON.stringify(heuristic || {})}`,
  ].join("\n");

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: 220,
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return null;

    const parsed = parseJsonLoose(outputTextFromResponsesApi(data));
    const type = String(parsed?.type || "").trim();
    const allowed = new Set([
      "monthly_payroll",
      "correction",
      "individual_payslip",
      "exit_documents",
      "archive_multi_month",
      "needs_review",
    ]);

    if (!allowed.has(type)) return null;

    const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed?.confidence || 0) || 0)));
    return {
      type,
      label: finalLabel(type),
      reason: String(parsed?.reason || "").slice(0, 260) || "Classement assisté par IA.",
      confidence: confidence || 70,
    };
  } catch (_) {
    return null;
  }
}

function mergeClassification(heuristic, ai) {
  if (!ai) return { ...(heuristic || {}) };
  return {
    ...(heuristic || {}),
    type: ai.type,
    label: ai.label,
    reason: ai.reason,
    confidence: ai.confidence,
    ai_reviewed: true,
    heuristic_type: heuristic?.type || "",
    heuristic_label: heuristic?.label || "",
  };
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
    // Le front historique envoyait encore 150. Côté serveur, on force maintenant
    // un scan plus profond pour éviter de rater les mois plus anciens.
    const requestedMaxMessages = Number(body?.max_messages || 600) || 600;
    const maxMessages = Math.min(Math.max(requestedMaxMessages, 600), 1200);

    const accessToken = await loadConnectionWithAccessToken(auth.admin, auth.user.id);

    const gmailAfter = /^\d{4}-\d{2}-\d{2}$/.test(sinceDate)
      ? ` after:${sinceDate.replace(/-/g, "/")}`
      : "";

    const q =
      `from:davy.azoulay@yahoo.fr ` +
      `(subject:Paie OR subject:Paies) ` +
      `has:attachment filename:pdf${gmailAfter}`;
    let url =
      "https://gmail.googleapis.com/gmail/v1/users/me/messages" +
      `?maxResults=100&q=${encodeURIComponent(q)}`;

    const messageRefs = [];
    let pagesFetched = 0;

    while (url && messageRefs.length < maxMessages) {
      const page = await googleGet(accessToken, url);
      pagesFetched += 1;
      const values = Array.isArray(page?.messages) ? page.messages : [];
      messageRefs.push(...values);
      const token = String(page?.nextPageToken || "").trim();
      url = token
        ? "https://gmail.googleapis.com/gmail/v1/users/me/messages" +
          `?maxResults=100&q=${encodeURIComponent(q)}&pageToken=${encodeURIComponent(token)}`
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

    const allCandidates = [];
    const maxAiReviews = Math.min(
      Math.max(Number(process.env.PAYSLIP_MAIL_AI_MAX_ITEMS || 12) || 12, 0),
      40
    );
    let aiReviewsUsed = 0;

    for (const message of fullMessages || []) {
      const headers = message?.payload?.headers || [];
      const subject = headerValue(headers, "Subject");
      const dateHeader = headerValue(headers, "Date");
      const receivedAt = message?.internalDate
        ? new Date(Number(message.internalDate)).toISOString()
        : (dateHeader || null);
      const from = decodeFromHeader(headerValue(headers, "From"));
      const pdfParts = walkParts(message?.payload?.parts || []);
      const mailBodyText = extractMessageText(message?.payload || null, message?.snippet || "");

      for (const part of pdfParts) {
        const attachmentName = part.filename || "piece-jointe.pdf";

        // Sécurité générale : on garde les PDF nommés Paie / Paies.
        // Exception utile : si l’objet du mail indique clairement une paie mensuelle
        // avec un mois détectable ("Paie juillet 2025"), on laisse aussi passer le PDF,
        // même si son nom est atypique. Cela évite de rater un mois comme juillet.
        const monthlySubjectHint = subjectLooksLikeMonthlyPayslip(subject, receivedAt);
        if (!isMonthlyPayslipAttachmentName(attachmentName) && !monthlySubjectHint) {
          continue;
        }

        const heuristic = heuristicClassification({
          subject,
          attachmentName,
          mailBodyText,
          receivedAt,
        });

        let ai = null;
        if (aiReviewsUsed < maxAiReviews && shouldAskAi(heuristic)) {
          aiReviewsUsed += 1;
          ai = await maybeAiClassifyCandidate({
            subject,
            attachmentName,
            mailBodyText,
            heuristic,
          });
        }

        const classification = mergeClassification(heuristic, ai);

        allCandidates.push({
          message_id: message.id,
          subject,
          from_name: from.from_name,
          from_email: from.from_email,
          received_at: receivedAt,
          attachment_id: part.body.attachmentId,
          attachment_name: attachmentName,
          content_type: part.mimeType || "application/pdf",
          size: Number(part.body.size || 0) || 0,
          likely_payslip: likelyPayslip({
            subject,
            attachmentName,
          }),
          mail_classification: classification.type || "needs_review",
          mail_classification_label: classification.label || finalLabel("needs_review"),
          mail_classification_reason: classification.reason || "",
          mail_classification_confidence: Number(classification.confidence || 0) || 0,
          mail_classification_ai_reviewed: classification.ai_reviewed === true,
          heuristic_mail_classification: classification.heuristic_type || heuristic?.type || "",
          detected_month: classification.detected_month || "",
          detected_month_source: classification.detected_month_source || "",
          filename_month_hint: classification.filename_month_hint || "",
          subject_month_hint: classification.subject_month_hint || "",
          warnings: Array.isArray(classification.warnings) ? classification.warnings : [],
          is_main_monthly_payroll: classification.type === "monthly_payroll",
        });
      }
    }

    allCandidates.sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || "")));

    // Compatibilité avec l’interface actuelle :
    // "candidates" ne contient plus que les lots mensuels BM recommandés.
    // Les autres éléments restent renvoyés séparément pour une prochaine UI dédiée
    // aux corrections, fiches individuelles et archives.
    const candidates = allCandidates.filter((row) => row.is_main_monthly_payroll === true);
    const correctionCandidates = allCandidates.filter((row) => row.mail_classification === "correction");
    const individualCandidates = allCandidates.filter((row) => row.mail_classification === "individual_payslip");
    const exitDocumentCandidates = allCandidates.filter((row) => row.mail_classification === "exit_documents");
    const archiveCandidates = allCandidates.filter((row) => row.mail_classification === "archive_multi_month");
    const reviewCandidates = allCandidates.filter((row) => row.mail_classification === "needs_review");

    return json(res, 200, {
      ok: true,
      summary: {
        messages_scanned: trimmed.length,
        pdf_candidates: candidates.length,
        all_pdf_candidates: allCandidates.length,
        monthly_payroll_candidates: candidates.length,
        correction_candidates: correctionCandidates.length,
        individual_payslip_candidates: individualCandidates.length,
        exit_document_candidates: exitDocumentCandidates.length,
        archive_candidates: archiveCandidates.length,
        review_candidates: reviewCandidates.length,
        pages_fetched: pagesFetched,
        scan_limit: maxMessages,
        scan_truncated: Boolean(url && messageRefs.length >= maxMessages),
        ai_reviews_attempted: aiReviewsUsed,
        ai_reviews_enabled: Boolean(String(process.env.OPENAI_API_KEY || "").trim()),
      },
      candidates,
      grouped_candidates: {
        monthly_payroll: candidates,
        correction: correctionCandidates,
        individual_payslip: individualCandidates,
        exit_documents: exitDocumentCandidates,
        archive_multi_month: archiveCandidates,
        needs_review: reviewCandidates,
      },
      all_candidates: allCandidates,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
