export const SHIFT_HOURS = {
  MORNING: 7,
  MIDDAY: 7,
  EVENING: 7,
  SUNDAY_EXTRA: 4.5,
};

export const DEFAULT_HOURLY_RATE = 10;
export const DEFAULT_PAID_LEAVE_HOURS_PER_DAY = 7;

export function parsePayrollMonth(value) {
  const raw = String(value || "").trim().slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;

  const start = `${m[1]}-${m[2]}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, "0")}-${String(endDate.getUTCDate()).padStart(2, "0")}`;

  return {
    value: raw,
    payroll_month: start,
    start_iso: start,
    end_iso: end,
  };
}

export function round2(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function hoursFromMinutes(minutes) {
  return round2((Number(minutes || 0) || 0) / 60);
}

export function normalizeLoose(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isoToUtcDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").slice(0, 10));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function calendarDaysInclusive(startIso, endIso) {
  const start = isoToUtcDate(startIso);
  const end = isoToUtcDate(endIso);
  if (!start || !end || start.getTime() > end.getTime()) return 0;

  let count = 0;
  const d = new Date(start.getTime());
  while (d.getTime() <= end.getTime()) {
    count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

function clipIsoRange(startIso, endIso, minIso, maxIso) {
  const start = String(startIso || "").slice(0, 10);
  const end = String(endIso || "").slice(0, 10);
  const min = String(minIso || "").slice(0, 10);
  const max = String(maxIso || "").slice(0, 10);
  if (!start || !end || !min || !max) return null;

  const s = start < min ? min : start;
  const e = end > max ? max : end;
  if (s > e) return null;
  return { start_iso: s, end_iso: e };
}

function isUnpaidLeave(row) {
  const hay = normalizeLoose(`${row?.reason || ""} ${row?.notes || ""}`);
  return hay.includes("sans solde") || hay.includes("non paye") || hay.includes("non-pay");
}

function firstValue(row, keys) {
  for (const key of keys) {
    const v = row?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function rowSellerId(row) {
  return String(firstValue(row, ["seller_id", "user_id", "id", "profile_id", "uid"]) || "").trim();
}

function rowFullName(row) {
  return String(firstValue(row, ["full_name", "name", "seller_name", "display_name"]) || "").trim();
}

function rowActive(row) {
  if (row?.active === false) return false;
  if (row?.is_active === false) return false;
  return true;
}

function addSeller(map, sellerIdValue, fullNameValue = "", options = {}) {
  const sellerId = String(sellerIdValue || "").trim();
  if (!sellerId) return;

  const fullName = String(fullNameValue || "").trim();
  const current = map.get(sellerId);

  if (!current) {
    map.set(sellerId, {
      seller_id: sellerId,
      full_name: fullName || sellerId,
      active: options.active !== false,
      has_month_activity: !!options.hasMonthActivity,
    });
    return;
  }

  map.set(sellerId, {
    ...current,
    full_name:
      fullName && (!current.full_name || current.full_name === current.seller_id)
        ? fullName
        : current.full_name || fullName || sellerId,
    active: current.active !== false || options.active !== false,
    has_month_activity: current.has_month_activity || !!options.hasMonthActivity,
  });
}

function addNumber(map, sellerIdValue, value) {
  const sellerId = String(sellerIdValue || "").trim();
  if (!sellerId) return;
  const n = Number(value || 0) || 0;
  map.set(sellerId, round2((map.get(sellerId) || 0) + n));
}

function addMinutes(map, sellerIdValue, value) {
  const sellerId = String(sellerIdValue || "").trim();
  if (!sellerId) return;
  const n = Math.round(Number(value || 0) || 0);
  map.set(sellerId, (map.get(sellerId) || 0) + n);
}

async function maybeSelect(service, table, select, configure = null) {
  try {
    let q = service.from(table).select(select);
    if (typeof configure === "function") q = configure(q);
    const { data, error } = await q;
    if (error) return { data: [], error };
    return { data: Array.isArray(data) ? data : [], error: null };
  } catch (e) {
    return { data: [], error: e };
  }
}

async function maybeRpc(service, name, args = {}) {
  try {
    const { data, error } = await service.rpc(name, args);
    if (error) return { data: [], error };
    return { data: Array.isArray(data) ? data : data ? [data] : [], error: null };
  } catch (e) {
    return { data: [], error: e };
  }
}

function serviceOrThrow(service) {
  if (!service || typeof service.from !== "function") {
    throw new Error("Client Supabase admin invalide pour le calcul des compléments paie.");
  }
  return service;
}

export async function loadPayrollAdjustmentPreview(serviceInput, monthValue) {
  const service = serviceOrThrow(serviceInput);
  const month = parsePayrollMonth(monthValue);
  if (!month) throw new Error("Mois invalide. Format attendu : YYYY-MM.");

  const settingsResult = await maybeSelect(service, "payroll_adjustment_settings", "*");
  if (settingsResult.error) throw settingsResult.error;

  const monthlyResult = await maybeSelect(service, "payroll_adjustment_monthly", "*", (q) =>
    q.eq("payroll_month", month.payroll_month)
  );
  if (monthlyResult.error) throw monthlyResult.error;

  const [
    listSellersRpc,
    activeNamesRpc,
    sellersResult,
    profilesResult,
    shiftsResult,
    extraResult,
    checkinsResult,
    leavesResult,
    attestationsResult,
    hoursRpc,
  ] = await Promise.all([
    maybeRpc(service, "list_sellers"),
    maybeRpc(service, "list_active_seller_names"),
    maybeSelect(service, "sellers", "id, full_name, is_active"),
    maybeSelect(service, "profiles", "user_id, full_name, role, active"),
    maybeSelect(service, "shifts", "date, shift_code, seller_id", (q) =>
      q.gte("date", month.start_iso).lte("date", month.end_iso)
    ),
    maybeSelect(service, "extra_work_entries", "work_date, seller_id, minutes, kind, reason, notes", (q) =>
      q.gte("work_date", month.start_iso).lte("work_date", month.end_iso)
    ),
    maybeSelect(service, "daily_checkins", "day, seller_id, early_minutes, late_minutes, confirmed_at", (q) =>
      q.gte("day", month.start_iso).lte("day", month.end_iso).not("confirmed_at", "is", null)
    ),
    maybeSelect(service, "leaves", "id, seller_id, start_date, end_date, status, reason", (q) =>
      q.eq("status", "approved").lte("start_date", month.end_iso).gte("end_date", month.start_iso)
    ),
    maybeSelect(service, "monthly_hours_attestations", "seller_id, month_start, computed_hours, final_hours", (q) =>
      q.eq("month_start", month.payroll_month)
    ),
    maybeRpc(service, "admin_hours_by_range", {
      p_from: month.start_iso,
      p_to: month.end_iso,
    }),
  ]);

  const sellerMap = new Map();

  (listSellersRpc.data || []).forEach((row) => {
    addSeller(sellerMap, rowSellerId(row), rowFullName(row), { active: rowActive(row) });
  });

  (activeNamesRpc.data || []).forEach((row) => {
    addSeller(sellerMap, rowSellerId(row), rowFullName(row), { active: true });
  });

  (sellersResult.data || []).forEach((row) => {
    addSeller(sellerMap, rowSellerId(row), rowFullName(row), { active: rowActive(row) });
  });

  (profilesResult.data || []).forEach((row) => {
    const role = normalizeLoose(row?.role || "");
    if (role === "seller") {
      addSeller(sellerMap, rowSellerId(row), rowFullName(row), { active: rowActive(row) });
    }
  });

  const settingsBySeller = new Map(
    (settingsResult.data || []).map((row) => [String(row?.seller_id || ""), row])
  );
  const monthlyBySeller = new Map(
    (monthlyResult.data || []).map((row) => [String(row?.seller_id || ""), row])
  );

  const planningHoursBySeller = new Map();

  (hoursRpc.data || []).forEach((row) => {
    const sellerId = rowSellerId(row);
    const fullName = rowFullName(row);
    const hours =
      Number(firstValue(row, ["total_hours", "hours", "computed_hours", "final_hours", "sum_hours", "total"]) || 0) ||
      0;

    if (!sellerId) return;
    addSeller(sellerMap, sellerId, fullName, { active: true, hasMonthActivity: true });
    if (hours) addNumber(planningHoursBySeller, sellerId, hours);
  });

  if (planningHoursBySeller.size === 0) {
    (shiftsResult.data || []).forEach((row) => {
      const sellerId = String(row?.seller_id || "").trim();
      if (!sellerId) return;

      const code = String(row?.shift_code || "").toUpperCase();
      const hours = Number(SHIFT_HOURS[code] || 0) || 0;

      addSeller(sellerMap, sellerId, "", { active: true, hasMonthActivity: true });
      addNumber(planningHoursBySeller, sellerId, hours);
    });
  }

  (attestationsResult.data || []).forEach((row) => {
    const sellerId = String(row?.seller_id || "").trim();
    if (!sellerId) return;

    addSeller(sellerMap, sellerId, "", { active: true, hasMonthActivity: true });

    if (!planningHoursBySeller.has(sellerId) || !Number(planningHoursBySeller.get(sellerId) || 0)) {
      const h = Number(row?.final_hours ?? row?.computed_hours ?? 0) || 0;
      if (h) planningHoursBySeller.set(sellerId, round2(h));
    }
  });

  (settingsResult.data || []).forEach((row) => {
    addSeller(sellerMap, row?.seller_id, "", { active: true, hasMonthActivity: true });
  });

  (monthlyResult.data || []).forEach((row) => {
    addSeller(sellerMap, row?.seller_id, "", { active: true, hasMonthActivity: true });
  });

  const extraNetMinutesBySeller = new Map();
  const extraPositiveMinutesBySeller = new Map();
  const extraNegativeMinutesBySeller = new Map();

  (extraResult.data || []).forEach((row) => {
    const sellerId = String(row?.seller_id || "").trim();
    if (!sellerId) return;

    const minutes = Math.round(Number(row?.minutes || 0) || 0);

    addSeller(sellerMap, sellerId, "", { active: true, hasMonthActivity: true });
    addMinutes(extraNetMinutesBySeller, sellerId, minutes);

    if (minutes >= 0) addMinutes(extraPositiveMinutesBySeller, sellerId, minutes);
    else addMinutes(extraNegativeMinutesBySeller, sellerId, Math.abs(minutes));
  });

  const checkinNetMinutesBySeller = new Map();
  const checkinEarlyMinutesBySeller = new Map();
  const checkinLateMinutesBySeller = new Map();

  (checkinsResult.data || []).forEach((row) => {
    const sellerId = String(row?.seller_id || "").trim();
    if (!sellerId) return;

    const early = Math.max(0, Math.round(Number(row?.early_minutes || 0) || 0));
    const late = Math.max(0, Math.round(Number(row?.late_minutes || 0) || 0));

    addSeller(sellerMap, sellerId, "", { active: true, hasMonthActivity: true });
    addMinutes(checkinEarlyMinutesBySeller, sellerId, early);
    addMinutes(checkinLateMinutesBySeller, sellerId, late);
    addMinutes(checkinNetMinutesBySeller, sellerId, early - late);
  });

  const leaveDaysBySeller = new Map();

  (leavesResult.data || []).forEach((row) => {
    const sellerId = String(row?.seller_id || "").trim();
    if (!sellerId || isUnpaidLeave(row)) return;

    const clipped = clipIsoRange(row?.start_date, row?.end_date, month.start_iso, month.end_iso);
    if (!clipped) return;

    addSeller(sellerMap, sellerId, "", { active: true, hasMonthActivity: true });
    addNumber(leaveDaysBySeller, sellerId, calendarDaysInclusive(clipped.start_iso, clipped.end_iso));
  });

  const rows = Array.from(sellerMap.values())
    .filter((seller) => seller.active !== false || seller.has_month_activity)
    .map((seller) => {
      const sellerId = seller.seller_id;
      const setting = settingsBySeller.get(sellerId) || {};
      const saved = monthlyBySeller.get(sellerId) || {};

      const planningHours = round2(planningHoursBySeller.get(sellerId) || 0);
      const extraNetMinutes = Math.round(extraNetMinutesBySeller.get(sellerId) || 0);
      const extraPositiveMinutes = Math.round(extraPositiveMinutesBySeller.get(sellerId) || 0);
      const extraNegativeMinutes = Math.round(extraNegativeMinutesBySeller.get(sellerId) || 0);
      const checkinNetMinutes = Math.round(checkinNetMinutesBySeller.get(sellerId) || 0);
      const checkinEarlyMinutes = Math.round(checkinEarlyMinutesBySeller.get(sellerId) || 0);
      const checkinLateMinutes = Math.round(checkinLateMinutesBySeller.get(sellerId) || 0);

      const appWorkedHours = round2(planningHours + hoursFromMinutes(extraNetMinutes + checkinNetMinutes));

      const autoPaidLeaveDays = round2(leaveDaysBySeller.get(sellerId) || 0);
      const paidLeaveDays =
        saved?.paid_leave_days_override != null ? round2(saved.paid_leave_days_override) : autoPaidLeaveDays;

      const paidLeaveHoursPerDay = round2(
        saved?.paid_leave_hours_per_day ??
          setting?.paid_leave_hours_per_day ??
          DEFAULT_PAID_LEAVE_HOURS_PER_DAY
      );

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

        status: String(saved?.status || "to_check"),
        note: String(saved?.note || ""),
        paid_at: saved?.paid_at || null,
        saved_id: saved?.id || null,
      };
    })
    .sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""), "fr"));

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
    debug_counts: {
      list_sellers_rpc: listSellersRpc.data.length,
      list_active_seller_names_rpc: activeNamesRpc.data.length,
      sellers_table: sellersResult.data.length,
      profiles_table: profilesResult.data.length,
      shifts_rows: shiftsResult.data.length,
      extra_work_rows: extraResult.data.length,
      checkins_rows: checkinsResult.data.length,
      leaves_rows: leavesResult.data.length,
      attestations_rows: attestationsResult.data.length,
      admin_hours_rpc_rows: hoursRpc.data.length,
    },
  };
}
