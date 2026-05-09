import { supabase } from "@/lib/supabaseClient";

export const SHIFT_TYPE_CODES = ["MORNING", "MIDDAY", "EVENING", "SUNDAY_EXTRA"];

export const DEFAULT_SHIFT_TYPE_MAP = {
  MORNING: {
    shift_code: "MORNING",
    base_name: "Matin",
    start_time: "06:30:00",
    end_time: "13:30:00",
    effective_from: "2000-01-01",
    active: true,
  },
  MIDDAY: {
    shift_code: "MIDDAY",
    base_name: "Midi",
    start_time: "06:30:00",
    end_time: "13:30:00",
    effective_from: "2000-01-01",
    active: true,
  },
  EVENING: {
    shift_code: "EVENING",
    base_name: "Soir",
    start_time: "13:30:00",
    end_time: "20:30:00",
    effective_from: "2000-01-01",
    active: true,
  },
  SUNDAY_EXTRA: {
    shift_code: "SUNDAY_EXTRA",
    base_name: "Dimanche",
    start_time: "09:00:00",
    end_time: "13:30:00",
    effective_from: "2000-01-01",
    active: true,
  },
};

export function normalizeTimeHHMMSS(value) {
  const s = String(value || "").trim();
  if (!s) return "00:00:00";
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [hh, mm] = s.split(":");
    return `${String(hh).padStart(2, "0")}:${mm}:00`;
  }
  return s;
}

export function hhmm(value) {
  const s = normalizeTimeHHMMSS(value);
  return s.slice(0, 5);
}

export function parseMinutes(value) {
  const s = hhmm(value);
  const [hh, mm] = s.split(":").map((v) => Number(v || 0));
  return (hh * 60) + mm;
}

export function formatRange(startTime, endTime) {
  const fmt = (t) => {
    const [hh, mm] = hhmm(t).split(":");
    const h = String(Number(hh || 0));
    return Number(mm || 0) === 0 ? `${h}h` : `${h}h${mm}`;
  };
  return `${fmt(startTime)}-${fmt(endTime)}`;
}

export function computeDurationHours(startTime, endTime) {
  const start = parseMinutes(startTime);
  const end = parseMinutes(endTime);
  let delta = end - start;
  if (delta < 0) delta += 24 * 60;
  return Math.round((delta / 60) * 100) / 100;
}

export function formatShiftDisplayLabel(code, cfg) {
  const base = (cfg?.base_name || DEFAULT_SHIFT_TYPE_MAP[code]?.base_name || code || "").trim();
  const start = cfg?.start_time || DEFAULT_SHIFT_TYPE_MAP[code]?.start_time;
  const end = cfg?.end_time || DEFAULT_SHIFT_TYPE_MAP[code]?.end_time;
  const range = formatRange(start, end);
  return code === "SUNDAY_EXTRA" ? `${base} ${range}` : `${base} (${range})`;
}

export function sortShiftTypeRows(rows) {
  return [...(rows || [])].sort((a, b) => {
    const codeCmp = String(a?.shift_code || "").localeCompare(String(b?.shift_code || ""));
    if (codeCmp !== 0) return codeCmp;
    const dCmp = String(b?.effective_from || "").localeCompare(String(a?.effective_from || ""));
    if (dCmp !== 0) return dCmp;
    return String(b?.created_at || "").localeCompare(String(a?.created_at || ""));
  });
}

export function resolveEffectiveShiftType(rows, dateIso, shiftCode) {
  const fallback = DEFAULT_SHIFT_TYPE_MAP[shiftCode] || {
    shift_code: shiftCode,
    base_name: shiftCode,
    start_time: "00:00:00",
    end_time: "00:00:00",
    effective_from: "2000-01-01",
    active: true,
  };
  const refDate = String(dateIso || new Date().toISOString().slice(0, 10));
  const match = sortShiftTypeRows(rows).find(
    (row) => row?.shift_code === shiftCode && String(row?.effective_from || "") <= refDate
  );
  const merged = {
    ...fallback,
    ...(match || {}),
  };
  merged.start_time = normalizeTimeHHMMSS(merged.start_time);
  merged.end_time = normalizeTimeHHMMSS(merged.end_time);
  merged.active = merged.active !== false;
  merged.duration_hours = computeDurationHours(merged.start_time, merged.end_time);
  merged.display_label = formatShiftDisplayLabel(shiftCode, merged);
  return merged;
}

export function resolveEffectiveShiftMap(rows, dateIso) {
  return Object.fromEntries(
    SHIFT_TYPE_CODES.map((code) => [code, resolveEffectiveShiftType(rows, dateIso, code)])
  );
}

export function getShiftDurationHoursForDate(rows, dateIso, shiftCode) {
  return Number(resolveEffectiveShiftType(rows, dateIso, shiftCode)?.duration_hours || 0);
}

export function getShiftLabelForDate(rows, dateIso, shiftCode) {
  return resolveEffectiveShiftType(rows, dateIso, shiftCode)?.display_label || shiftCode;
}

export function getShiftStartHHMMForDate(rows, dateIso, shiftCode) {
  return hhmm(resolveEffectiveShiftType(rows, dateIso, shiftCode)?.start_time);
}

export function isShiftActiveForDate(rows, dateIso, shiftCode) {
  return resolveEffectiveShiftType(rows, dateIso, shiftCode)?.active !== false;
}

export async function fetchShiftTypeVersionsClient(client = supabase) {
  try {
    const { data, error } = await client.from("shift_type_versions").select("*").order("shift_code", { ascending: true }).order("effective_from", { ascending: false });
    if (!error && Array.isArray(data)) return { data, error: null };
    return { data: [], error };
  } catch (error) {
    return { data: [], error };
  }
}
