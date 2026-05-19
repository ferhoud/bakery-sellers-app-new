// pages/api/admin/payslips/leave-balances.js
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
  if (!sbAnon) return { error: { status: 500, message: "Missing public Supabase env" } };

  const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
  if (auErr || !au?.user) {
    return { error: { status: 401, message: auErr?.message || "Unauthorized" } };
  }

  const admin = adminClient();
  if (!admin) return { error: { status: 500, message: "Missing SUPABASE_SERVICE_ROLE_KEY" } };

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

function safeNumber(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function ymd(dateValue) {
  return String(dateValue || "").slice(0, 10);
}

function endOfMonthIso(monthStart) {
  const s = ymd(monthStart);
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(s);
  if (!m) return s || null;

  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  const yyyy = String(last.getUTCFullYear());
  const mm = String(last.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(last.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function monthLabelFr(monthStart) {
  const s = ymd(monthStart);
  if (!s) return "—";
  try {
    const d = new Date(`${s}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return s.slice(0, 7);
    return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  } catch {
    return s.slice(0, 7);
  }
}

function normalizeBalance(raw) {
  const b = raw || {};
  return {
    cp_acquired_n: safeNumber(b.cp_acquired_n),
    cp_taken_n: safeNumber(b.cp_taken_n),
    cp_remaining_n: safeNumber(b.cp_remaining_n),
    cp_acquired_n1: safeNumber(b.cp_acquired_n1),
    cp_taken_n1: safeNumber(b.cp_taken_n1),
    cp_remaining_n1: safeNumber(b.cp_remaining_n1),
  };
}

function sameBalance(a, b) {
  const aa = normalizeBalance(a);
  const bb = normalizeBalance(b);
  return (
    aa.cp_acquired_n === bb.cp_acquired_n &&
    aa.cp_taken_n === bb.cp_taken_n &&
    aa.cp_remaining_n === bb.cp_remaining_n &&
    aa.cp_acquired_n1 === bb.cp_acquired_n1 &&
    aa.cp_taken_n1 === bb.cp_taken_n1 &&
    aa.cp_remaining_n1 === bb.cp_remaining_n1
  );
}

function normName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitNameWords(s) {
  return normName(s)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function employeeNameMatchesProfile(employeeName, fullName) {
  const employeeNorm = normName(employeeName);
  const profileNorm = normName(fullName);
  if (!employeeNorm || !profileNorm) return false;
  if (employeeNorm.includes(profileNorm)) return true;

  const profileTokens = splitNameWords(fullName);
  const employeeTokens = new Set(splitNameWords(employeeName));
  if (!profileTokens.length || !employeeTokens.size) return false;

  const hitCount = profileTokens.filter((token) => employeeTokens.has(token)).length;
  const ratio = hitCount / profileTokens.length;
  return ratio >= 0.66 || (profileTokens.length === 1 && hitCount === 1);
}

async function buildRows(admin) {
  const { data: payslips, error: payslipsErr } = await admin
    .from("employee_payslips")
    .select("id, employee_user_id, employee_display_name, payroll_month, extracted_leave_balance, created_at, storage_path")
    .not("employee_user_id", "is", null)
    .not("extracted_leave_balance", "is", null)
    .order("payroll_month", { ascending: false })
    .order("created_at", { ascending: false });

  if (payslipsErr) throw payslipsErr;

  const sellerIdsFromPayslips = Array.from(
    new Set((payslips || []).map((row) => String(row?.employee_user_id || "")).filter(Boolean))
  );
  if (!sellerIdsFromPayslips.length) return [];

  const [{ data: profiles, error: profilesErr }, { data: balances, error: balancesErr }] = await Promise.all([
    admin.from("profiles").select("user_id, full_name").in("user_id", sellerIdsFromPayslips),
    admin.from("leave_balances").select("*").in("seller_id", sellerIdsFromPayslips),
  ]);

  if (profilesErr) throw profilesErr;
  if (balancesErr) throw balancesErr;

  const profileById = new Map((profiles || []).map((p) => [String(p.user_id), p]));
  const balanceBySeller = new Map((balances || []).map((b) => [String(b.seller_id), b]));

  const latestBySeller = new Map();
  for (const row of payslips || []) {
    const sellerId = String(row?.employee_user_id || "");
    if (!sellerId || latestBySeller.has(sellerId)) continue;

    const profile = profileById.get(sellerId) || null;
    if (profile?.full_name && !employeeNameMatchesProfile(row?.employee_display_name, profile.full_name)) {
      continue;
    }

    latestBySeller.set(sellerId, row);
  }

  const rows = [];
  for (const [sellerId, payslip] of latestBySeller.entries()) {
    const profile = profileById.get(sellerId) || null;
    const current = balanceBySeller.get(sellerId) || null;
    const payslipBalance = normalizeBalance(payslip?.extracted_leave_balance);
    const suggestedAsOf = endOfMonthIso(payslip?.payroll_month);

    const currentBalance = current
      ? {
          as_of: ymd(current.as_of),
          cp_acquired_n: safeNumber(current.cp_acquired_n),
          cp_taken_n: safeNumber(current.cp_taken_n),
          cp_remaining_n: safeNumber(current.cp_remaining_n),
          cp_acquired_n1: safeNumber(current.cp_acquired_n1),
          cp_taken_n1: safeNumber(current.cp_taken_n1),
          cp_remaining_n1: safeNumber(current.cp_remaining_n1),
        }
      : null;

    const payslipTotalRemaining =
      safeNumber(payslipBalance.cp_remaining_n) + safeNumber(payslipBalance.cp_remaining_n1);
    const currentTotalRemaining = currentBalance
      ? safeNumber(currentBalance.cp_remaining_n) + safeNumber(currentBalance.cp_remaining_n1)
      : null;

    const totalRemainingDelta =
      currentTotalRemaining === null ? null : Number((payslipTotalRemaining - currentTotalRemaining).toFixed(2));

    const remainingNDelta = currentBalance
      ? Number((safeNumber(payslipBalance.cp_remaining_n) - safeNumber(currentBalance.cp_remaining_n)).toFixed(2))
      : null;
    const remainingN1Delta = currentBalance
      ? Number((safeNumber(payslipBalance.cp_remaining_n1) - safeNumber(currentBalance.cp_remaining_n1)).toFixed(2))
      : null;

    const currentAsOf = ymd(current?.as_of);
    const currentNewer = !!currentAsOf && !!suggestedAsOf && currentAsOf > suggestedAsOf;

    // Pour la page admin, on considère "déjà à jour" quand le solde visible
    // N-1 / N correspond exactement au bulletin, même si des champs techniques
    // acquis / pris sont représentés différemment.
    const visibleRemainingEqual =
      !!currentBalance &&
      currentAsOf === suggestedAsOf &&
      totalRemainingDelta === 0 &&
      remainingNDelta === 0 &&
      remainingN1Delta === 0;

    let status = "needs_update";
    if (!current) status = "missing_balance";
    if (visibleRemainingEqual) status = "up_to_date";
    if (currentNewer) status = "current_newer";

    const suspiciousThresholdDays = 10;
    const suspicious =
      status === "needs_update" &&
      totalRemainingDelta !== null &&
      Math.abs(totalRemainingDelta) >= suspiciousThresholdDays;

    rows.push({
      seller_id: sellerId,
      full_name: profile?.full_name || payslip?.employee_display_name || "Vendeuse",
      payslip_id: payslip?.id || null,
      payroll_month: ymd(payslip?.payroll_month),
      payroll_month_label: monthLabelFr(payslip?.payroll_month),
      suggested_as_of: suggestedAsOf,
      payslip_balance: {
        as_of: suggestedAsOf,
        ...payslipBalance,
      },
      current_balance: currentBalance,
      total_remaining_payslip: payslipTotalRemaining,
      total_remaining_current: currentTotalRemaining,
      total_remaining_delta: totalRemainingDelta,
      remaining_n_delta: remainingNDelta,
      remaining_n1_delta: remainingN1Delta,
      suspicious,
      suspicious_threshold_days: suspiciousThresholdDays,
      status,
      can_apply: status === "missing_balance" || status === "needs_update",
      can_apply_in_bulk:
        (status === "missing_balance" || status === "needs_update") && !suspicious,
      source_created_at: payslip?.created_at || null,
    });
  }

  rows.sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""), "fr", { sensitivity: "base" }));
  return rows;
}

async function applyRows({ admin, userId, rows, sellerIds = null }) {
  const wanted = sellerIds && sellerIds.length ? new Set(sellerIds.map(String)) : null;
  const candidates = (rows || []).filter((row) => {
    if (!row?.can_apply) return false;
    if (!wanted && row?.can_apply_in_bulk !== true) return false;
    if (wanted && !wanted.has(String(row.seller_id || ""))) return false;
    return true;
  });

  let appliedCount = 0;
  const applied = [];

  for (const row of candidates) {
    const b = row?.payslip_balance || {};
    const payload = {
      seller_id: row.seller_id,
      as_of: row.suggested_as_of,
      cp_acquired_n: safeNumber(b.cp_acquired_n),
      cp_taken_n: safeNumber(b.cp_taken_n),
      cp_remaining_n: safeNumber(b.cp_remaining_n),
      cp_acquired_n1: safeNumber(b.cp_acquired_n1),
      cp_taken_n1: safeNumber(b.cp_taken_n1),
      cp_remaining_n1: safeNumber(b.cp_remaining_n1),
      updated_at: new Date().toISOString(),
      updated_by: userId,
    };

    const { error } = await admin
      .from("leave_balances")
      .upsert(payload, { onConflict: "seller_id" });

    if (error) throw error;

    appliedCount += 1;
    applied.push({
      seller_id: row.seller_id,
      full_name: row.full_name,
      as_of: row.suggested_as_of,
      payroll_month: row.payroll_month,
    });
  }

  return { appliedCount, applied };
}

export default async function handler(req, res) {
  try {
    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    const { admin, user } = auth;

    if (req.method === "GET") {
      const rows = await buildRows(admin);
      return json(res, 200, { ok: true, rows });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const applyAll = body?.apply_all === true;
      const sellerId = String(body?.seller_id || "").trim();

      if (!applyAll && !sellerId) {
        return json(res, 400, { ok: false, error: "Missing seller_id" });
      }

      const rows = await buildRows(admin);
      const result = await applyRows({
        admin,
        userId: user.id,
        rows,
        sellerIds: applyAll ? null : [sellerId],
      });

      const refreshed = await buildRows(admin);
      return json(res, 200, {
        ok: true,
        applied_count: result.appliedCount,
        applied: result.applied,
        rows: refreshed,
      });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
