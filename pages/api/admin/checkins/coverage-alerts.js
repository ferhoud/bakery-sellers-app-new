// pages/api/admin/checkins/coverage-alerts.js
//
// Retard pointage confirmé -> proposition "qui a couvert ?"
// GET  : liste les pointages confirmés en retard + vendeuses candidates (matin/midi du même jour)
// POST : valide la couverture : garde le retard de la vendeuse en retard et ajoute du travail en plus à celle qui a couvert.
//
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
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

function toISODate(x) {
  return (x || "").toString().slice(0, 10);
}

function parisTodayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n || 0) || 0);
  return Math.max(lo, Math.min(hi, x));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function hhmmFromMinutes(totalMinutes) {
  const raw = Number(totalMinutes || 0) || 0;
  const mins = ((raw % 1440) + 1440) % 1440;
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function parisMinutesOfDay(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (!dt || Number.isNaN(dt.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(dt);

  const hh = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10) || 0;
  const mm = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10) || 0;
  return hh * 60 + mm;
}

function plannedMinutesFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return 13 * 60 + 30;
  if (sc === "SUNDAY_EXTRA") return 9 * 60;
  return 6 * 60 + 30; // MORNING + MIDDAY
}

function coverageTimesFromCheckin(ck, minutesToTransfer) {
  const confirmedMinutes = parisMinutesOfDay(ck?.confirmed_at);
  const currentLate = Math.max(0, Math.round(Number(ck?.late_minutes || 0) || 0));
  const transfer = Math.max(1, Math.round(Number(minutesToTransfer || currentLate || 1) || 1));

  // Si le retard a déjà été partiellement corrigé, late_minutes peut être inférieur au retard original.
  // On repart donc de "heure de pointage - retard restant" pour ne pas recréer toujours 13:30 -> ...
  const planned = plannedMinutesFromShift(ck?.shift_code);
  const baseEnd = Number.isFinite(confirmedMinutes) ? confirmedMinutes : planned + currentLate;
  const start = Math.max(0, Math.min(baseEnd, baseEnd - currentLate));
  const safeStart = Number.isFinite(start) ? start : planned;
  const safeEnd = safeStart + transfer;

  return {
    start_time: hhmmFromMinutes(safeStart),
    end_time: hhmmFromMinutes(safeEnd),
  };
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function candidateShiftOrder(lateShiftCode) {
  const sc = String(lateShiftCode || "").toUpperCase();

  // Cas demandé: vendeuse du soir en retard -> proposer les vendeuses du matin/midi.
  if (sc === "EVENING") return ["MORNING", "MIDDAY", "SUNDAY_EXTRA"];

  // Cas de secours: on propose les autres vendeuses déjà présentes ce jour-là.
  if (sc === "SUNDAY_EXTRA") return ["MORNING", "MIDDAY"];
  if (sc === "MIDDAY") return ["MORNING", "SUNDAY_EXTRA"];
  return ["MIDDAY", "SUNDAY_EXTRA", "EVENING"];
}

async function requireAdmin(req) {
  const jwt = getBearer(req);
  if (!jwt) return { error: { status: 401, message: "Auth session missing!" } };

  const sbAnon = anonClient();
  if (!sbAnon) return { error: { status: 500, message: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" } };

  const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
  if (auErr || !au?.user) return { error: { status: 401, message: auErr?.message || "Unauthorized" } };

  const admin = adminClient();
  if (!admin) return { error: { status: 500, message: "Missing SUPABASE_SERVICE_ROLE_KEY" } };

  const user = au.user;
  const email = (user.email || "").toLowerCase();
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

async function loadNames(admin, ids) {
  const out = {};
  const clean = uniq(ids);
  if (!clean.length) return out;

  try {
    const { data, error } = await admin.from("profiles").select("user_id, full_name").in("user_id", clean);
    if (!error && Array.isArray(data)) {
      for (const p of data) {
        if (p?.user_id) out[p.user_id] = (p.full_name || "").toString().trim();
      }
    }
  } catch (_) {}

  // Fallback si certaines vendeuses sont absentes de profiles mais présentes dans sellers.
  const missing = clean.filter((id) => !out[id]);
  if (missing.length) {
    try {
      const { data, error } = await admin.from("sellers").select("id, user_id, full_name, name").or(`id.in.(${missing.join(",")}),user_id.in.(${missing.join(",")})`);
      if (!error && Array.isArray(data)) {
        for (const s of data) {
          const id = s?.user_id || s?.id;
          if (id) out[id] = (s.full_name || s.name || "").toString().trim();
        }
      }
    } catch (_) {}
  }

  return out;
}

async function loadCoverageEntries(admin, day) {
  const variants = [
    "seller_id, work_date, minutes, reason, note, source, created_at",
    "seller_id, work_date, minutes, reason, source, created_at",
    "seller_id, work_date, minutes, note, source, created_at",
    "seller_id, work_date, minutes, reason, created_at",
    "seller_id, work_date, minutes, note, created_at",
    "seller_id, work_date, minutes, created_at",
  ];

  for (const select of variants) {
    try {
      const { data, error } = await admin
        .from("extra_work_entries")
        .select(select)
        .eq("work_date", day)
        .order("created_at", { ascending: false });

      if (!error && Array.isArray(data)) return data;

      const msg = String(error?.message || "").toLowerCase();
      const code = String(error?.code || "");
      const retryableShape = code === "42703" || msg.includes("column") || msg.includes("schema cache");
      if (!retryableShape) return [];
    } catch (_) {}
  }

  return [];
}

function normText(x) {
  return String(x || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function entryText(e) {
  return normText([e?.reason, e?.note, e?.source].filter(Boolean).join(" "));
}

function isCoverageEntry(e) {
  const txt = entryText(e);
  return txt.includes("checkin_coverage") || txt.includes("couverture retard pointage");
}

function coverageEntryMatchesCheckin(entry, checkin, delayedSellerName) {
  if (!entry || !checkin) return false;
  if (!isCoverageEntry(entry)) return false;

  const txt = entryText(entry);
  const checkinId = String(checkin?.id || "");
  if (checkinId && txt.includes(normText(checkinId))) return true;

  // Compat ancien test local: les premières lignes créées n'avaient pas encore checkin:<id> dans reason.
  // On évite donc de reproposer le même bloc si on retrouve une couverture du même jour,
  // pour le même nom de vendeuse en retard, avec le même nombre de minutes.
  const name = normText(delayedSellerName || "");
  const day = String(checkin?.day || "").slice(0, 10);
  const entryMinutes = Number(entry?.minutes || 0) || 0;
  const lateMinutes = Number(checkin?.late_minutes || 0) || 0;

  if (day && !txt.includes(normText(day))) return false;
  if (name && !txt.includes(name)) return false;
  if (lateMinutes > 0 && entryMinutes > 0 && Math.round(entryMinutes) !== Math.round(lateMinutes)) return false;

  return !!(day && name);
}

async function handleGet(req, res, admin) {
  const q = req.query || {};
  const day = toISODate(q.day || q.date || q.d || parisTodayISO());

  const { data: checkins, error: ckErr } = await admin
    .from("daily_checkins")
    .select("id, day, seller_id, shift_code, confirmed_at, late_minutes, early_minutes, updated_at, created_at")
    .eq("day", day)
    // Couverture métier uniquement pour l'arrivée de l'après-midi :
    // la vendeuse du matin reste éventuellement plus longtemps.
    .eq("shift_code", "EVENING")
    .not("confirmed_at", "is", null)
    .gt("late_minutes", 0)
    .order("confirmed_at", { ascending: false });

  if (ckErr) return json(res, 500, { ok: false, error: ckErr.message });

  const { data: shifts, error: shErr } = await admin
    .from("shifts")
    .select("date, seller_id, shift_code")
    .eq("date", day);

  if (shErr) return json(res, 500, { ok: false, error: shErr.message });

  const ids = uniq([
    ...(checkins || []).map((c) => c.seller_id),
    ...(shifts || []).map((s) => s.seller_id),
  ]);
  const names = await loadNames(admin, ids);
  const coverageEntries = await loadCoverageEntries(admin, day);

  const shiftRows = Array.isArray(shifts) ? shifts : [];
  const items = (checkins || [])
    .filter((c) => {
      const late = Number(c?.late_minutes || 0) || 0;
      if (late <= 0) return false;
      const delayedName = names[c.seller_id] || "";
      return !(coverageEntries || []).some((e) => coverageEntryMatchesCheckin(e, c, delayedName));
    })
    .map((c) => {
      const lateShift = String(c?.shift_code || "").toUpperCase();
      const preferred = candidateShiftOrder(lateShift);

      let candidates = shiftRows
        .filter((s) => s?.seller_id && s.seller_id !== c.seller_id)
        .filter((s) => preferred.includes(String(s?.shift_code || "").toUpperCase()))
        .sort((a, b) => preferred.indexOf(String(a.shift_code).toUpperCase()) - preferred.indexOf(String(b.shift_code).toUpperCase()));

      // Si planning incomplet, on garde une roue de secours: toute vendeuse planifiée ce jour-là sauf celle en retard.
      if (!candidates.length) {
        candidates = shiftRows.filter((s) => s?.seller_id && s.seller_id !== c.seller_id);
      }

      const seen = new Set();
      const candidateItems = [];
      for (const s of candidates) {
        if (seen.has(s.seller_id)) continue;
        seen.add(s.seller_id);
        candidateItems.push({
          seller_id: s.seller_id,
          full_name: names[s.seller_id] || "Vendeuse",
          shift_code: s.shift_code || "",
        });
      }

      return {
        id: c.id,
        checkin_id: c.id,
        day: c.day,
        seller_id: c.seller_id,
        seller_name: names[c.seller_id] || "Vendeuse",
        shift_code: lateShift,
        confirmed_at: c.confirmed_at,
        late_minutes: Number(c.late_minutes || 0) || 0,
        early_minutes: Number(c.early_minutes || 0) || 0,
        candidates: candidateItems,
      };
    });

  return json(res, 200, { ok: true, day, items });
}

async function insertExtraWork(admin, payloads) {
  let lastError = null;

  for (const payload of payloads) {
    const { data, error } = await admin.from("extra_work_entries").insert(payload).select("*").maybeSingle();
    if (!error) return { data, error: null };

    lastError = error;
    const msg = String(error?.message || "").toLowerCase();
    const code = String(error?.code || "");

    // On continue si la forme de la table diffère selon les versions locales/prod :
    // - colonne absente (source, note, created_by, updated_at, kind...)
    // - contrainte CHECK sur kind avec une valeur non acceptée
    // - NOT NULL sur une colonne qu'une variante suivante peut renseigner
    const retryableShape = code === "42703" || msg.includes("column") || msg.includes("schema cache");
    const retryableConstraint =
      code === "23502" ||
      code === "23514" ||
      msg.includes("not-null") ||
      msg.includes("not null") ||
      msg.includes("check constraint") ||
      msg.includes("invalid input value");

    if (!retryableShape && !retryableConstraint) break;
  }

  return { data: null, error: lastError || new Error("INSERT_EXTRA_WORK_FAILED") };
}

async function handlePost(req, res, admin, user) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const checkinId = (body.checkin_id || body.id || "").toString();
  const covererId = (body.covered_by_seller_id || body.coverer_seller_id || body.seller_id || "").toString();

  if (!checkinId) return json(res, 400, { ok: false, error: "Missing checkin_id" });
  if (!covererId) return json(res, 400, { ok: false, error: "Missing covered_by_seller_id" });

  const { data: ck, error: ckErr } = await admin
    .from("daily_checkins")
    .select("id, day, seller_id, shift_code, confirmed_at, late_minutes")
    .eq("id", checkinId)
    .maybeSingle();

  if (ckErr) return json(res, 500, { ok: false, error: ckErr.message });
  if (!ck?.id) return json(res, 404, { ok: false, error: "CHECKIN_NOT_FOUND" });
  if (!ck.confirmed_at) return json(res, 400, { ok: false, error: "CHECKIN_NOT_CONFIRMED" });
  // Sécurité serveur : on ne traite la couverture automatique que pour le pointage du soir.
  if (String(ck.shift_code || "").toUpperCase() !== "EVENING") {
    return json(res, 400, { ok: false, error: "COVERAGE_ONLY_FOR_EVENING" });
  }
  if (covererId === ck.seller_id) return json(res, 400, { ok: false, error: "SAME_SELLER" });

  const currentLate = Number(ck.late_minutes || 0) || 0;
  if (currentLate <= 0) return json(res, 409, { ok: false, error: "NO_LATE_MINUTES_LEFT" });

  const minutes = clampInt(body.minutes || currentLate, 1, currentLate);
  const nowIso = new Date().toISOString();

  // Sécurité: la vendeuse qui couvre doit être planifiée ce jour-là, sinon on refuse une erreur de sélection.
  const { data: coverShift, error: coverErr } = await admin
    .from("shifts")
    .select("seller_id, shift_code")
    .eq("date", ck.day)
    .eq("seller_id", covererId)
    .limit(1)
    .maybeSingle();

  if (coverErr) return json(res, 500, { ok: false, error: coverErr.message });
  if (!coverShift?.seller_id) return json(res, 400, { ok: false, error: "COVERER_NOT_SCHEDULED_THIS_DAY" });

  const names = await loadNames(admin, [ck.seller_id, covererId]);
  const lateName = names[ck.seller_id] || "vendeuse en retard";
  const coverName = names[covererId] || "vendeuse qui a couvert";
  const reason = `Couverture retard pointage: ${coverName} a couvert ${lateName} (${minutes} min, ${ck.day}, checkin:${ck.id})`;

  // On NE retire PAS le retard de la vendeuse en retard.
  // Métier choisi: la vendeuse garde son retard, et celle qui a couvert reçoit du travail en plus.
  const coverageTimes = coverageTimesFromCheckin(ck, minutes);

  const commonExtraWork = {
    seller_id: covererId,
    work_date: ck.day,
    start_time: coverageTimes.start_time,
    end_time: coverageTimes.end_time,
    minutes,
  };

  // Selon les versions SQL, extra_work_entries peut exiger kind et parfois limiter ses valeurs.
  // On privilégie "coverage" pour tracer la couverture, puis on tente des valeurs classiques.
  const kindValues = ["coverage", "checkin_coverage", "extra_work", "manual", "manual_extra_work"];
  const shapeVariants = [
    { reason, source: "CHECKIN_COVERAGE", created_by: user.id, created_at: nowIso, updated_at: nowIso },
    { reason, source: "CHECKIN_COVERAGE", created_at: nowIso },
    { note: reason, source: "CHECKIN_COVERAGE", created_at: nowIso },
    { reason },
    { note: reason },
    {},
  ];

  const payloads = [];
  for (const kind of kindValues) {
    for (const extra of shapeVariants) payloads.push({ ...commonExtraWork, kind, ...extra });
  }
  // Compat si un ancien environnement n'a pas encore la colonne kind.
  for (const extra of shapeVariants) payloads.push({ ...commonExtraWork, ...extra });

  const { error: insErr } = await insertExtraWork(admin, payloads);
  if (insErr) {
    return json(res, 500, { ok: false, error: insErr.message || "EXTRA_WORK_INSERT_FAILED" });
  }

  return json(res, 200, {
    ok: true,
    checkin_id: ck.id,
    day: ck.day,
    delayed_seller_id: ck.seller_id,
    covered_by_seller_id: covererId,
    covered_minutes: minutes,
    transferred_minutes: minutes,
    start_time: coverageTimes.start_time,
    end_time: coverageTimes.end_time,
    late_minutes_kept: currentLate,
    new_late_minutes: currentLate,
  });
}

export default async function handler(req, res) {
  try {
    const auth = await requireAdmin(req);
    if (auth?.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    if (req.method === "GET") return handleGet(req, res, auth.admin);
    if (req.method === "POST") return handlePost(req, res, auth.admin, auth.user);

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
