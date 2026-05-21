import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";
import { parsePayrollMonth } from "@/lib/server/payrollEmail";

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

function parisParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  const day = parts.find((p) => p.type === "day")?.value || "";
  return { year, month, day };
}

function currentParisMonthValue() {
  const p = parisParts();
  return /^\d{4}$/.test(p.year) && /^\d{2}$/.test(p.month) ? `${p.year}-${p.month}` : "";
}

function phaseForRow(row, reminderWindowActive) {
  if (!row?.id) return "none";
  if (row?.sent_at) return "sent";
  if (!reminderWindowActive) return "waiting_window";
  if (row?.needs_review) return "needs_review";
  return "ready_to_send";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const requestedMonth = String(req.query?.month || req.query?.payroll_month || currentParisMonthValue() || "").trim();
    const month = parsePayrollMonth(requestedMonth);
    if (!month) {
      return json(res, 400, { ok: false, error: "Mois de paie invalide." });
    }

    const { data: row, error } = await auth.admin
      .from("payroll_email_drafts")
      .select("id, payroll_month, status, needs_review, reviewed_at, sent_at, last_auto_refresh_at, last_auto_change_at")
      .eq("payroll_month", month.payroll_month)
      .maybeSingle();

    if (error) throw error;

    const p = parisParts();
    const parisDay = Number(p.day || 0) || 0;
    const forceTest =
      String(req.query?.force || "") === "1" ||
      String(req.query?.test || "") === "1" ||
      String(req.query?.testPayrollReminder || "") === "1";
    const reminderWindowActive = forceTest || parisDay >= 27;
    const phase = phaseForRow(row, reminderWindowActive);
    const active = phase === "needs_review" || phase === "ready_to_send";

    return json(res, 200, {
      ok: true,
      month: month.value,
      payroll_month: month.payroll_month,
      reminder_window_active: reminderWindowActive,
      reminder_window_starts_day: 27,
      test_mode: forceTest,
      phase,
      active,
      badge_count: active ? 1 : 0,
      row: row || null,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
