// pages/api/supervisor/plan.js
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "../../../lib/admin";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] || "";
}

function isoFromDateUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function startOfWeekISO(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return isoFromDateUTC(d);
}

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoFromDateUTC(d);
}

function enumerateWeek(mondayISO) {
  const out = [];
  for (let i = 0; i < 7; i++) out.push(addDaysISO(mondayISO, i));
  return out;
}

function normalizeAssignments(dates, rows) {
  const out = {};
  for (const d of dates) out[d] = {};
  for (const r of rows || []) {
    const date = (r.date || "").slice(0, 10);
    if (!date) continue;
    out[date] ||= {};
    out[date][r.shift_code] = {
      seller_id: r.seller_id ?? null,
      full_name: r.full_name ?? "",
    };
  }
  return out;
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

async function isSupervisor(admin, userId) {
  const { data, error } = await admin.from("supervisors").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) return false;
  return !!data?.user_id;
}

function bestNameFromUser(u) {
  const md = u?.user_metadata || {};
  const full =
    (md.full_name || md.name || md.display_name || md.username || "").toString().trim();
  if (full) return full;
  const email = (u?.email || "").toString().trim();
  if (email) return email.split("@")[0];
  return "";
}

async function buildNameMap(admin, ids) {
  const nameMap = {};

  if (!ids.length) return nameMap;

  // 1) profiles.full_name (rapide)
  const { data: profs } = await admin
    .from("profiles")
    .select("user_id,full_name")
    .in("user_id", ids);

  for (const p of profs || []) {
    const n = (p.full_name || "").toString().trim();
    if (n) nameMap[p.user_id] = n;
  }

  // 2) fallback Auth (quand profiles est vide ou absent)
  const missing = ids.filter((id) => !nameMap[id]);
  for (const id of missing) {
    try {
      const { data, error } = await admin.auth.admin.getUserById(id);
      if (!error && data?.user) {
        const n = bestNameFromUser(data.user);
        if (n) nameMap[id] = n;
      }
    } catch {
      // ignore
    }
  }

  return nameMap;
}

export default async function handler(req, res) {
  try {
    const jwt = getBearer(req);
    if (!jwt) return json(res, 401, { ok: false, error: "Missing Authorization Bearer token" });

    const sb = anonClient();
    if (!sb) return json(res, 500, { ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY" });

    const { data: authData, error: authErr } = await sb.auth.getUser(jwt);
    if (authErr || !authData?.user) return json(res, 401, { ok: false, error: authErr?.message || "Unauthorized" });

    const user = authData.user;

    const admin = adminClient();
    if (!admin) return json(res, 500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    // Autorisation : admin ou supervisor
    const email = (user.email || "").toLowerCase();
    const allowAdmin = isAdminEmail(email);
    const allowSupervisor = !allowAdmin ? await isSupervisor(admin, user.id) : true;
    if (!allowAdmin && !allowSupervisor) return json(res, 403, { ok: false, error: "Forbidden" });

    const date = String(req.query.date || isoFromDateUTC(new Date())).slice(0, 10);
    const monday = startOfWeekISO(date);
    const sunday = addDaysISO(monday, 6);
    const dates = enumerateWeek(monday);

    // Source canonique = shifts (évite view incomplète)
    const { data: shifts, error: e1 } = await admin
      .from("shifts")
      .select("date,shift_code,seller_id")
      .gte("date", monday)
      .lte("date", sunday)
      .order("date", { ascending: true });

    if (e1) return json(res, 500, { ok: false, error: e1.message });

    const ids = Array.from(new Set((shifts || []).map((s) => s.seller_id).filter(Boolean)));
    const nameMap = await buildNameMap(admin, ids);

    const rows = (shifts || []).map((s) => ({
      date: s.date,
      shift_code: s.shift_code,
      seller_id: s.seller_id,
      full_name: nameMap[s.seller_id] || "",
    }));

    const assignments = normalizeAssignments(dates, rows);

    // Clés stables
    const SHIFT_ORDER = ["MORNING", "MIDDAY", "EVENING", "SUNDAY_EXTRA"];
    for (const d of dates) {
      assignments[d] ||= {};
      for (const code of SHIFT_ORDER) {
        assignments[d][code] ||= { seller_id: null, full_name: "" };
      }
    }

    return json(res, 200, {
      ok: true,
      role: allowAdmin ? "admin" : "supervisor",
      date,
      monday,
      sunday,
      dates,
      assignments,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
