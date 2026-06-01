import { requireAdmin } from "@/lib/server/adminApi";
import { parsePayrollMonth, round2 } from "@/lib/server/payrollAdjustments";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function bodyObject(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch (_) { return {}; }
  }
  return req.body || {};
}

function nullableNumber(value) {
  if (value === "" || value == null) return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? round2(n) : null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Méthode non autorisée" });
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const body = bodyObject(req);
    const month = parsePayrollMonth(body?.month || body?.payroll_month || "");
    const sellerId = String(body?.seller_id || "").trim();
    if (!month) return json(res, 400, { ok: false, error: "Mois invalide" });
    if (!sellerId) return json(res, 400, { ok: false, error: "Vendeuse manquante" });

    const payslipHours = nullableNumber(body?.payslip_hours);
    const hourlyRate = nullableNumber(body?.hourly_rate);
    const paidLeaveDaysOverride = nullableNumber(body?.paid_leave_days_override);
    const paidLeaveHoursPerDay = nullableNumber(body?.paid_leave_hours_per_day);
    const status = String(body?.status || "to_check").trim();
    const note = String(body?.note || "").trim();
    if (!["to_check", "validated", "paid"].includes(status)) return json(res, 400, { ok: false, error: "Statut invalide" });

    const now = new Date().toISOString();
    const { data: monthly, error: monthlyErr } = await admin.service
      .from("payroll_adjustment_monthly")
      .upsert({
        payroll_month: month.payroll_month,
        seller_id: sellerId,
        payslip_hours: payslipHours,
        hourly_rate: hourlyRate,
        paid_leave_days_override: paidLeaveDaysOverride,
        paid_leave_hours_per_day: paidLeaveHoursPerDay,
        status,
        note: note || null,
        paid_at: status === "paid" ? now : null,
        updated_at: now,
      }, { onConflict: "payroll_month,seller_id" })
      .select("*")
      .single();
    if (monthlyErr) throw monthlyErr;

    const { error: settingErr } = await admin.service
      .from("payroll_adjustment_settings")
      .upsert({
        seller_id: sellerId,
        hourly_rate: hourlyRate,
        default_payslip_hours: payslipHours,
        paid_leave_hours_per_day: paidLeaveHoursPerDay,
        updated_at: now,
      }, { onConflict: "seller_id" });
    if (settingErr) throw settingErr;

    return json(res, 200, { ok: true, row: monthly });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Erreur serveur" });
  }
}
