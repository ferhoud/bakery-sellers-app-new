export const SHIFT_HOURS = { MORNING: 7, MIDDAY: 7, EVENING: 7, SUNDAY_EXTRA: 4.5 };
export const DEFAULT_HOURLY_RATE = 10;
export const DEFAULT_PAID_LEAVE_HOURS_PER_DAY = 7;

export function parsePayrollMonth(value) {
  const raw = String(value || '').trim().slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  const start = `${m[1]}-${m[2]}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth()+1).padStart(2,'0')}-${String(endDate.getUTCDate()).padStart(2,'0')}`;
  return { value: raw, payroll_month: start, start_iso: start, end_iso: end };
}

export function isoToUtcDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').slice(0, 10));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2])-1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function clipIsoRange(startIso, endIso, minIso, maxIso) {
  const start = String(startIso || '').slice(0,10);
  const end = String(endIso || '').slice(0,10);
  const min = String(minIso || '').slice(0,10);
  const max = String(maxIso || '').slice(0,10);
  if (!start || !end || !min || !max) return null;
  const s = start < min ? min : start;
  const e = end > max ? max : end;
  return s <= e ? { start_iso: s, end_iso: e } : null;
}

export function calendarDaysInclusive(startIso, endIso) {
  const start = isoToUtcDate(startIso);
  const end = isoToUtcDate(endIso);
  if (!start || !end || start.getTime() > end.getTime()) return 0;
  const d = new Date(start.getTime());
  let count = 0;
  while (d.getTime() <= end.getTime()) {
    count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

export function normalizeLoose(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function isUnpaidLeave(row) {
  const hay = normalizeLoose(`${row?.reason || ''} ${row?.notes || ''}`);
  return hay.includes('sans solde') || hay.includes('non paye') || hay.includes('non-pay');
}

export function round2(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function hoursFromMinutes(minutes) {
  return round2((Number(minutes || 0) || 0) / 60);
}

function addSeller(map, id, name, active = true) {
  const sellerId = String(id || '').trim();
  if (!sellerId || active === false) return;
  const current = map.get(sellerId) || {};
  map.set(sellerId, {
    seller_id: sellerId,
    full_name: String(name || current.full_name || '').trim() || sellerId,
    active: true,
  });
}

export async function loadPayrollAdjustmentPreview(service, monthValue) {
  const month = parsePayrollMonth(monthValue);
  if (!month) throw new Error('Mois invalide. Format attendu : YYYY-MM.');

  const [sellersResult, profilesResult, settingsResult, monthlyResult, shiftsResult, extraResult, checkinsResult, leavesResult] = await Promise.all([
    service.from('sellers').select('id, full_name, active').order('full_name', { ascending: true }),
    service.from('profiles').select('user_id, full_name, role, active').eq('role', 'seller'),
    service.from('payroll_adjustment_settings').select('*'),
    service.from('payroll_adjustment_monthly').select('*').eq('payroll_month', month.payroll_month),
    service.from('shifts').select('date, shift_code, seller_id').gte('date', month.start_iso).lte('date', month.end_iso),
    service.from('extra_work_entries').select('work_date, seller_id, minutes, kind, reason, notes').gte('work_date', month.start_iso).lte('work_date', month.end_iso),
    service.from('daily_checkins').select('day, seller_id, early_minutes, late_minutes, confirmed_at').gte('day', month.start_iso).lte('day', month.end_iso).not('confirmed_at', 'is', null),
    service.from('leaves').select('id, seller_id, start_date, end_date, status, reason').eq('status', 'approved').lte('start_date', month.end_iso).gte('end_date', month.start_iso),
  ]);

  for (const r of [sellersResult, profilesResult, settingsResult, monthlyResult, shiftsResult, extraResult, checkinsResult, leavesResult]) {
    if (r.error) throw r.error;
  }

  const sellerById = new Map();
  (profilesResult.data || []).forEach((p) => addSeller(sellerById, p?.user_id, p?.full_name, p?.active !== false));
  (sellersResult.data || []).forEach((s) => addSeller(sellerById, s?.id, s?.full_name, s?.active !== false));

  const settingsBySeller = new Map((settingsResult.data || []).map((row) => [String(row?.seller_id || ''), row]));
  const monthlyBySeller = new Map((monthlyResult.data || []).map((row) => [String(row?.seller_id || ''), row]));

  const planningHoursBySeller = new Map();
  (shiftsResult.data || []).forEach((row) => {
    const sellerId = String(row?.seller_id || '').trim();
    if (!sellerId) return;
    const h = Number(SHIFT_HOURS[String(row?.shift_code || '').toUpperCase()] || 0) || 0;
    planningHoursBySeller.set(sellerId, round2((planningHoursBySeller.get(sellerId) || 0) + h));
    if (!sellerById.has(sellerId)) addSeller(sellerById, sellerId, sellerId, true);
  });

  const extraMinutesBySeller = new Map();
  const extraPositiveMinutesBySeller = new Map();
  const extraNegativeMinutesBySeller = new Map();
  (extraResult.data || []).forEach((row) => {
    const sellerId = String(row?.seller_id || '').trim();
    if (!sellerId) return;
    const minutes = Math.round(Number(row?.minutes || 0) || 0);
    extraMinutesBySeller.set(sellerId, (extraMinutesBySeller.get(sellerId) || 0) + minutes);
    if (minutes >= 0) extraPositiveMinutesBySeller.set(sellerId, (extraPositiveMinutesBySeller.get(sellerId) || 0) + minutes);
    else extraNegativeMinutesBySeller.set(sellerId, (extraNegativeMinutesBySeller.get(sellerId) || 0) + Math.abs(minutes));
    if (!sellerById.has(sellerId)) addSeller(sellerById, sellerId, sellerId, true);
  });

  const checkinNetMinutesBySeller = new Map();
  const checkinEarlyMinutesBySeller = new Map();
  const checkinLateMinutesBySeller = new Map();
  (checkinsResult.data || []).forEach((row) => {
    const sellerId = String(row?.seller_id || '').trim();
    if (!sellerId) return;
    const early = Math.max(0, Math.round(Number(row?.early_minutes || 0) || 0));
    const late = Math.max(0, Math.round(Number(row?.late_minutes || 0) || 0));
    checkinEarlyMinutesBySeller.set(sellerId, (checkinEarlyMinutesBySeller.get(sellerId) || 0) + early);
    checkinLateMinutesBySeller.set(sellerId, (checkinLateMinutesBySeller.get(sellerId) || 0) + late);
    checkinNetMinutesBySeller.set(sellerId, (checkinNetMinutesBySeller.get(sellerId) || 0) + early - late);
  });

  const leaveDaysBySeller = new Map();
  (leavesResult.data || []).forEach((row) => {
    const sellerId = String(row?.seller_id || '').trim();
    if (!sellerId || isUnpaidLeave(row)) return;
    const clipped = clipIsoRange(row?.start_date, row?.end_date, month.start_iso, month.end_iso);
    if (!clipped) return;
    const days = calendarDaysInclusive(clipped.start_iso, clipped.end_iso);
    leaveDaysBySeller.set(sellerId, round2((leaveDaysBySeller.get(sellerId) || 0) + days));
  });

  const rows = Array.from(sellerById.values()).map((seller) => {
    const sellerId = String(seller.seller_id || '');
    const setting = settingsBySeller.get(sellerId) || {};
    const saved = monthlyBySeller.get(sellerId) || {};

    const planningHours = round2(planningHoursBySeller.get(sellerId) || 0);
    const extraNetMinutes = Math.round(extraMinutesBySeller.get(sellerId) || 0);
    const extraPositiveMinutes = Math.round(extraPositiveMinutesBySeller.get(sellerId) || 0);
    const extraNegativeMinutes = Math.round(extraNegativeMinutesBySeller.get(sellerId) || 0);
    const checkinNetMinutes = Math.round(checkinNetMinutesBySeller.get(sellerId) || 0);
    const checkinEarlyMinutes = Math.round(checkinEarlyMinutesBySeller.get(sellerId) || 0);
    const checkinLateMinutes = Math.round(checkinLateMinutesBySeller.get(sellerId) || 0);
    const appWorkedHours = round2(planningHours + hoursFromMinutes(extraNetMinutes + checkinNetMinutes));

    const autoPaidLeaveDays = round2(leaveDaysBySeller.get(sellerId) || 0);
    const paidLeaveDays = saved?.paid_leave_days_override != null ? round2(saved.paid_leave_days_override) : autoPaidLeaveDays;
    const paidLeaveHoursPerDay = round2(saved?.paid_leave_hours_per_day ?? setting?.paid_leave_hours_per_day ?? DEFAULT_PAID_LEAVE_HOURS_PER_DAY);
    const paidLeaveHours = round2(paidLeaveDays * paidLeaveHoursPerDay);
    const totalDueHours = round2(appWorkedHours + paidLeaveHours);
    const payslipHours = round2(saved?.payslip_hours ?? setting?.default_payslip_hours ?? 0);
    const hourlyRate = round2(saved?.hourly_rate ?? setting?.hourly_rate ?? DEFAULT_HOURLY_RATE);
    const hoursDifference = round2(totalDueHours - payslipHours);
    const complementHours = round2(Math.max(0, hoursDifference));
    const complementAmount = round2(complementHours * hourlyRate);

    return {
      seller_id: sellerId,
      full_name: seller.full_name || sellerId,
      planning_hours: planningHours,
      extra_net_minutes: extraNetMinutes,
      extra_positive_minutes: extraPositiveMinutes,
      extra_negative_minutes: extraNegativeMinutes,
      checkin_net_minutes: checkinNetMinutes,
      checkin_early_minutes: checkinEarlyMinutes,
      checkin_late_minutes: checkinLateMinutes,
      app_worked_hours: appWorkedHours,
      auto_paid_leave_days: autoPaidLeaveDays,
      paid_leave_days: paidLeaveDays,
      paid_leave_days_override: saved?.paid_leave_days_override ?? null,
      paid_leave_hours_per_day: paidLeaveHoursPerDay,
      paid_leave_hours: paidLeaveHours,
      total_due_hours: totalDueHours,
      payslip_hours: payslipHours,
      hourly_rate: hourlyRate,
      hours_difference: hoursDifference,
      complement_hours: complementHours,
      complement_amount: complementAmount,
      status: String(saved?.status || 'to_check'),
      note: String(saved?.note || ''),
      paid_at: saved?.paid_at || null,
      saved_id: saved?.id || null,
    };
  }).sort((a,b) => String(a.full_name || '').localeCompare(String(b.full_name || ''), 'fr'));

  return {
    ok: true,
    month,
    rows,
    summary: {
      sellers_count: rows.length,
      total_app_worked_hours: round2(rows.reduce((sum, r) => sum + (Number(r.app_worked_hours) || 0), 0)),
      total_paid_leave_hours: round2(rows.reduce((sum, r) => sum + (Number(r.paid_leave_hours) || 0), 0)),
      total_due_hours: round2(rows.reduce((sum, r) => sum + (Number(r.total_due_hours) || 0), 0)),
      total_payslip_hours: round2(rows.reduce((sum, r) => sum + (Number(r.payslip_hours) || 0), 0)),
      total_complement_hours: round2(rows.reduce((sum, r) => sum + (Number(r.complement_hours) || 0), 0)),
      total_complement_amount: round2(rows.reduce((sum, r) => sum + (Number(r.complement_amount) || 0), 0)),
    },
  };
}
