import { createClient } from "@supabase/supabase-js";

const SHIFT_META_FALLBACK = {
  MORNING: { label: "Matin", start: "06:30", end: "13:30", hours: 7 },
  MIDDAY: { label: "Milieu journée", start: "06:30", end: "13:30", hours: 7 },
  EVENING: { label: "Après-midi", start: "13:30", end: "21:00", hours: 7.5 },
  SUNDAY_EXTRA: { label: "Dimanche renfort", start: "09:00", end: "13:30", hours: 4.5 },
};

const SHIFT_ORDER = {
  MORNING: 1,
  MIDDAY: 2,
  SUNDAY_EXTRA: 3,
  EVENING: 4,
};

const DATE_FIELD_CANDIDATES_FROM = [
  "effective_from",
  "valid_from",
  "start_date",
  "from_date",
  "effective_date",
  "starts_on",
];

const DATE_FIELD_CANDIDATES_TO = [
  "effective_to",
  "valid_to",
  "end_date",
  "to_date",
  "ends_on",
];

function getSecretFromRequest(req) {
  return (
    req.headers["x-internal-secret"] ||
    req.headers["x-api-secret"] ||
    req.query?.secret ||
    ""
  );
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeIsoDate(value) {
  if (!value) return "";
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function getFirstDate(row, fields) {
  for (const field of fields) {
    const value = normalizeIsoDate(row?.[field]);
    if (value) return value;
  }
  return "";
}

function cleanName(value) {
  if (!value) return "Vendeuse";
  return String(value).trim() || "Vendeuse";
}

function normalizeShiftCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeTime(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";

  const hFormat = text.match(/^(\d{1,2})\s*h\s*(\d{0,2})$/i);
  if (hFormat) {
    const hour = Math.max(0, Math.min(23, Number(hFormat[1] || 0)));
    const minute = hFormat[2] ? Math.max(0, Math.min(59, Number(hFormat[2]))) : 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  const colonFormat = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (colonFormat) {
    const hour = Math.max(0, Math.min(23, Number(colonFormat[1] || 0)));
    const minute = Math.max(0, Math.min(59, Number(colonFormat[2] || 0)));
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  return text;
}

function timeToMinutes(value) {
  const time = normalizeTime(value);
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function computeHours(start, end) {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  if (startMinutes === null || endMinutes === null) return null;
  let diff = endMinutes - startMinutes;
  if (diff < 0) diff += 24 * 60;
  return Math.round((diff / 60) * 100) / 100;
}

function normalizeHours(value, start, end) {
  const numeric = Number(String(value ?? "").replace(",", "."));
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return computeHours(start, end);
}

function getShiftRowCode(row) {
  return normalizeShiftCode(
    row?.code ||
      row?.shift_code ||
      row?.shiftCode ||
      row?.key ||
      row?.id
  );
}

function isShiftRowActive(row) {
  if (row?.active === false) return false;
  if (row?.is_active === false) return false;
  if (row?.enabled === false) return false;
  if (row?.deleted_at) return false;
  if (row?.archived_at) return false;
  return true;
}

function normalizeShiftMetaRow(row) {
  const code = getShiftRowCode(row);
  if (!code) return null;

  const start = normalizeTime(
    row?.start_time ||
      row?.start ||
      row?.from_time ||
      row?.starts_at ||
      row?.begin_time
  );
  const end = normalizeTime(
    row?.end_time ||
      row?.end ||
      row?.to_time ||
      row?.ends_at ||
      row?.finish_time
  );

  return {
    code,
    label: String(row?.label || row?.name || SHIFT_META_FALLBACK[code]?.label || code).trim(),
    start: start || SHIFT_META_FALLBACK[code]?.start || "",
    end: end || SHIFT_META_FALLBACK[code]?.end || "",
    hours: normalizeHours(
      row?.hours ?? row?.duration_hours ?? row?.paid_hours ?? row?.duration,
      start || SHIFT_META_FALLBACK[code]?.start,
      end || SHIFT_META_FALLBACK[code]?.end
    ) ?? SHIFT_META_FALLBACK[code]?.hours ?? null,
    fromDate: getFirstDate(row, DATE_FIELD_CANDIDATES_FROM),
    toDate: getFirstDate(row, DATE_FIELD_CANDIDATES_TO),
  };
}

function pickEffectiveShiftRows(rows, date) {
  const byCode = new Map();

  for (const row of rows || []) {
    if (!isShiftRowActive(row)) continue;

    const meta = normalizeShiftMetaRow(row);
    if (!meta?.code) continue;
    if (meta.fromDate && meta.fromDate > date) continue;
    if (meta.toDate && meta.toDate < date) continue;

    const current = byCode.get(meta.code);
    if (!current) {
      byCode.set(meta.code, meta);
      continue;
    }

    const currentFrom = current.fromDate || "0000-00-00";
    const nextFrom = meta.fromDate || "0000-00-00";
    if (nextFrom >= currentFrom) byCode.set(meta.code, meta);
  }

  return byCode;
}

async function loadShiftMeta(supabase, date) {
  const map = new Map(
    Object.entries(SHIFT_META_FALLBACK).map(([code, meta]) => [code, { ...meta }])
  );

  const { data, error } = await supabase.from("shift_types").select("*");

  if (error || !Array.isArray(data) || !data.length) {
    return { map, source: "fallback" };
  }

  const effectiveRows = pickEffectiveShiftRows(data, date);
  effectiveRows.forEach((meta, code) => {
    map.set(code, {
      label: meta.label || map.get(code)?.label || code,
      start: meta.start || map.get(code)?.start || "",
      end: meta.end || map.get(code)?.end || "",
      hours: meta.hours ?? map.get(code)?.hours ?? null,
    });
  });

  return { map, source: "shift_types" };
}

function shiftMeta(code, shiftMetaMap) {
  const normalizedCode = normalizeShiftCode(code);
  return shiftMetaMap.get(normalizedCode) || {
    label: normalizedCode || "Créneau",
    start: "",
    end: "",
    hours: null,
  };
}

function getSellerId(row) {
  return row?.seller_id || row?.profile_id || row?.user_id || row?.id || null;
}

function getName(row, profilesById = {}) {
  const sellerId = getSellerId(row);
  return cleanName(
    row?.full_name ||
      row?.seller_name ||
      row?.name ||
      row?.display_name ||
      profilesById[sellerId]?.full_name ||
      profilesById[sellerId]?.name ||
      profilesById[sellerId]?.email
  );
}

function normalizeAssignment(row, profilesById = {}, shiftMetaMap) {
  const code = normalizeShiftCode(row?.shift_code || row?.code || row?.shift || row?.slot || "");
  const meta = shiftMeta(code, shiftMetaMap);
  const sellerId = getSellerId(row);

  const rowStart = normalizeTime(row?.start_time || row?.start || row?.from_time);
  const rowEnd = normalizeTime(row?.end_time || row?.end || row?.to_time);
  const start = meta.start || rowStart;
  const end = meta.end || rowEnd;

  return {
    sellerId,
    name: getName(row, profilesById),
    shiftCode: code,
    shiftLabel: meta.label,
    start,
    end,
    hours: meta.hours ?? normalizeHours(row?.hours, start, end),
    status: "planned",
  };
}

async function loadProfiles(supabase, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return {};

  const attempts = [
    { column: "user_id", select: "user_id, full_name, email, role, active" },
    { column: "id", select: "id, full_name, email, role, active" },
  ];

  for (const attempt of attempts) {
    const { data, error } = await supabase
      .from("profiles")
      .select(attempt.select)
      .in(attempt.column, uniqueIds);

    if (!error && Array.isArray(data)) {
      return Object.fromEntries(
        data.map((profile) => [profile.user_id || profile.id, profile])
      );
    }
  }

  return {};
}

async function loadAssignmentsFromView(supabase, date) {
  const { data, error } = await supabase
    .from("view_week_assignments")
    .select("*")
    .eq("date", date);

  if (error) return { data: [], error };
  return { data: Array.isArray(data) ? data : [], error: null };
}

async function loadAssignmentsFallback(supabase, date) {
  const { data, error } = await supabase
    .from("shifts")
    .select("*")
    .eq("date", date);

  if (error) return { data: [], error };
  return { data: Array.isArray(data) ? data : [], error: null };
}

async function loadAbsences(supabase, date) {
  const { data, error } = await supabase
    .from("absences")
    .select("id, seller_id, date, status, reason, admin_forced, source")
    .eq("date", date)
    .in("status", ["pending", "approved"]);

  if (error) return [];
  return Array.isArray(data) ? data : [];
}

async function loadReplacementInterest(supabase, absences) {
  const absenceIds = absences.map((absence) => absence.id).filter(Boolean);
  if (!absenceIds.length) return [];

  const { data, error } = await supabase
    .from("replacement_interest")
    .select("id, absence_id, volunteer_id, status, accepted_shift_code")
    .in("absence_id", absenceIds)
    .eq("status", "accepted");

  if (error) return [];
  return Array.isArray(data) ? data : [];
}

function sortTeam(a, b) {
  const shiftA = normalizeShiftCode(a?.shiftCode || a?.shift_code);
  const shiftB = normalizeShiftCode(b?.shiftCode || b?.shift_code);
  const orderA = SHIFT_ORDER[shiftA] || 99;
  const orderB = SHIFT_ORDER[shiftB] || 99;
  if (orderA !== orderB) return orderA - orderB;
  return String(a?.name || "").localeCompare(String(b?.name || ""), "fr");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const expectedSecret = process.env.INTERNAL_API_SECRET;
  const receivedSecret = getSecretFromRequest(req);

  if (!expectedSecret) {
    return res.status(500).json({
      ok: false,
      error: "missing_internal_secret_env",
      message: "Ajoute INTERNAL_API_SECRET dans les variables d'environnement de l'application vendeuses.",
    });
  }

  if (receivedSecret !== expectedSecret) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const date = String(req.query.date || "").slice(0, 10);
  if (!isValidDate(date)) {
    return res.status(400).json({
      ok: false,
      error: "invalid_date",
      message: "La date doit être au format YYYY-MM-DD.",
    });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({
      ok: false,
      error: "missing_supabase_env",
      message: "NEXT_PUBLIC_SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont nécessaires côté application vendeuses.",
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { map: shiftMetaMap, source: shiftConfigSource } = await loadShiftMeta(supabase, date);

  let source = "view_week_assignments";
  let { data: assignments, error: viewError } = await loadAssignmentsFromView(supabase, date);

  if (viewError || !assignments.length) {
    const fallback = await loadAssignmentsFallback(supabase, date);
    assignments = fallback.data;
    source = fallback.error ? "none" : "shifts";
  }

  const absences = await loadAbsences(supabase, date);
  const replacements = await loadReplacementInterest(supabase, absences);

  const idsToLoad = [
    ...assignments.map(getSellerId),
    ...absences.map((absence) => absence.seller_id),
    ...replacements.map((replacement) => replacement.volunteer_id),
  ];

  const profilesById = await loadProfiles(supabase, idsToLoad);

  const absencesBySeller = Object.fromEntries(
    absences.map((absence) => [absence.seller_id, absence])
  );

  const replacementsByAbsence = Object.fromEntries(
    replacements.map((replacement) => [replacement.absence_id, replacement])
  );

  const team = assignments.map((row) => {
    const base = normalizeAssignment(row, profilesById, shiftMetaMap);
    const absence = absencesBySeller[base.sellerId];
    const replacement = absence ? replacementsByAbsence[absence.id] : null;
    const replacementProfile = replacement ? profilesById[replacement.volunteer_id] : null;

    if (!absence) return base;

    return {
      ...base,
      status: "absent",
      absenceStatus: absence.status,
      absenceReason: absence.reason || "",
      adminForced: Boolean(absence.admin_forced),
      replacement: replacement
        ? {
            sellerId: replacement.volunteer_id,
            name: cleanName(replacementProfile?.full_name || replacementProfile?.email),
            acceptedShiftCode: replacement.accepted_shift_code || base.shiftCode,
          }
        : null,
    };
  }).sort(sortTeam);

  const replacementTeam = replacements.map((replacement) => {
    const absence = absences.find((item) => item.id === replacement.absence_id);
    const code = normalizeShiftCode(replacement.accepted_shift_code || "");
    const meta = shiftMeta(code, shiftMetaMap);
    const profile = profilesById[replacement.volunteer_id];
    const absentProfile = absence ? profilesById[absence.seller_id] : null;

    return {
      sellerId: replacement.volunteer_id,
      name: cleanName(profile?.full_name || profile?.email),
      shiftCode: code,
      shiftLabel: meta.label,
      start: meta.start,
      end: meta.end,
      hours: meta.hours,
      status: "replacement",
      replacesSellerId: absence?.seller_id || null,
      replacesName: cleanName(absentProfile?.full_name || absentProfile?.email),
    };
  }).sort(sortTeam);

  return res.status(200).json({
    ok: true,
    source,
    shiftConfigSource,
    date,
    team,
    replacements: replacementTeam,
    absences: absences.map((absence) => ({
      id: absence.id,
      sellerId: absence.seller_id,
      name: getName({ seller_id: absence.seller_id }, profilesById),
      status: absence.status,
      reason: absence.reason || "",
      adminForced: Boolean(absence.admin_forced),
      source: absence.source || "",
    })),
  });
}
