import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h || ""));
  return m?.[1] || "";
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return null;
  return createClient(url, srv, { auth: { persistSession: false } });
}

async function requireAdmin(req) {
  const jwt = getBearer(req);
  if (!jwt) return { error: { status: 401, message: "Auth session missing!" } };

  const sbAnon = anonClient();
  const admin = adminClient();
  if (!sbAnon) return { error: { status: 500, message: "Missing public Supabase env" } };
  if (!admin) return { error: { status: 500, message: "Missing SUPABASE_SERVICE_ROLE_KEY" } };

  const { data: au, error: auErr } = await sbAnon.auth.getUser(jwt);
  if (auErr || !au?.user) {
    return { error: { status: 401, message: auErr?.message || "Unauthorized" } };
  }

  const user = au.user;
  const email = String(user.email || "").toLowerCase();
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

function bodyObject(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (_) {
      return {};
    }
  }
  return req.body || {};
}

function cleanDate(value) {
  const s = String(value || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export default async function handler(req, res) {
  try {
    const auth = await requireAdmin(req);
    if (auth.error) return json(res, auth.error.status, { ok: false, error: auth.error.message });

    if (req.method === "GET") {
      const { data, error } = await auth.admin
        .from("payroll_email_employees")
        .select("id, full_name, base_line, seller_id, seller_match_keyword, active, sort_order, employment_start_date, employment_end_date, created_at, updated_at")
        .order("sort_order", { ascending: true })
        .order("full_name", { ascending: true });

      if (error) throw error;
      return json(res, 200, { ok: true, rows: data || [] });
    }

    if (req.method !== "POST" && req.method !== "PATCH") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const body = bodyObject(req);

    if (req.method === "POST") {
      const fullName = String(body?.full_name || "").trim();
      const baseLine = String(body?.base_line || "").trim();
      const startDate = cleanDate(body?.employment_start_date);
      const endDate = cleanDate(body?.employment_end_date);

      if (!fullName) return json(res, 400, { ok: false, error: "Nom du salarié obligatoire." });
      if (!baseLine) return json(res, 400, { ok: false, error: "Mention de contrat obligatoire." });
      if (!startDate) return json(res, 400, { ok: false, error: "Date d'entrée obligatoire." });
      if (endDate && endDate < startDate) {
        return json(res, 400, { ok: false, error: "La date de sortie ne peut pas précéder la date d'entrée." });
      }

      const { data: lastSortRows, error: sortErr } = await auth.admin
        .from("payroll_email_employees")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1);

      if (sortErr) throw sortErr;
      const nextSort = (Number(lastSortRows?.[0]?.sort_order || 0) || 0) + 10;

      const payload = {
        full_name: fullName,
        base_line: baseLine,
        active: true,
        sort_order: nextSort,
        employment_start_date: startDate,
        employment_end_date: endDate,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await auth.admin
        .from("payroll_email_employees")
        .insert(payload)
        .select("id, full_name, base_line, active, sort_order, employment_start_date, employment_end_date, created_at, updated_at")
        .single();

      if (error) {
        if (String(error?.code || "") === "23505") {
          return json(res, 409, { ok: false, error: "Ce salarié existe déjà dans la liste du mail de paie." });
        }
        throw error;
      }

      return json(res, 200, { ok: true, row: data });
    }

    const employeeId = String(body?.id || "").trim();
    if (!employeeId) return json(res, 400, { ok: false, error: "id salarié manquant." });

    const patch = { updated_at: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(body, "full_name")) {
      patch.full_name = String(body?.full_name || "").trim();
      if (!patch.full_name) return json(res, 400, { ok: false, error: "Nom du salarié obligatoire." });
    }
    if (Object.prototype.hasOwnProperty.call(body, "base_line")) {
      patch.base_line = String(body?.base_line || "").trim();
      if (!patch.base_line) return json(res, 400, { ok: false, error: "Mention de contrat obligatoire." });
    }
    if (Object.prototype.hasOwnProperty.call(body, "active")) {
      patch.active = !!body.active;
    }
    if (Object.prototype.hasOwnProperty.call(body, "employment_start_date")) {
      patch.employment_start_date = cleanDate(body?.employment_start_date);
    }
    if (Object.prototype.hasOwnProperty.call(body, "employment_end_date")) {
      patch.employment_end_date = cleanDate(body?.employment_end_date);
    }

    const effectiveStart = patch.employment_start_date || cleanDate(body?.current_employment_start_date);
    const effectiveEnd = patch.employment_end_date || cleanDate(body?.current_employment_end_date);
    if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
      return json(res, 400, { ok: false, error: "La date de sortie ne peut pas précéder la date d'entrée." });
    }

    const { data, error } = await auth.admin
      .from("payroll_email_employees")
      .update(patch)
      .eq("id", employeeId)
      .select("id, full_name, base_line, seller_id, seller_match_keyword, active, sort_order, employment_start_date, employment_end_date, updated_at")
      .single();

    if (error) throw error;
    return json(res, 200, { ok: true, row: data });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
