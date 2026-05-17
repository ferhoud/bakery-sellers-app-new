// pages/api/cron/missing-checkin-push.js
//
// Cron serveur : envoie une notification push aux admins quand une vendeuse
// planifiée n'a toujours pas pointé 1h après le début prévu de son créneau.
//
// Protection : Authorization: Bearer <CRON_SECRET>
// Déclenchement conseillé : toutes les 5 minutes via Vercel Cron.
// Anti-spam : notification envoyée seulement dans la fenêtre 60..64 min après le début.
//
// Le contenu de l'alerte côté admin reste géré par
// /api/admin/checkins/missing-resolution et pages/admin.js.
import { createClient } from "@supabase/supabase-js";

const ALERT_AFTER_MINUTES = 60;
const NOTIFY_WINDOW_MINUTES = 5;

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || "";
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function hhmmFromMinutes(totalMinutes) {
  const raw = Math.round(Number(totalMinutes || 0) || 0);
  const mins = ((raw % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

function parisNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value || "1970";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  const d = parts.find((p) => p.type === "day")?.value || "01";
  const hh = Number(parts.find((p) => p.type === "hour")?.value || 0) || 0;
  const mm = Number(parts.find((p) => p.type === "minute")?.value || 0) || 0;

  return {
    day: `${y}-${m}-${d}`,
    minutes: hh * 60 + mm,
  };
}

function plannedMinutesFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return 13 * 60 + 30;
  if (sc === "SUNDAY_EXTRA") return 9 * 60;
  return 6 * 60 + 30; // MORNING + MIDDAY
}

function shiftShortLabel(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return "Soir";
  if (sc === "SUNDAY_EXTRA") return "Dimanche";
  if (sc === "MIDDAY") return "Midi";
  return "Matin";
}

function shiftLongLabel(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return "Soir (13h30-20h30)";
  if (sc === "SUNDAY_EXTRA") return "Dimanche (9h-13h30)";
  if (sc === "MIDDAY") return "Midi";
  return "Matin";
}

function alertId(day, sellerId, shiftCode) {
  return `${day || ""}:${sellerId || ""}:${String(shiftCode || "").toUpperCase()}`;
}

function getOrigin(req) {
  const envOrigin = String(process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || "").trim();
  if (envOrigin) return envOrigin.replace(/\/$/, "");

  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  if (host) return `${proto}://${host}`;

  return "https://bakery-sellers-app-new.vercel.app";
}

async function loadNames(admin, ids) {
  const out = {};
  const clean = uniq(ids);
  if (!clean.length) return out;

  try {
    const { data, error } = await admin.from("profiles").select("user_id, full_name").in("user_id", clean);
    if (!error && Array.isArray(data)) {
      for (const p of data) {
        if (p?.user_id) out[p.user_id] = String(p.full_name || "").trim();
      }
    }
  } catch (_) {}

  const missing = clean.filter((id) => !out[id]);
  if (missing.length) {
    try {
      const { data, error } = await admin
        .from("sellers")
        .select("id, user_id, full_name, name")
        .or(`id.in.(${missing.join(",")}),user_id.in.(${missing.join(",")})`);
      if (!error && Array.isArray(data)) {
        for (const s of data) {
          const id = s?.user_id || s?.id;
          if (id) out[id] = String(s.full_name || s.name || "").trim();
        }
      }
    } catch (_) {}
  }

  return out;
}

async function loadConfirmedCheckins(admin, day) {
  const { data, error } = await admin
    .from("daily_checkins")
    .select("id, day, seller_id, shift_code, confirmed_at")
    .eq("day", day)
    .not("confirmed_at", "is", null);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadAbsenceSellerIds(admin, day) {
  const { data, error } = await admin
    .from("absences")
    .select("seller_id, status")
    .eq("date", day)
    .in("status", ["pending", "approved"]);

  if (error) {
    const msg = String(error?.message || "").toLowerCase();
    const missingTable = String(error?.code || "") === "42P01" || msg.includes("does not exist");
    if (missingTable) return new Set();
    throw error;
  }

  return new Set((data || []).map((row) => row?.seller_id).filter(Boolean));
}

function isInNotificationWindow(nowMinutes, plannedMinutes) {
  const minutesSinceStart = Math.max(0, nowMinutes - plannedMinutes);
  const ready = minutesSinceStart >= ALERT_AFTER_MINUTES;
  const insideWindow = minutesSinceStart < ALERT_AFTER_MINUTES + NOTIFY_WINDOW_MINUTES;
  return {
    minutesSinceStart,
    shouldNotify: ready && insideWindow,
  };
}

async function loadMissingItems(admin, day, nowMinutes) {
  const { data: shifts, error: shErr } = await admin
    .from("shifts")
    .select("date, seller_id, shift_code")
    .eq("date", day);

  if (shErr) throw shErr;

  const shiftRows = Array.isArray(shifts) ? shifts.filter((s) => s?.seller_id && s?.shift_code) : [];
  if (!shiftRows.length) return [];

  const [checkins, absentSellerIds] = await Promise.all([
    loadConfirmedCheckins(admin, day),
    loadAbsenceSellerIds(admin, day),
  ]);

  const confirmedSellerIds = new Set((checkins || []).map((row) => row?.seller_id).filter(Boolean));
  const names = await loadNames(admin, shiftRows.map((row) => row.seller_id));

  return shiftRows
    .map((row) => {
      const shiftCode = String(row.shift_code || "").toUpperCase();
      const plannedMinutes = plannedMinutesFromShift(shiftCode);
      const timing = isInNotificationWindow(nowMinutes, plannedMinutes);
      return {
        id: alertId(day, row.seller_id, shiftCode),
        alert_id: alertId(day, row.seller_id, shiftCode),
        day,
        seller_id: row.seller_id,
        seller_name: names[row.seller_id] || "Vendeuse",
        shift_code: shiftCode,
        shift_label: shiftLongLabel(shiftCode),
        shift_short_label: shiftShortLabel(shiftCode),
        planned_time: hhmmFromMinutes(plannedMinutes),
        minutes_since_start: timing.minutesSinceStart,
        should_notify: timing.shouldNotify,
      };
    })
    .filter((item) => item.should_notify)
    .filter((item) => !confirmedSellerIds.has(item.seller_id))
    .filter((item) => !absentSellerIds.has(item.seller_id))
    .sort((a, b) => {
      const t = String(a.planned_time || "").localeCompare(String(b.planned_time || ""));
      if (t !== 0) return t;
      return String(a.seller_name || "").localeCompare(String(b.seller_name || ""), "fr");
    });
}

async function broadcastAdminPush(req, item) {
  const origin = getOrigin(req);
  const payload = {
    title: "⏱️ Pointage manquant",
    body: `${item.seller_name} n’a pas pointé pour le créneau ${item.shift_label}. Est-elle absente ?`,
    url: "/admin",
    role: "admin",
    tag: `missing-checkin-${item.alert_id}`,
    data: {
      type: "missing-checkin",
      alert_id: item.alert_id,
      day: item.day,
      seller_id: item.seller_id,
      shift_code: item.shift_code,
    },
  };

  const r = await fetch(`${origin}/api/push/broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json().catch(() => ({}));
  return {
    ok: r.ok && j?.ok !== false,
    status: r.status,
    response: j,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const secret = String(process.env.CRON_SECRET || "");
    if (!secret) {
      return json(res, 500, { ok: false, error: "Missing CRON_SECRET" });
    }

    const bearer = getBearer(req);
    if (!bearer || bearer !== secret) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    const admin = adminClient();
    if (!admin) {
      return json(res, 500, {
        ok: false,
        error: "Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      });
    }

    const now = parisNowParts();
    const items = await loadMissingItems(admin, now.day, now.minutes);

    const deliveries = [];
    for (const item of items) {
      try {
        const result = await broadcastAdminPush(req, item);
        deliveries.push({
          alert_id: item.alert_id,
          seller_name: item.seller_name,
          shift_code: item.shift_code,
          ok: result.ok,
          status: result.status,
          push: result.response,
        });
      } catch (e) {
        deliveries.push({
          alert_id: item.alert_id,
          seller_name: item.seller_name,
          shift_code: item.shift_code,
          ok: false,
          status: 0,
          error: e?.message || "PUSH_BROADCAST_FAILED",
        });
      }
    }

    return json(res, 200, {
      ok: true,
      day: now.day,
      alert_after_minutes: ALERT_AFTER_MINUTES,
      notify_window_minutes: NOTIFY_WINDOW_MINUTES,
      candidates: items.length,
      notifications_attempted: deliveries.length,
      notifications_ok: deliveries.filter((x) => x.ok).length,
      deliveries,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "MISSING_CHECKIN_PUSH_CRON_FAILED" });
  }
}
