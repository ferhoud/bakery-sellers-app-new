import { createHash } from "crypto";

// lib/server/payrollEmail.js

export const DEFAULT_PAYROLL_EMAIL_SETTINGS = {
  accountant_email: "davy.azoulay@yahoo.fr",
  email_subject_template: "Éléments de paie - {month_label_title} - BM Boulangerie",
  intro_text:
    "Bonjour,\n\nJe vous prie de bien vouloir trouver ci-dessous les éléments pour l’établissement des fiches de paie du mois de {month_label} :",
  signature_text: "Cordialement\nBM Boulangerie",
};

export function normalizeLoose(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePayrollMonth(value) {
  const raw = String(value || "").trim();
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(raw);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;

  const startIso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const endIso = isoFromUtcDate(endDate);

  return {
    value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
    payroll_month: startIso,
    start_iso: startIso,
    end_iso: endIso,
    year,
    month,
    month_label: monthLabelFr(year, month),
    month_label_title: capFirst(monthLabelFr(year, month)),
  };
}

export function monthLabelFr(year, month1Based) {
  const d = new Date(Date.UTC(Number(year), Number(month1Based) - 1, 1));
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(d);
}

export function capFirst(value) {
  const s = String(value || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").slice(0, 10));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

export function isoFromUtcDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

export function addDaysIso(iso, days) {
  const d = parseIsoDate(iso);
  if (!d) return "";
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return isoFromUtcDate(d);
}

export function clipIsoRange(startIso, endIso, minIso, maxIso) {
  const start = String(startIso || "").slice(0, 10);
  const end = String(endIso || "").slice(0, 10);
  const min = String(minIso || "").slice(0, 10);
  const max = String(maxIso || "").slice(0, 10);

  if (!start || !end || !min || !max) return null;
  const clippedStart = start < min ? min : start;
  const clippedEnd = end > max ? max : end;
  if (clippedStart > clippedEnd) return null;
  return { start_iso: clippedStart, end_iso: clippedEnd };
}

// Aligné sur la logique de congés existante de l'app : lundi -> samedi, dimanche exclu.
export function daysOuvrablesInclusive(startIso, endIso) {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end || start.getTime() > end.getTime()) return 0;

  let d = new Date(start.getTime());
  let count = 0;
  while (d.getTime() <= end.getTime()) {
    if (d.getUTCDay() !== 0) count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

function daysCalendarInclusive(startIso, endIso) {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end || start.getTime() > end.getTime()) return 0;

  let d = new Date(start.getTime());
  let count = 0;
  while (d.getTime() <= end.getTime()) {
    count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

export function formatDayMonthFr(iso) {
  const d = parseIsoDate(iso);
  if (!d) return String(iso || "");
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
  }).format(d);
}

export function formatRangeFr(startIso, endIso) {
  const start = String(startIso || "").slice(0, 10);
  const end = String(endIso || "").slice(0, 10);
  if (!start || !end) return "";

  if (start === end) return `le ${formatDayMonthFr(start)}`;
  return `du ${formatDayMonthFr(start)} au ${formatDayMonthFr(end)}`;
}

export function formatFrenchList(parts) {
  const list = (parts || []).map((x) => String(x || "").trim()).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} et ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`;
}

export function groupConsecutiveIsoDates(values) {
  const dates = Array.from(
    new Set((values || []).map((x) => String(x || "").slice(0, 10)).filter(Boolean))
  ).sort();

  const groups = [];
  for (const iso of dates) {
    const last = groups[groups.length - 1];
    if (!last) {
      groups.push({ start_iso: iso, end_iso: iso, dates: [iso] });
      continue;
    }

    const nextExpected = addDaysIso(last.end_iso, 1);
    if (nextExpected === iso) {
      last.end_iso = iso;
      last.dates.push(iso);
    } else {
      groups.push({ start_iso: iso, end_iso: iso, dates: [iso] });
    }
  }

  return groups;
}

export function renderTemplate(template, values) {
  const dict = values || {};
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(dict, key) ? String(dict[key] ?? "") : `{${key}}`
  );
}

export function resolveEmployeeSeller(employee, profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const direct = String(employee?.seller_id || "").trim();
  if (direct) {
    const hit = list.find((p) => String(p?.user_id || "") === direct) || null;
    return hit || { user_id: direct, full_name: "" };
  }

  const keyword = normalizeLoose(employee?.seller_match_keyword || "");
  if (!keyword) return null;

  return (
    list.find((p) => {
      const name = normalizeLoose(p?.full_name || "");
      return name && name.includes(keyword);
    }) || null
  );
}

export function absenceDateInsideLeave(absenceIso, clippedLeaves) {
  const date = String(absenceIso || "").slice(0, 10);
  if (!date) return false;
  return (clippedLeaves || []).some((leave) => {
    const s = String(leave?.start_iso || "").slice(0, 10);
    const e = String(leave?.end_iso || "").slice(0, 10);
    return s && e && s <= date && date <= e;
  });
}

export function buildLeaveNote(clippedLeaves) {
  const leaves = Array.isArray(clippedLeaves) ? clippedLeaves : [];
  if (!leaves.length) return "";

  const totalDays = leaves.reduce(
    (sum, row) => sum + daysCalendarInclusive(row.start_iso, row.end_iso),
    0
  );

  const ranges = leaves.map((row) => formatRangeFr(row.start_iso, row.end_iso)).filter(Boolean);
  const rangeText = formatFrenchList(ranges);

  const dayWord = totalDays > 1 ? "jours" : "jour";
  const leaveWord = totalDays > 1 ? "congés" : "congé";

  if (rangeText) {
    return `a pris ${totalDays} ${dayWord} de ${leaveWord} ${rangeText}`;
  }
  return `a pris ${totalDays} ${dayWord} de ${leaveWord}`;
}

export function buildAbsenceNote(absenceDates) {
  const dates = Array.isArray(absenceDates) ? absenceDates : [];
  const groups = groupConsecutiveIsoDates(dates);
  if (!groups.length) return "";

  const pieces = groups.map((g) => formatRangeFr(g.start_iso, g.end_iso)).filter(Boolean);
  const label = dates.length > 1 ? "absences" : "absence";
  return `${label} ${formatFrenchList(pieces)}`.trim();
}

export function combineNotes(...values) {
  return values.map((x) => String(x || "").trim()).filter(Boolean).join(" ; ");
}


export function employeeIsIncludedForMonth(employee, month) {
  if (!employee || employee?.active === false) return false;

  const monthStart = String(month?.start_iso || "").slice(0, 10);
  const monthEnd = String(month?.end_iso || "").slice(0, 10);
  const startDate = String(employee?.employment_start_date || "").slice(0, 10);
  const endDate = String(employee?.employment_end_date || "").slice(0, 10);

  if (startDate && monthEnd && startDate > monthEnd) return false;
  if (endDate && monthStart && endDate < monthStart) return false;
  return true;
}

export function buildEmploymentWindowNote(employee, month) {
  const monthStart = String(month?.start_iso || "").slice(0, 10);
  const monthEnd = String(month?.end_iso || "").slice(0, 10);
  const startDate = String(employee?.employment_start_date || "").slice(0, 10);
  const endDate = String(employee?.employment_end_date || "").slice(0, 10);

  const parts = [];

  if (startDate && monthStart && monthEnd && startDate >= monthStart && startDate <= monthEnd) {
    parts.push(`début de contrat le ${formatDayMonthFr(startDate)}`);
  }

  if (endDate && monthStart && monthEnd && endDate >= monthStart && endDate <= monthEnd) {
    parts.push(`fin de contrat le ${formatDayMonthFr(endDate)}`);
  }

  return combineNotes(...parts);
}


export function easterSundayIso(yearValue) {
  const year = Number(yearValue);
  if (!Number.isFinite(year) || year < 1900 || year > 2200) return "";

  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return isoFromUtcDate(new Date(Date.UTC(year, month - 1, day)));
}

export function frenchPublicHolidaysForYear(yearValue) {
  const year = Number(yearValue);
  if (!Number.isFinite(year)) return [];

  const easter = easterSundayIso(year);
  const rows = [
    { date: `${year}-01-01`, label: "Jour de l'An" },
    { date: `${year}-05-01`, label: "Fête du Travail" },
    { date: `${year}-05-08`, label: "Victoire 1945" },
    { date: `${year}-07-14`, label: "Fête nationale" },
    { date: `${year}-08-15`, label: "Assomption" },
    { date: `${year}-11-01`, label: "Toussaint" },
    { date: `${year}-11-11`, label: "Armistice" },
    { date: `${year}-12-25`, label: "Noël" },
  ];

  if (easter) {
    rows.push(
      { date: addDaysIso(easter, 1), label: "Lundi de Pâques" },
      { date: addDaysIso(easter, 39), label: "Ascension" },
      { date: addDaysIso(easter, 50), label: "Lundi de Pentecôte" }
    );
  }

  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export function frenchPublicHolidaysForRange(startIso, endIso) {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end || start.getTime() > end.getTime()) return [];

  const years = new Set([start.getUTCFullYear(), end.getUTCFullYear()]);
  return Array.from(years)
    .flatMap((year) => frenchPublicHolidaysForYear(year))
    .filter((row) => row.date >= String(startIso).slice(0, 10) && row.date <= String(endIso).slice(0, 10))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export function formatHolidayDateFr(iso) {
  const d = parseIsoDate(iso);
  if (!d) return String(iso || "");
  const day = d.getUTCDate();
  const month = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    month: "long",
  }).format(d);
  return day === 1 ? `1er ${month}` : `${day} ${month}`;
}

export function formatPayrollMinutes(minutesValue) {
  const minutes = Math.max(0, Math.round(Number(minutesValue || 0) || 0));
  if (!minutes) return "0 min";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export function buildHolidayWorkNote(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "";

  // Important : pour le mail au comptable, on ne détaille pas les couvertures
  // liées aux retards. Le comptable a seulement besoin de savoir que la
  // vendeuse était présente / a travaillé un jour férié.
  const byDate = new Map();

  rows.forEach((row) => {
    const date = String(row?.date || "").slice(0, 10);
    if (!date) return;

    if (!byDate.has(date)) {
      byDate.set(date, {
        date,
        label: String(row?.label || "jour férié"),
      });
    }
  });

  const pieces = Array.from(byDate.values())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((row) => {
      const day = formatHolidayDateFr(row.date);
      const label = normalizeLoose(row.label || "");

      if (label.includes("ascension")) return `le ${day} (Ascension)`;
      if (label.includes("lundi de paques")) return `le ${day} (Lundi de Pâques)`;
      if (label.includes("lundi de pentecote")) return `le ${day} (Lundi de Pentecôte)`;
      return `le ${day}`;
    })
    .filter(Boolean);

  if (!pieces.length) return "";
  if (pieces.length === 1) return `a travaillé ${pieces[0]}, jour férié`;
  return `a travaillé les jours fériés suivants : ${formatFrenchList(pieces)}`;
}

export async function buildPayrollEmailPreview(admin, monthValue) {
  const month = parsePayrollMonth(monthValue);
  if (!month) {
    throw new Error("Mois de paie invalide. Format attendu : YYYY-MM.");
  }

  const { data: settingsRow, error: settingsErr } = await admin
    .from("payroll_email_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle();

  if (settingsErr) throw settingsErr;
  const settings = { ...DEFAULT_PAYROLL_EMAIL_SETTINGS, ...(settingsRow || {}) };

  const { data: employees, error: employeesErr } = await admin
    .from("payroll_email_employees")
    .select("id, full_name, base_line, seller_id, seller_match_keyword, active, sort_order, employment_start_date, employment_end_date")
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("full_name", { ascending: true });

  if (employeesErr) throw employeesErr;

  const { data: profiles, error: profilesErr } = await admin
    .from("profiles")
    .select("user_id, full_name, role, active")
    .eq("role", "seller");

  if (profilesErr) throw profilesErr;

  const { data: leaves, error: leavesErr } = await admin
    .from("leaves")
    .select("id, seller_id, start_date, end_date, status, reason")
    .eq("status", "approved")
    .lte("start_date", month.end_iso)
    .gte("end_date", month.start_iso);

  if (leavesErr) throw leavesErr;

  const { data: absences, error: absencesErr } = await admin
    .from("absences")
    .select("id, seller_id, date, status, reason")
    .eq("status", "approved")
    .gte("date", month.start_iso)
    .lte("date", month.end_iso);

  if (absencesErr) throw absencesErr;

  const publicHolidays = frenchPublicHolidaysForRange(month.start_iso, month.end_iso);
  const publicHolidayDates = publicHolidays.map((row) => row.date);
  const publicHolidayByDate = new Map(publicHolidays.map((row) => [row.date, row]));

  let holidayShiftRows = [];
  let holidayExtraWorkRows = [];

  if (publicHolidayDates.length > 0) {
    const { data: shiftRows, error: shiftErr } = await admin
      .from("shifts")
      .select("date, shift_code, seller_id")
      .in("date", publicHolidayDates);

    if (shiftErr) throw shiftErr;
    holidayShiftRows = Array.isArray(shiftRows) ? shiftRows : [];

    const { data: extraRows, error: extraErr } = await admin
      .from("extra_work_entries")
      .select("work_date, seller_id, minutes, kind, reason, notes")
      .in("work_date", publicHolidayDates);

    if (extraErr) throw extraErr;
    holidayExtraWorkRows = Array.isArray(extraRows) ? extraRows : [];
  }

  const { data: manualNotes, error: manualErr } = await admin
    .from("payroll_email_monthly_notes")
    .select("employee_id, note")
    .eq("payroll_month", month.payroll_month);

  if (manualErr) throw manualErr;

  const notesByEmployee = new Map(
    (manualNotes || []).map((row) => [String(row?.employee_id || ""), String(row?.note || "").trim()])
  );

  const leaveRows = Array.isArray(leaves) ? leaves : [];
  const absenceRows = Array.isArray(absences) ? absences : [];
  const profileRows = Array.isArray(profiles) ? profiles : [];

  const holidayWorkBySeller = new Map();
  const pushHolidayWork = (sellerIdValue, item) => {
    const sellerId = String(sellerIdValue || "").trim();
    const date = String(item?.date || "").slice(0, 10);
    if (!sellerId || !date) return;
    const holiday = publicHolidayByDate.get(date) || { date, label: "jour férié" };
    const next = {
      ...item,
      date,
      label: String(item?.label || holiday.label || "jour férié"),
    };
    const arr = holidayWorkBySeller.get(sellerId) || [];
    arr.push(next);
    holidayWorkBySeller.set(sellerId, arr);
  };

  holidayShiftRows.forEach((row) => {
    pushHolidayWork(row?.seller_id, {
      date: row?.date,
      source: "planning",
      shift_code: row?.shift_code || "",
    });
  });

  holidayExtraWorkRows.forEach((row) => {
    const minutes = Math.round(Number(row?.minutes || 0) || 0);
    if (minutes <= 0) return;
    pushHolidayWork(row?.seller_id, {
      date: row?.work_date,
      source: "extra_work",
      minutes,
      kind: row?.kind || "",
      reason: row?.reason || "",
      notes: row?.notes || "",
    });
  });

  const monthlyEmployees = (employees || []).filter((employee) =>
    employeeIsIncludedForMonth(employee, month)
  );

  const enrichedEmployees = monthlyEmployees.map((employee) => {
    const seller = resolveEmployeeSeller(employee, profileRows);
    const sellerId = String(seller?.user_id || "").trim();

    const clippedLeaves = leaveRows
      .filter((row) => String(row?.seller_id || "") === sellerId)
      .map((row) => clipIsoRange(row.start_date, row.end_date, month.start_iso, month.end_iso))
      .filter(Boolean);

    const rawAbsenceDates = absenceRows
      .filter((row) => String(row?.seller_id || "") === sellerId)
      .map((row) => String(row?.date || "").slice(0, 10))
      .filter(Boolean);

    const absenceDates = rawAbsenceDates.filter(
      (date) => !absenceDateInsideLeave(date, clippedLeaves)
    );

    const employmentNote = buildEmploymentWindowNote(employee, month);
    const leaveNote = buildLeaveNote(clippedLeaves);
    const absenceNote = buildAbsenceNote(absenceDates);
    const holidayWorkNote = buildHolidayWorkNote(holidayWorkBySeller.get(sellerId) || []);
    const automaticNote = combineNotes(employmentNote, leaveNote, absenceNote, holidayWorkNote);
    const manualNote = notesByEmployee.get(String(employee?.id || "")) || "";
    const finalNote = combineNotes(automaticNote, manualNote);

    const baseLine = String(employee?.base_line || "").trim();
    const fullName = String(employee?.full_name || "").trim();

    return {
      ...employee,
      seller_resolved_id: sellerId || null,
      seller_resolved_name: String(seller?.full_name || "").trim() || null,
      automatic_note: automaticNote,
      holiday_work_note: holidayWorkNote,
      manual_note: manualNote,
      final_note: finalNote,
      line: `- ${fullName} : ${baseLine}${finalNote ? ` (${finalNote})` : ""}`,
    };
  });

  const templateValues = {
    month_label: month.month_label,
    month_label_title: month.month_label_title,
  };

  const subject = renderTemplate(settings.email_subject_template, templateValues).trim();
  const intro = renderTemplate(settings.intro_text, templateValues).trim();
  const signature = String(settings.signature_text || "").trim();

  const body = [
    intro,
    "",
    ...enrichedEmployees.flatMap((employee) => [employee.line, ""]),
    signature,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const linkedCount = enrichedEmployees.filter((x) => x.seller_resolved_id).length;
  const autoNoteCount = enrichedEmployees.filter((x) => x.automatic_note).length;
  const manualNoteCount = enrichedEmployees.filter((x) => x.manual_note).length;
  const holidayWorkNoteCount = enrichedEmployees.filter((x) => x.holiday_work_note).length;

  return {
    month,
    settings: {
      accountant_email: String(settings.accountant_email || DEFAULT_PAYROLL_EMAIL_SETTINGS.accountant_email),
      email_subject_template: String(settings.email_subject_template || DEFAULT_PAYROLL_EMAIL_SETTINGS.email_subject_template),
      intro_text: String(settings.intro_text || DEFAULT_PAYROLL_EMAIL_SETTINGS.intro_text),
      signature_text: String(settings.signature_text || DEFAULT_PAYROLL_EMAIL_SETTINGS.signature_text),
    },
    to_email: String(settings.accountant_email || DEFAULT_PAYROLL_EMAIL_SETTINGS.accountant_email),
    subject,
    body,
    employees: enrichedEmployees,
    summary: {
      employees_count: enrichedEmployees.length,
      linked_employees_count: linkedCount,
      employees_with_auto_notes_count: autoNoteCount,
      employees_with_manual_notes_count: manualNoteCount,
      approved_leaves_count: leaveRows.length,
      approved_absences_count: absenceRows.length,
      public_holidays_count: publicHolidays.length,
      holiday_shift_rows_count: holidayShiftRows.length,
      holiday_extra_work_rows_count: holidayExtraWorkRows.length,
      employees_with_holiday_work_note_count: holidayWorkNoteCount,
    },
  };
}

export function payrollEmailFingerprint({ to_email, subject, body }) {
  const raw = [
    String(to_email || "").trim(),
    String(subject || "").trim(),
    String(body || "").trim(),
  ].join("\n---\n");

  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function safeJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function refreshPayrollEmailRecord(admin, monthValue, { source = "manual" } = {}) {
  const preview = await buildPayrollEmailPreview(admin, monthValue);
  const now = new Date().toISOString();
  const autoFingerprint = payrollEmailFingerprint({
    to_email: preview.to_email,
    subject: preview.subject,
    body: preview.body,
  });

  const { data: existing, error: existingErr } = await admin
    .from("payroll_email_drafts")
    .select("*")
    .eq("payroll_month", preview.month.payroll_month)
    .maybeSingle();

  if (existingErr) throw existingErr;

  const alreadySent = !!existing?.sent_at;
  const previousFingerprint = String(existing?.auto_fingerprint || "");
  const changed = previousFingerprint !== autoFingerprint;
  const created = !existing;

  const payload = {
    payroll_month: preview.month.payroll_month,
    to_email: String(existing?.to_email || preview.to_email || "").trim(),
    subject: String(existing?.subject || preview.subject || "").trim(),
    body: String(existing?.body || preview.body || "").trim(),
    auto_to_email: String(preview.to_email || "").trim(),
    auto_subject: String(preview.subject || "").trim(),
    auto_body: String(preview.body || "").trim(),
    auto_fingerprint: autoFingerprint,
    last_auto_refresh_at: now,
    last_auto_change_at: changed ? now : existing?.last_auto_change_at || now,
    needs_review: alreadySent ? false : changed ? true : !!existing?.needs_review,
    status: alreadySent ? "sent" : changed ? "needs_review" : existing?.status || "auto_ready",
    generated_snapshot: {
      ...safeJsonObject(existing?.generated_snapshot),
      summary: preview.summary || {},
      last_auto_refresh_at: now,
      source: String(source || "manual"),
      auto_fingerprint: autoFingerprint,
    },
    updated_at: now,
  };

  if (!existing) {
    payload.to_email = String(preview.to_email || "").trim();
    payload.subject = String(preview.subject || "").trim();
    payload.body = String(preview.body || "").trim();
    payload.needs_review = true;
    payload.status = "needs_review";
  }

  const { data: row, error: upsertErr } = await admin
    .from("payroll_email_drafts")
    .upsert(payload, { onConflict: "payroll_month" })
    .select("*")
    .single();

  if (upsertErr) throw upsertErr;

  return {
    ok: true,
    created,
    changed,
    row,
    preview,
  };
}
