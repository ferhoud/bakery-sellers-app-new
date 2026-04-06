
import { createClient } from "@supabase/supabase-js";
import { isAdminEmail } from "@/lib/admin";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || "";

export function createPublicClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Variables Supabase publiques manquantes");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY manquante");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getBearerToken(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(auth));
  return m?.[1] || "";
}

export async function requireAdmin(req, res) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Token manquant" });
      return null;
    }

    const publicClient = createPublicClient();
    const service = createServiceClient();

    const { data: authData, error: authError } = await publicClient.auth.getUser(token);
    if (authError || !authData?.user) {
      res.status(401).json({ error: "Session invalide" });
      return null;
    }

    const user = authData.user;
    let isAdmin = false;

    try {
      if (isAdminEmail(user.email || "")) isAdmin = true;
    } catch {}

    if (!isAdmin) {
      const { data: profile } = await service.from("profiles").select("role").eq("user_id", user.id).maybeSingle();
      if (profile?.role === "admin") isAdmin = true;
    }

    if (!isAdmin) {
      res.status(403).json({ error: "Accès admin requis" });
      return null;
    }

    return { user, service, publicClient };
  } catch (e) {
    res.status(500).json({ error: e?.message || "Erreur admin" });
    return null;
  }
}

export function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] || 0);
  if (![hh, mm, ss].every(Number.isFinite)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
  return { hh, mm, ss };
}

export function minutesBetweenTimes(start, end) {
  const a = parseHHMM(start);
  const b = parseHHMM(end);
  if (!a || !b) return null;
  const startMin = a.hh * 60 + a.mm;
  const endMin = b.hh * 60 + b.mm;
  const diff = endMin - startMin;
  return diff > 0 ? diff : null;
}

export function hhmmss(value) {
  const p = parseHHMM(value);
  if (!p) return "";
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}:${String(p.ss).padStart(2, "0")}`;
}

export function hhmmFromMinutes(mins) {
  const total = Math.max(0, Number(mins || 0) || 0);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}

export function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}
