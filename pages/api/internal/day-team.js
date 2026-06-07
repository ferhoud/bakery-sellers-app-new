import { createClient } from "@supabase/supabase-js";

const SHIFT_META = {
  MORNING: { label: "Matin", start: "06:30", end: "13:30", hours: 7 },
  MIDDAY: { label: "Milieu journée", start: "", end: "", hours: 7 },
  EVENING: { label: "Après-midi", start: "13:30", end: "20:30", hours: 7 },
  SUNDAY_EXTRA: { label: "Dimanche renfort", start: "09:00", end: "13:30", hours: 4.5 },
};

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

function cleanName(value) {
  if (!value) return "Vendeuse";
  return String(value).trim() || "Vendeuse";
}

function shiftMeta(code) {
  return SHIFT_META[code] || {
    label: code || "Créneau",
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

function normalizeAssignment(row, profilesById = {}) {
  const code = row?.shift_code || row?.code || row?.shift || row?.slot || "";
  const meta = shiftMeta(code);
  const sellerId = getSellerId(row);

  return {
    sellerId,
    name: getName(row, profilesById),
    shiftCode: code,
    shiftLabel: meta.label,
    start: row?.start_time || row?.start || meta.start,
    end: row?.end_time || row?.end || meta.end,
    hours: row?.hours ?? meta.hours,
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
    .eq("date", date)
    .order("shift_code", { ascending: true });

  if (error) return { data: [], error };
  return { data: Array.isArray(data) ? data : [], error: null };
}

async function loadAssignmentsFallback(supabase, date) {
  const { data, error } = await supabase
    .from("shifts")
    .select("*")
    .eq("date", date)
    .order("shift_code", { ascending: true });

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
    const base = normalizeAssignment(row, profilesById);
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
  });

  const replacementTeam = replacements.map((replacement) => {
    const absence = absences.find((item) => item.id === replacement.absence_id);
    const code = replacement.accepted_shift_code || "";
    const meta = shiftMeta(code);
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
  });

  return res.status(200).json({
    ok: true,
    source,
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
