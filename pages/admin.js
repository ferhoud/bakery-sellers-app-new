// pages/admin.js
/* Admin page – stable (stop profiles recursion + show totals via RPC)
   - Avoid any .from("profiles") calls in the client
   - Compute names with nameFromId (built from sellers list)
   - Totals use admin_hours_by_range RPC first, then fallback to direct shifts

   + AJUSTEMENTS RETARD / RELAIS (soir)
   - Admin peut saisir l'heure réelle d'arrivée du soir (ex 14:40)
   - L'app applique automatiquement +delta à "celle qui reste" et -delta à "celle du soir"
   - Stocké dans public.shift_handover_adjustments (RLS admin)
*/

import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";

import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";
import WeekNav from "../components/WeekNav";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "../lib/date";
import { fetchShiftTypeVersionsClient, getShiftDurationHoursForDate, getShiftLabelForDate, resolveEffectiveShiftMap } from "@/lib/shift-type-config";

/* ---------- CONSTANTES / UTILS GLOBAUX (SANS HOOKS) ---------- */

import { BUILD_TAG } from "@/lib/version";
if (typeof window !== "undefined") console.log("BUILD_TAG:", BUILD_TAG);

// Heures par créneau (inclut le dimanche spécial)
// ⬇️ PATCH: MIDDAY passe à 7h (avant 6h)
const SHIFT_HOURS = { MORNING: 7, MIDDAY: 7, EVENING: 7, SUNDAY_EXTRA: 4.5 };
// Libellés + créneau dimanche (doit exister dans shift_types)
const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9h-13h30" };

/* Couleurs (fixes + auto pour nouvelles vendeuses) */
const SELLER_COLOR_OVERRIDES = {
  antonia: "#e57373",
  olivia: "#64b5f6",
  colleen: "#81c784",
  ibtissam: "#ba68c8",
  charlene: "#f59e0b", // 🟧 Charlene reste orange
};

const normalize = (s) => String(s || "").trim().toLowerCase();

// Hash stable (sur le nom) → teinte HSL
function hashStr(str) {
  let h = 2166136261; // FNV-like
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function autoColorFromName(name) {
  const key = normalize(name);
  const hue = hashStr(key) % 360; // 0..359
  return hslToHex(hue, 65, 50); // saturé, lisible
}

/** Couleur finale pour affichage */
function colorForName(name) {
  if (!name || name === "-") return "#9e9e9e"; // placeholder vide → gris
  const ovr = SELLER_COLOR_OVERRIDES[normalize(name)];
  return ovr || autoColorFromName(name);
}

// Utils date / libellés
function firstDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function lastDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function monthInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function labelMonthFR(d) {
  return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}
const isSunday = (d) => d.getDay() === 0;
const weekdayFR = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const betweenIso = (iso, start, end) => iso >= start && iso <= end;
const frDate = (iso) => {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR");
  } catch {
    return iso;
  }
};
const isSameISO = (d, iso) => fmtISODate(d) === iso;

/* ---- Retard / relais helpers ---- */
function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}
function fmtDeltaMinutes(mins) {
  if (!Number.isFinite(mins)) return "";
  const sign = mins >= 0 ? "+" : "-";
  const a = Math.abs(mins);
  const h = Math.floor(a / 60);
  const m = a % 60;
  if (h === 0) return `${sign}${m} min`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h${String(m).padStart(2, "0")}`;
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}


// ✅ Compat boundaries legacy (anciens enregistrements)
function canonBoundary(b) {
  return b === "MORNING" ? "MORNING_START" : b === "EVENING" ? "EVENING_START" : b;
}
function boundaryAlternates(canon) {
  if (canon === "MORNING_START") return ["MORNING_START", "MORNING"];
  if (canon === "EVENING_START") return ["EVENING_START", "EVENING"];
  return [canon];
}

/* ---------- PETITS COMPOSANTS SANS HOOKS ---------- */
function Chip({ name }) {
  if (!name || name === "-") return <span className="text-sm text-gray-500">-</span>;
  const bg = colorForName(name);
  return (
    <span
      style={{
        backgroundColor: bg,
        color: "#fff",
        borderRadius: 9999,
        padding: "2px 10px",
        fontSize: "0.8rem",
      }}
    >
      {name}
    </span>
  );
}
const ApproveBtn = ({ onClick, disabled = false, children = "Approuver" }) => (
  <button
    type="button"
    className="btn"
    onClick={onClick}
    disabled={disabled}
    style={{
      backgroundColor: disabled ? "#9ca3af" : "#16a34a",
      color: "#fff",
      borderColor: "transparent",
      opacity: disabled ? 0.7 : 1,
      cursor: disabled ? "not-allowed" : "pointer",
    }}
  >
    {children}
  </button>
);
const RejectBtn = ({ onClick, disabled = false, children = "Refuser" }) => (
  <button
    type="button"
    className="btn"
    onClick={onClick}
    disabled={disabled}
    style={{
      backgroundColor: disabled ? "#9ca3af" : "#dc2626",
      color: "#fff",
      borderColor: "transparent",
      opacity: disabled ? 0.7 : 1,
      cursor: disabled ? "not-allowed" : "pointer",
    }}
  >
    {children}
  </button>
);

const ADMIN_NAV_BUTTON_STYLE = {
  width: "100%",
  minHeight: 52,
  padding: "11px 14px",
  borderRadius: 18,
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: 10,
  position: "relative",
  overflow: "visible",
  whiteSpace: "nowrap",
  fontWeight: 800,
  letterSpacing: "-0.01em",
};

const ADMIN_NAV_ICON_STYLE = {
  width: 28,
  height: 28,
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  background: "rgba(255,255,255,0.12)",
  fontSize: "1rem",
};

const ADMIN_NAV_BADGE_STYLE = {
  position: "absolute",
  top: -6,
  right: -6,
  minWidth: 20,
  height: 20,
  padding: "0 6px",
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 900,
  background: "#dc2626",
  color: "#fff",
  border: "2px solid #fff",
  boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
  lineHeight: "20px",
  zIndex: 20,
};

function AdminNavLink({ href, icon, label, title, badge = null, badgeTitle = "" }) {
  return (
    <Link href={href} legacyBehavior>
      <a className="btn" title={title || label} style={ADMIN_NAV_BUTTON_STYLE}>
        <span aria-hidden="true" style={ADMIN_NAV_ICON_STYLE}>
          {icon}
        </span>
        <span>{label}</span>
        {badge != null ? (
          <span title={badgeTitle || String(badge)} style={ADMIN_NAV_BADGE_STYLE}>
            {badge}
          </span>
        ) : null}
      </a>
    </Link>
  );
}
function shiftHumanLabel(code) {
  return SHIFT_LABELS[code] || code || "-";
}
function fmtMinutesShort(mins) {
  const n = Math.round(Number(mins || 0) || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 min";
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, "0")}`;
}
function checkinTimeLabel(iso) {
  if (!iso) return "--:--";
  try {
    const d = new Date(String(iso));
    if (Number.isNaN(d.getTime())) return "--:--";
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "--:--";
  }
}

/* ---------- PAGE PRINCIPALE (TOUS LES HOOKS ICI) ---------- */
export default function AdminPage() {
  const r = useRouter();
  const { session, profile, loading } = useAuth();

  const supabaseProjectRef = useMemo(() => {
    const u = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    try {
      const host = new URL(u).hostname || "";
      return host.split(".")[0] || "";
    } catch {
      return "";
    }
  }, []);

  // Kill-switch (utile si besoin de couper la page en prod)
  const PANIC = process.env.NEXT_PUBLIC_ADMIN_PANIC === "1";
  if (PANIC) {
    return (
      <>
        <Head>
          <title>Admin – maintenance</title>
        </Head>
        <div style={{ padding: 16 }}>Maintenance en cours… réessayez dans 1 minute.</div>
      </>
    );
  }

  // Sécurité / redirections
  useEffect(() => {
    if (loading) return;
    if (!session) {
      r.replace("/login");
      return;
    }
    if (isAdminEmail(session.user?.email)) return;
    if (profile?.role !== "admin") r.replace("/app");
  }, [session, profile, loading, r]);

  // Semaine affichée
  const [monday, setMonday] = useState(startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(monday, i)), [monday]);

  // Mois pour les totaux (sélecteur en bas)
  const [selectedMonth, setSelectedMonth] = useState(firstDayOfMonth(new Date()));
  const monthFrom = fmtISODate(firstDayOfMonth(selectedMonth));
  const monthTo = fmtISODate(lastDayOfMonth(selectedMonth));

  // Données UI
  const [sellers, setSellers] = useState([]); // [{user_id, full_name}]
  const [assign, setAssign] = useState({}); // "YYYY-MM-DD|SHIFT" -> seller_id
  const [absencesByDate, setAbsencesByDate] = useState({}); // { "YYYY-MM-DD": [seller_id,...] }
  const [absencesToday, setAbsencesToday] = useState([]); // d’aujourd’hui (pending/approved)
  const [pendingAbs, setPendingAbs] = useState([]); // absences à venir (pending)
  const [replList, setReplList] = useState([]); // volontaires (pending) sur absences approuvées
  const [selectedShift, setSelectedShift] = useState({}); // {replacement_interest_id: "MIDDAY"}
  const [latestRepl, setLatestRepl] = useState(null); // bannière: dernier volontariat reçu

  // Congés
  const [pendingLeaves, setPendingLeaves] = useState([]); // congés en attente (à venir ou en cours)
  const [latestLeave, setLatestLeave] = useState(null); // bannière congé la plus récente (pending)
  const [approvedLeaves, setApprovedLeaves] = useState([]); // congés approuvés (end_date >= today)

  // Absences approuvées du mois sélectionné
  const [monthAbsences, setMonthAbsences] = useState([]); // passées/aujourd’hui (items avec id)
  const [monthUpcomingAbsences, setMonthUpcomingAbsences] = useState([]); // à venir (items avec id)

  // Remplacements acceptés du mois (absence_id -> { volunteer_id, shift })
  const [monthAcceptedRepl, setMonthAcceptedRepl] = useState({});

  // Bannière éphémère quand une vendeuse annule son absence (DELETE)
  const [latestCancel, setLatestCancel] = useState(null); // { seller_id, date }

  const [refreshKey, setRefreshKey] = useState(0); // recalcul totaux mois
  const today = new Date();
  const todayIso = fmtISODate(today);
  const [shiftTypeRows, setShiftTypeRows] = useState([]);

  // Refs pour contrôler les reloads
  const reloadInFlight = useRef(false);
  const lastWakeRef = useRef(0);
// UI: Retard / relais (bloc dédié sous le planning)
  const [handoverDate, setHandoverDate] = useState(todayIso);

  const openHandover = useCallback((iso) => {
    setHandoverDate(iso);
    setTimeout(() => {
      const wrap = document.getElementById("handover-day");
      if (wrap?.scrollIntoView) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, []);


// Déconnexion robuste
  const [signingOut, setSigningOut] = useState(false);
  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      if (typeof navigator !== "undefined" && navigator?.clearAppBadge) {
        try {
          await navigator.clearAppBadge();
        } catch {}
      }

      // 1) Supabase signOut
      try {
        await supabase.auth.signOut();
      } catch {}

      // 2) Purge cookies côté serveur (si l’endpoint existe)
      try {
        await fetch("/api/purge-cookies", { method: "POST" });
      } catch {}

      // 3) Nettoyage localStorage/sessionStorage (anti “clignotement” / redirection auto)
      try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k) continue;
          if (k === "LAST_OPEN_PATH" || k === "LAST_OPEN_PATH_SUPERVISOR") keysToRemove.push(k);
          if (k.startsWith("sb-") && k.endsWith("-auth-token")) keysToRemove.push(k); // supabase auth token
        }
        keysToRemove.forEach((k) => {
          try {
            localStorage.removeItem(k);
          } catch {}
        });
      } catch {}

      try {
        sessionStorage.clear();
      } catch {}
    } finally {
      setSigningOut(false);
      // Ajoute ts pour éviter cache/service worker
      r.replace(`/login?stay=1&ts=${Date.now()}`);
    }
  }, [r, signingOut]);


  /* Vendeuses (RPC list_sellers → fallback profiles SANS boucler) */
  const loadSellers = useCallback(async () => {
    let rows = [];
    try {
      const { data, error } = await supabase.rpc("list_sellers");
      if (!error && Array.isArray(data) && data.length) rows = data;
    } catch {}
    if (rows.length === 0) {
      // On tente profiles une seule fois, silencieusement
      try {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, full_name, role, active")
          .eq("role", "seller");
        if (Array.isArray(profs) && profs.length) {
          rows = profs.map(({ user_id, full_name }) => ({ user_id, full_name }));
        }
      } catch {}
    }
    // Tri stable par nom pour éviter le "shuffle" visuel
    if (rows && rows.length) {
      rows.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "fr", { sensitivity: "base" }));
    }
    setSellers(rows || []);
  }, []);

  /* ✅ Index vendeuses + helper id→nom */
  const sellersById = useMemo(() => new Map((sellers || []).map((s) => [s.user_id, s])), [sellers]);
  const nameFromId = useCallback(
    (id) => {
      if (!id) return "";
      const s = sellersById.get(id);
      return s?.full_name || "";
    },
    [sellersById]
  );

  const loadShiftTypeVersions = useCallback(async () => {
    try {
      const { data } = await fetchShiftTypeVersionsClient(supabase);
      setShiftTypeRows(Array.isArray(data) ? data : []);
    } catch (e) {
      console.warn("loadShiftTypeVersions error:", e?.message || e);
      setShiftTypeRows([]);
    }
  }, []);

  /* ======= VALIDATION HEURES MENSUELLES (badge + accès rapide) ======= */
  const [mhPendingCount, setMhPendingCount] = useState(null); // admin_status=pending (mois sélectionné)
  const [mhToReviewCount, setMhToReviewCount] = useState(null); // seller_status=accepted/disputed + admin_status=pending (mois sélectionné)
  const [mhToReviewTotal, setMhToReviewTotal] = useState(null); // ✅ total à traiter (tous mois)
  const [mhLatestRows, setMhLatestRows] = useState([]);

  const loadMonthlyHoursStats = useCallback(async () => {
    try {
      // 1) Total "admin à traiter" (mois sélectionné) quelle que soit la réponse vendeuse
      const { count, error } = await supabase
        .from("monthly_hours_attestations")
        .select("id", { count: "exact", head: true })
        .eq("month_start", monthFrom)
        .eq("admin_status", "pending");
      if (error) throw error;
      setMhPendingCount(count ?? 0);

      // 2) "À traiter" au sens strict (mois sélectionné): la vendeuse a répondu (validé ou corrigé)
      const { count: c2, error: e2 } = await supabase
        .from("monthly_hours_attestations")
        .select("id", { count: "exact", head: true })
        .eq("month_start", monthFrom)
        .eq("admin_status", "pending")
        .in("seller_status", ["accepted", "disputed"]);
      if (e2) throw e2;
      setMhToReviewCount(c2 ?? 0);

      // ✅ 2bis) Total global "à traiter" (tous mois) pour badge bouton
      const { count: cAll, error: eAll } = await supabase
        .from("monthly_hours_attestations")
        .select("id", { count: "exact", head: true })
        .eq("admin_status", "pending")
        .in("seller_status", ["accepted", "disputed"]);
      if (eAll) throw eAll;
      setMhToReviewTotal(cAll ?? 0);

      // 3) Petit aperçu (5 dernières du mois sélectionné)
      const { data, error: e3 } = await supabase
        .from("monthly_hours_attestations")
        .select("id, seller_id, seller_status, computed_hours, seller_correction_hours, updated_at")
        .eq("month_start", monthFrom)
        .eq("admin_status", "pending")
        .order("updated_at", { ascending: false })
        .limit(5);
      if (e3) throw e3;
      setMhLatestRows(data || []);
    } catch (e) {
      console.warn("loadMonthlyHoursStats error:", e?.message || e);
      setMhPendingCount(null);
      setMhToReviewCount(null);
      setMhToReviewTotal(null);
      setMhLatestRows([]);
    }
  }, [monthFrom]);

  // Chargement initial + changement de mois
  useEffect(() => {
    if (loading) return;
    if (!session) return;
    loadMonthlyHoursStats();
  }, [loading, session, loadMonthlyHoursStats]);

  // Realtime: dès qu’une vendeuse valide/corrige, l’admin voit le compteur bouger
  useEffect(() => {
    if (!session) return;
    const ch = supabase
      .channel("mh_attestations_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "monthly_hours_attestations" }, () => {
        loadMonthlyHoursStats();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [session, loadMonthlyHoursStats]);

  /* Planning semaine (avec fallback direct sur table shifts) */
  const loadWeekAssignments = useCallback(async (fromIso, toIso) => {
    let data = null,
      error = null;
    try {
      const res = await supabase.from("view_week_assignments").select("*").gte("date", fromIso).lte("date", toIso);
      data = res.data;
      error = res.error;
    } catch (e) {
      error = e;
    }
    if (error) console.warn("view_week_assignments error, fallback to shifts:", error);
    if (!data || data.length === 0) {
      const res2 = await supabase.from("shifts").select("date, shift_code, seller_id").gte("date", fromIso).lte("date", toIso);
      data = res2.data || [];
    }
    const next = {};
    (data || []).forEach((row) => {
      next[`${row.date}|${row.shift_code}`] = row.seller_id;
    });
    setAssign(next);
  }, []);
  useEffect(() => {
    const from = fmtISODate(days[0]);
    const to = fmtISODate(days[6]);
    loadWeekAssignments(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monday]);

  /* ✅ Inline ABSENCES (admin) pour chaque jour de la semaine */
  const loadWeekAbsences = useCallback(async () => {
    const from = fmtISODate(days[0]);
    const to = fmtISODate(days[6]);

    try {
      const { data, error } = await supabase.rpc("admin_absences_by_range", { p_from: from, p_to: to });
      if (!error && Array.isArray(data)) {
        const grouped = {};
        (data || []).forEach((r) => {
          if (!grouped[r.date]) grouped[r.date] = [];
          if (!grouped[r.date].includes(r.seller_id)) grouped[r.date].push(r.seller_id);
        });
        setAbsencesByDate(grouped);
        return;
      }
      console.warn("admin_absences_by_range KO -> fallback", error);
    } catch (e) {
      console.warn("admin_absences_by_range threw -> fallback", e);
    }

    const { data, error } = await supabase
      .from("absences")
      .select("date, seller_id, status")
      .gte("date", from)
      .lte("date", to)
      .in("status", ["approved", "pending"]);
    if (error) {
      console.error("loadWeekAbsences error:", error);
      return;
    }
    const grouped = {};
    (data || []).forEach((r) => {
      if (!grouped[r.date]) grouped[r.date] = [];
      if (!grouped[r.date].includes(r.seller_id)) grouped[r.date].push(r.seller_id);
    });
    setAbsencesByDate(grouped);
  }, [days]);

/* ======= RETARD / RELAIS (matin + soir) ======= */
const [handoverByKey, setHandoverByKey] = useState({}); // { "YYYY-MM-DD|BOUNDARY": row }
const [handoverEdit, setHandoverEdit] = useState({}); // { "YYYY-MM-DD|BOUNDARY": { planned_time, actual_time, stayed_seller_id, arrived_seller_id } }

const loadWeekHandovers = useCallback(async () => {
  const from = fmtISODate(days[0]);
  const to = fmtISODate(days[6]);

  try {
    const { data, error } = await supabase
      .from("shift_handover_adjustments")
      .select("id, date, boundary, planned_time, actual_time, stayed_seller_id, arrived_seller_id, created_at")
      .in("boundary", ["MORNING_START", "EVENING_START", "MORNING", "EVENING"])
      .gte("date", from)
      .lte("date", to);

    if (error) {
      // si la table n'existe pas encore, on ignore sans casser l'UI
      console.warn("loadWeekHandovers error:", error?.message || error);
      setHandoverByKey({});
      return;
    }
    const map = {};
    (data || []).forEach((r) => {
      const c = canonBoundary(r.boundary);
      const key = `${r.date}|${c}`;
      const isCanon = r.boundary === c;
      const prev = map[key];
      // Préfère *_START si doublon
      if (!prev || (isCanon && prev?._orig_boundary !== c)) {
        map[key] = { ...r, boundary: c, _orig_boundary: r.boundary };
      }
    });
    setHandoverByKey(map);
  } catch (e) {
    console.warn("loadWeekHandovers exception:", e?.message || e);
    setHandoverByKey({});
  }
}, [days]);

const saveHandover = useCallback(
  async (iso, boundary) => {
    const morningId = assign[`${iso}|MORNING`] || "";
    const middayId = assign[`${iso}|MIDDAY`] || "";
    const eveningId = assign[`${iso}|EVENING`] || "";

    const isMorning = boundary === "MORNING_START";
    const defaultPlanned = isMorning ? "06:30" : "13:30";
    const defaultStayed = ""; // retard simple par défaut (aucune vendeuse "restée")
    const defaultArrived = isMorning ? (morningId || "") : (eveningId || "");

    const key = `${iso}|${boundary}`;
    const cur = handoverEdit[key] || {};
    const planned_time = (cur.planned_time || defaultPlanned).trim();
    const actual_time = (cur.actual_time || "").trim();
    const stayed_seller_id = cur.stayed_seller_id ?? defaultStayed; // optionnel ("" => null)
    const arrived_seller_id = cur.arrived_seller_id ?? defaultArrived;

    const pMin = parseHHMM(planned_time);
    const aMin = parseHHMM(actual_time);

    if (pMin == null) {
      alert("Heure prévue invalide. Exemple: 06:30 ou 13:30");
      return;
    }
    if (aMin == null) {
      alert("Heure réelle invalide. Exemple: 06:40 ou 14:40");
      return;
    }
    if (!arrived_seller_id) {
      alert("Choisis la vendeuse concernée (celle qui arrive).");
      return;
    }
    if (stayed_seller_id && stayed_seller_id === arrived_seller_id) {
      alert("La vendeuse 'qui a couvert' et la vendeuse concernée ne peuvent pas être la même.");
      return;
    }

    // delta sécurité (évite des saisies absurdes)
    const deltaMin = clamp(aMin - pMin, -360, 360); // -6h .. +6h
    const safeActual = (() => {
      const mins = pMin + deltaMin;
      const hh = String(Math.floor(mins / 60)).padStart(2, "0");
      const mm = String(mins % 60).padStart(2, "0");
      return `${hh}:${mm}`;
    })();

    try {
      const payload = {
        date: iso,
        boundary,
        planned_time,
        actual_time: safeActual,
        stayed_seller_id: stayed_seller_id ? stayed_seller_id : null,
        arrived_seller_id,
      };

      const { error } = await supabase.from("shift_handover_adjustments").upsert(payload, { onConflict: "date,boundary" });
      if (error) {
        console.error("saveHandover error:", error);
        alert(`Impossible d'enregistrer l'ajustement. (${error.code || "?"}) ${error.message || ""}`);
        return;
      }


      // ✅ Nettoyage legacy : évite les doublons si des anciens enregistrements existent (MORNING/EVENING)
      try {
        const legacy = boundary === "MORNING_START" ? "MORNING" : boundary === "EVENING_START" ? "EVENING" : null;
        if (legacy) {
          await supabase.from("shift_handover_adjustments").delete().eq("date", iso).eq("boundary", legacy);
        }
      } catch (_) {}

      // Nettoie le draft local de ce jour/créneau
      setHandoverEdit((prev) => {
        const n = { ...prev };
        delete n[key];
        return n;
      });

      await loadWeekHandovers();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      console.error("saveHandover exception:", e);
      alert("Impossible d'enregistrer l'ajustement (exception).");
    }
  },
  [assign, handoverEdit, loadWeekHandovers]
);

const deleteHandover = useCallback(
  async (iso, boundary) => {
    try {
      const { error } = await supabase
        .from("shift_handover_adjustments")
        .delete()
        .eq("date", iso)
        .in("boundary", boundaryAlternates(boundary));
      if (error) {
        console.error("deleteHandover error:", error);
        alert(`Impossible de supprimer l'ajustement. (${error.code || "?"}) ${error.message || ""}`);
        return;
      }

      const key = `${iso}|${boundary}`;
      setHandoverEdit((prev) => {
        const n = { ...prev };
        delete n[key];
        return n;
      });

      await loadWeekHandovers();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      console.error("deleteHandover exception:", e);
      alert("Impossible de supprimer l'ajustement (exception).");
    }
  },
  [loadWeekHandovers]
);


  /* Absences d'aujourd'hui (avec remplacement accepté si existe) */
  const loadAbsencesToday = useCallback(async () => {
    const { data: abs, error } = await supabase
      .from("absences")
      .select("id, seller_id, status, reason, date")
      .eq("date", todayIso)
      .in("status", ["pending", "approved"]);
    if (error) console.error("absences today error:", error);

    const ids = (abs || []).map((a) => a.id);
    let mapRepl = {};
    if (ids.length > 0) {
      const { data: repl } = await supabase
        .from("replacement_interest")
        .select("absence_id, volunteer_id, status")
        .in("absence_id", ids)
        .eq("status", "accepted");
      (repl || []).forEach((r) => {
        mapRepl[r.absence_id] = { volunteer_id: r.volunteer_id };
      });
    }

    const rows = (abs || []).map((a) => ({ ...a, replacement: mapRepl[a.id] || null }));
    setAbsencesToday(rows);
  }, [todayIso]);

  /* Absences en attente (toutes à venir) */
  const loadPendingAbs = useCallback(async () => {
    const { data, error } = await supabase
      .from("absences")
      .select("id, seller_id, date, reason, status")
      .gte("date", todayIso)
      .eq("status", "pending")
      .order("date", { ascending: true });
    if (error) console.error("pending absences error:", error);
    setPendingAbs(data || []);
  }, [todayIso]);

  /* Volontaires (absences approuvées) – sans lecture de profiles */
  const loadReplacements = useCallback(async () => {
    try {
      const { data: rows, error } = await supabase
        .from("replacement_interest")
        .select(
          `
          id,
          status,
          volunteer_id,
          absence_id,
          absences:absences!replacement_interest_absence_id_fkey(
            id,
            date,
            seller_id,
            status
          )
        `
        )
        .eq("status", "pending")
        .eq("absences.status", "approved")
        .gte("absences.date", todayIso);
      if (error) {
        console.error("replacement list error:", error);
        setReplList([]);
        return;
      }

      const sorted = (rows || []).slice().sort((a, b) => {
        const da = a?.absences?.date || "";
        const db = b?.absences?.date || "";
        return da.localeCompare(db);
      });

      const list = sorted.map((r) => ({
        id: r.id,
        volunteer_id: r.volunteer_id,
        absence_id: r.absence_id,
        date: r.absences?.date,
        absent_id: r.absences?.seller_id,
        status: r.status,
      }));
      setReplList(list);
    } catch (e) {
      console.error("replacement list error (catch):", e);
      setReplList([]);
    }
  }, [todayIso]);

  /* ======= CONGÉS — un seul fetch ======= */
  const loadLeavesUnified = useCallback(async () => {
    const { data, error } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, reason, status, created_at")
      .gte("end_date", todayIso)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("leaves unified error:", error);
      setPendingLeaves([]);
      setApprovedLeaves([]);
      setLatestLeave(null);
      return;
    }

    const pending = [];
    const approved = [];
    for (const l of data || []) {
      if (l.status === "pending") pending.push(l);
      else if (l.status === "approved") approved.push(l);
    }
    setPendingLeaves(pending);
    setApprovedLeaves(approved);
    setLatestLeave(pending.length ? pending[0] : null);
  }, [todayIso]);

  // Actions congés
  const approveLeave = useCallback(
    async (id) => {
      const { error } = await supabase.from("leaves").update({ status: "approved" }).eq("id", id);
      if (error) {
        alert("Impossible d'approuver (RLS ?)");
        return;
      }
      await loadLeavesUnified();
    },
    [loadLeavesUnified]
  );

  const rejectLeave = useCallback(
    async (id) => {
      const { error } = await supabase.from("leaves").update({ status: "rejected" }).eq("id", id);
      if (error) {
        alert("Impossible de rejeter (RLS ?)");
        return;
      }
      await loadLeavesUnified();
    },
    [loadLeavesUnified]
  );

  const cancelFutureLeave = useCallback(
    async (id) => {
      const { data: leave } = await supabase.from("leaves").select("start_date,status").eq("id", id).single();
      if (!leave) {
        alert("Congé introuvable.");
        return;
      }
      if (!(leave.status === "approved" || leave.status === "pending")) {
        alert("Seuls les congés approuvés/en attente peuvent être annulés.");
        return;
      }
      const tIso = fmtISODate(new Date());
      if (!(leave.start_date > tIso)) {
        alert("On ne peut annuler que les congés à venir.");
        return;
      }

      const { error } = await supabase.from("leaves").delete().eq("id", id);
      if (error) {
        console.error(error);
        alert("Échec de l’annulation du congé.");
        return;
      }

      await loadLeavesUnified();
      alert("Congé à venir annulé. La vendeuse peut refaire une demande.");
    },
    [loadLeavesUnified]
  );

  /* ======= ABSENCES DU MOIS (APPROUVÉES) ======= */
  const loadMonthAbsences = useCallback(async () => {
    const tIso = fmtISODate(new Date());
    try {
      const { data, error } = await supabase.rpc("admin_absences_by_range", { p_from: monthFrom, p_to: monthTo });
      if (!error && Array.isArray(data)) {
        const seen = new Set();
        const pastOrToday = [];
        (data || [])
          .filter((r) => r.status === "approved" && r.date <= tIso)
          .forEach((r) => {
            const key = `${r.seller_id}|${r.date}`;
            if (!seen.has(key)) {
              seen.add(key);
              pastOrToday.push(r);
            }
          });
        setMonthAbsences(pastOrToday);
        return;
      }
      console.warn("admin_absences_by_range (month) KO -> fallback", error);
    } catch (e) {
      console.warn("admin_absences_by_range (month) threw -> fallback", e);
    }

    const { data, error } = await supabase
      .from("absences")
      .select("id, seller_id, date, status")
      .eq("status", "approved")
      .gte("date", monthFrom)
      .lte("date", monthTo)
      .lte("date", tIso);
    if (error) console.error("month absences error:", error);

    const seen = new Set();
    const uniq = [];
    (data || []).forEach((r) => {
      const key = `${r.seller_id}|${r.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push(r);
      }
    });
    setMonthAbsences(uniq);
  }, [monthFrom, monthTo]);

  const loadMonthUpcomingAbsences = useCallback(async () => {
    const tIso = fmtISODate(new Date());
    try {
      const { data, error } = await supabase.rpc("admin_absences_by_range", { p_from: monthFrom, p_to: monthTo });
      if (!error && Array.isArray(data)) {
        const seen = new Set();
        const future = [];
        (data || [])
          .filter((r) => r.status === "approved" && r.date > tIso)
          .forEach((r) => {
            const key = `${r.seller_id}|${r.date}`;
            if (!seen.has(key)) {
              seen.add(key);
              future.push(r);
            }
          });
        setMonthUpcomingAbsences(future);
        return;
      }
      console.warn("admin_absences_by_range (upcoming) KO -> fallback", error);
    } catch (e) {
      console.warn("admin_absences_by_range (upcoming) threw -> fallback", e);
    }

    const { data, error } = await supabase
      .from("absences")
      .select("id, seller_id, date, status")
      .eq("status", "approved")
      .gte("date", monthFrom)
      .lte("date", monthTo)
      .gt("date", tIso);
    if (error) console.error("month upcoming absences error:", error);

    const seen = new Set();
    const uniq = [];
    (data || []).forEach((r) => {
      const key = `${r.seller_id}|${r.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push(r);
      }
    });
    setMonthUpcomingAbsences(uniq);
  }, [monthFrom, monthTo]);

  // Remplacements acceptés du mois (pas de fetch profiles)
  const loadMonthAcceptedRepl = useCallback(async () => {
    const ids = [...(monthAbsences || []).map((a) => a.id), ...(monthUpcomingAbsences || []).map((a) => a.id)];
    const uniq = Array.from(new Set(ids)).filter(Boolean);
    if (uniq.length === 0) {
      setMonthAcceptedRepl({});
      return;
    }

    const { data: rows, error } = await supabase
      .from("replacement_interest")
      .select("absence_id, volunteer_id, accepted_shift_code")
      .in("absence_id", uniq)
      .eq("status", "accepted");
    if (error) console.error("month accepted repl error:", error);

    const map = {};
    (rows || []).forEach((r) => {
      map[r.absence_id] = {
        volunteer_id: r.volunteer_id,
        shift: r.accepted_shift_code || null,
      };
    });
    setMonthAcceptedRepl(map);
  }, [monthAbsences, monthUpcomingAbsences]);

  // Déclencheurs init
  useEffect(() => {
    loadLeavesUnified();
  }, [todayIso, loadLeavesUnified]);
  useEffect(() => {
    loadMonthAbsences();
    loadMonthUpcomingAbsences();
  }, [monthFrom, monthTo, loadMonthAbsences, loadMonthUpcomingAbsences]);
  useEffect(() => {
    loadMonthAcceptedRepl();
  }, [loadMonthAcceptedRepl]);

  /* Realtime : absences + replacement + leaves (sans fetch profiles) */
  useEffect(() => {
    const chAbs = supabase
      .channel("absences_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "absences" }, () => {
        loadPendingAbs();
        loadAbsencesToday();
        loadMonthAbsences();
        loadMonthUpcomingAbsences();
      })
      .subscribe();

    const chRepl = supabase
      .channel("replacement_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "replacement_interest" }, async (payload) => {
        if (payload.eventType === "INSERT") {
          const rr = payload.new;
          const { data: abs } = await supabase.from("absences").select("date, seller_id, status").eq("id", rr.absence_id).single();
          // ✅ Ne pas notifier si l'absence n'est pas APPROUVÉE
          if (!abs || abs.status !== "approved") {
            return;
          }
          setLatestRepl({
            id: rr.id,
            volunteer_id: rr.volunteer_id,
            absence_id: rr.absence_id,
            date: abs?.date,
            absent_id: abs?.seller_id,
            status: rr.status,
          });
        }
        loadReplacements();
        loadMonthAcceptedRepl();
      })
      .subscribe();

    const chLeaves = supabase
      .channel("leaves_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "leaves" }, async () => {
        await loadLeavesUnified();
      })
      .subscribe();

    // Bannière quand une absence est supprimée par une vendeuse
    const chCancel = supabase
      .channel("absences_delete_banner")
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "absences" }, async (payload) => {
        const old = payload?.old;
        if (!old?.seller_id || !old?.date) return;
        setLatestCancel({ seller_id: old.seller_id, date: old.date }); // plus de fetch profile
        setTimeout(() => setLatestCancel(null), 5000);
      })
      .subscribe();

    // Retard / relais realtime (optionnel)
    const chHandover = supabase
      .channel("handover_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "shift_handover_adjustments" }, () => {
        loadWeekHandovers();
        setRefreshKey((k) => k + 1);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(chAbs);
      supabase.removeChannel(chRepl);
      supabase.removeChannel(chLeaves);
      supabase.removeChannel(chCancel);
      supabase.removeChannel(chHandover);
    };
  }, [
    todayIso,
    loadPendingAbs,
    loadAbsencesToday,
    loadMonthAbsences,
    loadMonthUpcomingAbsences,
    loadMonthAcceptedRepl,
    loadReplacements,
    loadLeavesUnified,
    loadWeekHandovers,
  ]);

  /* Sauvegarde d'une affectation */
  const save = useCallback(async (iso, code, seller_id) => {
    const key = `${iso}|${code}`;
    setAssign((prev) => ({ ...prev, [key]: seller_id || null })); // Optimistic UI
    const { error } = await supabase.rpc("admin_upsert_shift", { p_date: iso, p_code: code, p_seller: seller_id || null });
    if (error) {
      console.error("admin_upsert_shift error:", error);
      alert(error.message || "Échec de sauvegarde du planning");
      return;
    }
    setRefreshKey((k) => k + 1);
  }, []);

  /* Copier la semaine -> semaine suivante */
  const copyWeekToNext = useCallback(async () => {
    if (
      !window.confirm(
        "Copier le planning de la semaine affichée vers la semaine prochaine ? Cela remplacera les affectations déjà présentes la semaine suivante."
      )
    )
      return;
    const shiftCodes = ["MORNING", "MIDDAY", "EVENING", "SUNDAY_EXTRA"];
    const rows = [];
    days.forEach((d) => {
      const iso = fmtISODate(d);
      const nextIso = fmtISODate(addDays(d, 7));
      shiftCodes.forEach((code) => {
        const sellerId = assign[`${iso}|${code}`];
        if (sellerId) rows.push({ date: nextIso, shift_code: code, seller_id: sellerId });
      });
    });
    if (rows.length === 0) {
      alert("Aucune affectation à copier cette semaine.");
      return;
    }
    const { error } = await supabase.from("shifts").upsert(rows, { onConflict: "date,shift_code" }).select("date");
    if (error) {
      console.error(error);
      alert("La copie a échoué.");
      return;
    }
    setMonday(addDays(monday, 7));
    setRefreshKey((k) => k + 1);
    alert("Planning copié vers la semaine prochaine.");
  }, [days, assign, monday]);

  /* Actions absence */
  const approveAbs = useCallback(
    async (id) => {
      const { error } = await supabase.from("absences").update({ status: "approved" }).eq("id", id);
      if (error) {
        alert("Impossible d'approuver (RLS ?)");
        return;
      }
      await loadPendingAbs();
      await loadAbsencesToday();
      await loadMonthAbsences();
      await loadMonthUpcomingAbsences();
      await loadMonthAcceptedRepl();
    },
    [loadPendingAbs, loadAbsencesToday, loadMonthAbsences, loadMonthUpcomingAbsences, loadMonthAcceptedRepl]
  );

  const rejectAbs = useCallback(
    async (id) => {
      const { error } = await supabase.from("absences").update({ status: "rejected" }).eq("id", id);
      if (error) {
        alert("Impossible de rejeter (RLS ?)");
        return;
      }
      await loadPendingAbs();
      await loadAbsencesToday();
      await loadMonthAbsences();
      await loadMonthUpcomingAbsences();
      await loadMonthAcceptedRepl();
    },
    [loadPendingAbs, loadAbsencesToday, loadMonthAbsences, loadMonthUpcomingAbsences, loadMonthAcceptedRepl]
  );

  /* ✅ Admin: marquer une vendeuse "absente" pour un jour donné — via RPC */
  const setSellerAbsent = useCallback(
    async (iso, sellerId) => {
      try {
        const { error } = await supabase.rpc("admin_mark_absent", {
          p_seller: sellerId,
          p_date: iso,
          p_reason: "Marquée absente par l’admin",
        });
        if (error) {
          console.error("admin_mark_absent error:", error);
          alert("Impossible d’indiquer l’absence.");
          return;
        }

        await Promise.all([loadWeekAbsences(), loadAbsencesToday(), loadMonthAbsences(), loadMonthUpcomingAbsences()]);
        setRefreshKey((k) => k + 1);
      } catch (e) {
        console.error("setSellerAbsent exception:", e);
        alert("Impossible d’indiquer l’absence.");
      }
    },
    [loadWeekAbsences, loadAbsencesToday, loadMonthAbsences, loadMonthUpcomingAbsences]
  );

  /* ✅ Admin: supprimer l'état "absent" d'une vendeuse pour un jour donné — via RPC */
  const removeSellerAbsent = useCallback(
    async (iso, sellerId) => {
      try {
        const { error } = await supabase.rpc("admin_unmark_absent", {
          p_seller: sellerId,
          p_date: iso,
        });
        if (error) {
          console.error("admin_unmark_absent error:", error);
          alert("Suppression impossible.");
          return;
        }
        await Promise.all([loadWeekAbsences(), loadAbsencesToday(), loadReplacements(), loadMonthAbsences(), loadMonthUpcomingAbsences()]);
        setRefreshKey((k) => k + 1);
      } catch (e) {
        console.error("removeSellerAbsent exception:", e);
        alert("Suppression impossible.");
      }
    },
    [loadWeekAbsences, loadAbsencesToday, loadReplacements, loadMonthAbsences, loadMonthUpcomingAbsences]
  );

  /* ✅ Volontaires: approuver/refuser */
  const assignVolunteer = useCallback(
    async (item) => {
      // item: { id, volunteer_id, absence_id, date, absent_id, status }
      const shiftCode = selectedShift[item.id] || null; // optionnel
      const { error } = await supabase
        .from("replacement_interest")
        .update({ status: "accepted", accepted_shift_code: shiftCode })
        .eq("id", item.id);
      if (error) {
        alert("Échec d’approbation du remplacement.");
        return;
      }
      setSelectedShift((prev) => {
        const n = { ...prev };
        delete n[item.id];
        return n;
      });
      setLatestRepl(null);
      await Promise.all([loadReplacements(), loadAbsencesToday(), loadMonthAcceptedRepl()]);
    },
    [selectedShift, loadReplacements, loadAbsencesToday, loadMonthAcceptedRepl]
  );

  const declineVolunteer = useCallback(
    async (id) => {
      const { error } = await supabase.from("replacement_interest").update({ status: "rejected", accepted_shift_code: null }).eq("id", id);
      if (error) {
        alert("Échec du refus.");
        return;
      }
      setSelectedShift((prev) => {
        const n = { ...prev };
        delete n[id];
        return n;
      });
      await loadReplacements();
    },
    [loadReplacements]
  );

  /* 🔔 BADGE + REFRESH AUTO (badge seulement) */
  useEffect(() => {
    const mhApp = mhToReviewTotal ?? mhToReviewCount ?? 0;
    const count = (pendingAbs?.length || 0) + (pendingLeaves?.length || 0) + (replList?.length || 0) + (mhApp || 0);

    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (!nav) return;
    if (count > 0 && nav.setAppBadge) nav.setAppBadge(count).catch(() => {});
    else if (nav?.clearAppBadge) nav.clearAppBadge().catch(() => {});
  }, [pendingAbs?.length, pendingLeaves?.length, replList?.length, mhToReviewTotal, mhToReviewCount]);

  /* ---- RELOAD ALL (central) ---- */
  const reloadAll = useCallback(async () => {
    if (reloadInFlight.current) return;
    reloadInFlight.current = true;
    try {
      // 1) D'abord les vendeuses — c'est la clé pour les totaux
      await loadSellers();
      // 2) Ensuite le reste, en parallèle
      await Promise.all([
        loadWeekAssignments(fmtISODate(days[0]), fmtISODate(days[6])),
        loadWeekAbsences(),
        loadWeekHandovers(),
        loadPendingAbs?.(),
        loadAbsencesToday?.(),
        loadReplacements?.(),
        loadLeavesUnified?.(),
        loadShiftTypeVersions?.(),
        loadMonthAbsences?.(),
        loadMonthUpcomingAbsences?.(),
        loadMonthAcceptedRepl?.(),
        loadMonthlyHoursStats?.(),
      ]);
      // PAS de setRefreshKey ici → évite les recalculs inutiles
    } finally {
      reloadInFlight.current = false;
    }
  }, [
    days,
    loadSellers,
    loadWeekAssignments,
    loadWeekAbsences,
    loadWeekHandovers,
    loadPendingAbs,
    loadAbsencesToday,
    loadReplacements,
    loadLeavesUnified,
    loadShiftTypeVersions,
    loadMonthAbsences,
    loadMonthUpcomingAbsences,
    loadMonthAcceptedRepl,
    loadMonthlyHoursStats,
  ]);

  // Initial load
  useEffect(() => {
    if (!loading && session) reloadAll();
  }, [loading, session, reloadAll]);

  // Recharge quand l’app revient au premier plan (throttle)
  useEffect(() => {
    const onWake = () => {
      const now = Date.now();
      if (now - lastWakeRef.current < 1000) return; // ignore réveils multiples dans 1s
      lastWakeRef.current = now;
      setTimeout(() => reloadAll(), 80);
    };
    window.addEventListener("focus", onWake, { passive: true });
    document.addEventListener("visibilitychange", onWake, { passive: true });
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [reloadAll]);

  // SW push → reload
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (e) => {
      if (e?.data?.type === "push") reloadAll();
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [reloadAll]);

  /* 🔔 Notifications admin: auto (sans bouton)
     - Les navigateurs bloquent la demande d'autorisation sans geste utilisateur.
     - Donc:
       1) si permission déjà accordée → on tente de finaliser la souscription
       2) si permission "default" → on demande à la 1ère interaction (un clic suffit)
       3) si pas de souscription → on envoie vers /push-setup (throttlé)
  */
  const ensureAdminPush = useCallback(
    async ({ allowPrompt } = { allowPrompt: false }) => {
      try {
        if (typeof window === "undefined") return;
        if (!session) return;
        if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return;

        const base = supabaseProjectRef || "default";
        const doneKey = `admin_push_setup_done_${base}`;
        const attemptKey = `admin_push_setup_attempt_${base}`;

        if (window.localStorage?.getItem(doneKey) === "1") return;

        let perm = Notification.permission;
        if (perm === "default" && allowPrompt) {
          try {
            perm = await Notification.requestPermission();
          } catch {
            perm = Notification.permission;
          }
        }

        if (perm !== "granted") return;

        // Vérifie si on a déjà une souscription push côté navigateur
        let reg = await navigator.serviceWorker.getRegistration();
        if (!reg) {
          try {
            reg = await navigator.serviceWorker.ready;
          } catch {
            reg = null;
          }
        }

        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            window.localStorage?.setItem(doneKey, "1");
            window.localStorage?.removeItem(attemptKey);
            return;
          }
        }

        // Pas de souscription: on laisse /push-setup faire le boulot (1 tentative toutes les 6h)
        const last = Number(window.localStorage?.getItem(attemptKey) || "0");
        if (Date.now() - last < 6 * 60 * 60 * 1000) return;

        window.localStorage?.setItem(attemptKey, String(Date.now()));
        window.location.href = "/push-setup?next=/admin&auto=1";
      } catch {
        // silence
      }
    },
    [session, supabaseProjectRef]
  );

  // Tentative silencieuse si déjà autorisé
  useEffect(() => {
    if (!session) return;
    ensureAdminPush({ allowPrompt: false });
  }, [session, ensureAdminPush]);

  // Demande l'autorisation à la 1ère interaction si besoin (sans bouton)
  useEffect(() => {
    if (!session) return;
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "default") return;

    const onFirst = () => ensureAdminPush({ allowPrompt: true });
    window.addEventListener("pointerdown", onFirst, { once: true });
    return () => window.removeEventListener("pointerdown", onFirst);
  }, [session, ensureAdminPush]);


  // Recalc & refresh when "days" or data loaders change (pass from/to)
  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      await Promise.all([loadSellers(), loadWeekAssignments(fmtISODate(days[0]), fmtISODate(days[6])), loadWeekHandovers(), loadShiftTypeVersions()]);
      if (isMounted) setRefreshKey((k) => k + 1);
    };
    run();
    return () => {
      isMounted = false;
    };
  }, [days, loadSellers, loadWeekAssignments, loadWeekHandovers, loadShiftTypeVersions]);


  // Pointages manquants : alerte admin + résolution (absente ou heure réelle d'arrivée)
  const [missingCheckinsCount, setMissingCheckinsCount] = useState(0);
  const [missingCheckinAlerts, setMissingCheckinAlerts] = useState([]);
  const [missingCheckinModes, setMissingCheckinModes] = useState({});
  const [missingCheckinTimes, setMissingCheckinTimes] = useState({});
  const [missingCheckinBusy, setMissingCheckinBusy] = useState({});
  const [missingCheckinErr, setMissingCheckinErr] = useState("");

  // Retard pointage confirmé du soir : l'admin choisit qui a couvert, puis on ajoute ces minutes en travail en plus.
  const [coverageAlerts, setCoverageAlerts] = useState([]);
  const [coverageChoices, setCoverageChoices] = useState({});
  const [coverageBusy, setCoverageBusy] = useState({});
  const [coverageErr, setCoverageErr] = useState("");

  // Notifications UI (évite de spammer)
  const lastMissingCheckinsNotifiedRef = useRef({ ids: "", ts: 0 });
  const lastCoverageNotifiedRef = useRef({ ids: "", ts: 0 });

  const loadMissingCheckinsCount = useCallback(async () => {
    // Nouveau flux : on charge les alertes actionnables, pas seulement un compteur.
    // Une alerte reste visible jusqu'à ce qu'elle soit traitée (absence ou pointage manuel).
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) {
        setMissingCheckinAlerts([]);
        setMissingCheckinsCount(0);
        return;
      }

      const qs = new URLSearchParams({ day: todayIso });
      const r = await fetch(`/api/admin/checkins/missing-resolution?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (!r.ok) {
        // Si la route n'est pas encore déployée sur un environnement, on ne casse pas l'admin.
        setMissingCheckinAlerts([]);
        setMissingCheckinsCount(0);
        return;
      }

      const j = await r.json().catch(() => ({}));
      const items = Array.isArray(j?.items) ? j.items : [];

      setMissingCheckinAlerts(items);
      setMissingCheckinsCount(items.length);
      setMissingCheckinErr("");

      setMissingCheckinTimes((prev) => {
        const next = { ...(prev || {}) };
        for (const it of items) {
          const id = String(it?.id || it?.alert_id || "");
          if (!id || next[id]) continue;
          next[id] = String(it?.planned_time || "");
        }
        return next;
      });
    } catch {
      setMissingCheckinAlerts([]);
      setMissingCheckinsCount(0);
    }
  }, [todayIso]);

  const coverageDismissKey = useCallback((day) => `dismissed_late_coverage_${day || todayIso}`, [todayIso]);

  const getDismissedCoverageIds = useCallback(
    (day) => {
      if (typeof window === "undefined") return new Set();
      try {
        const raw = window.localStorage?.getItem(coverageDismissKey(day)) || "[]";
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr.map(String) : []);
      } catch {
        return new Set();
      }
    },
    [coverageDismissKey]
  );

  const loadCoverageAlerts = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) {
        setCoverageAlerts([]);
        return;
      }

      const qs = new URLSearchParams({ day: todayIso });
      const r = await fetch(`/api/admin/checkins/coverage-alerts?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (!r.ok) {
        // Route pas encore déployée ou erreur ponctuelle: on ne bloque pas l'admin.
        setCoverageAlerts([]);
        return;
      }

      const j = await r.json().catch(() => ({}));
      const items = Array.isArray(j?.items) ? j.items : [];
      const dismissed = getDismissedCoverageIds(todayIso);
      const filtered = items.filter((it) => !dismissed.has(String(it?.id || it?.checkin_id || "")));

      setCoverageAlerts(filtered);
      setCoverageErr("");
      setCoverageChoices((prev) => {
        const next = { ...(prev || {}) };
        for (const it of filtered) {
          const id = String(it?.id || it?.checkin_id || "");
          if (!id || next[id]) continue;
          const first = Array.isArray(it?.candidates) ? it.candidates[0] : null;
          if (first?.seller_id) next[id] = first.seller_id;
        }
        return next;
      });
    } catch {
      setCoverageAlerts([]);
    }
  }, [getDismissedCoverageIds, todayIso]);

  const dismissCoverageAlert = useCallback(
    (alertId, day) => {
      const id = String(alertId || "");
      if (!id) return;
      try {
        const key = coverageDismissKey(day || todayIso);
        const raw = window.localStorage?.getItem(key) || "[]";
        const arr = JSON.parse(raw);
        const set = new Set(Array.isArray(arr) ? arr.map(String) : []);
        set.add(id);
        window.localStorage?.setItem(key, JSON.stringify(Array.from(set).slice(-80)));
      } catch {}
      setCoverageAlerts((prev) => (prev || []).filter((it) => String(it?.id || it?.checkin_id || "") !== id));
    },
    [coverageDismissKey, todayIso]
  );

  const validateCoverageTransfer = useCallback(
    async (item) => {
      const id = String(item?.id || item?.checkin_id || "");
      if (!id) return;

      const selected = coverageChoices[id] || item?.candidates?.[0]?.seller_id || "";
      if (!selected) {
        setCoverageErr("Choisis la vendeuse qui a couvert avant de valider.");
        return;
      }
      if (selected === item?.seller_id) {
        setCoverageErr("La vendeuse en retard ne peut pas se couvrir elle-même.");
        return;
      }

      setCoverageBusy((prev) => ({ ...(prev || {}), [id]: true }));
      setCoverageErr("");
      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        if (!token) throw new Error("Session admin manquante.");

        const r = await fetch("/api/admin/checkins/coverage-alerts", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            checkin_id: id,
            covered_by_seller_id: selected,
            minutes: item?.late_minutes,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j?.ok === false) throw new Error(j?.error || `Erreur API (${r.status})`);

        setCoverageAlerts((prev) => (prev || []).filter((it) => String(it?.id || it?.checkin_id || "") !== id));
        setRefreshKey((k) => k + 1);
        await loadCoverageAlerts();
      } catch (e) {
        setCoverageErr(e?.message || "Impossible de valider le transfert.");
      } finally {
        setCoverageBusy((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [coverageChoices, loadCoverageAlerts]
  );

  const missingCheckinAlertId = useCallback(
    (item) => String(item?.id || item?.alert_id || `${item?.day || todayIso}:${item?.seller_id || ""}:${item?.shift_code || ""}`),
    [todayIso]
  );

  const openMissingCheckinManualMode = useCallback(
    (item) => {
      const id = missingCheckinAlertId(item);
      if (!id) return;
      setMissingCheckinModes((prev) => ({ ...(prev || {}), [id]: "manual" }));
      setMissingCheckinTimes((prev) => ({
        ...(prev || {}),
        [id]: String(prev?.[id] || item?.planned_time || ""),
      }));
      setMissingCheckinErr("");
    },
    [missingCheckinAlertId]
  );

  const closeMissingCheckinManualMode = useCallback(
    (item) => {
      const id = missingCheckinAlertId(item);
      if (!id) return;
      setMissingCheckinModes((prev) => ({ ...(prev || {}), [id]: "" }));
      setMissingCheckinErr("");
    },
    [missingCheckinAlertId]
  );

  const markMissingCheckinAbsent = useCallback(
    async (item) => {
      const id = missingCheckinAlertId(item);
      if (!id) return;

      setMissingCheckinBusy((prev) => ({ ...(prev || {}), [id]: true }));
      setMissingCheckinErr("");

      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        if (!token) throw new Error("Session admin manquante.");

        const r = await fetch("/api/admin/checkins/missing-resolution", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            action: "absent",
            day: item?.day || todayIso,
            seller_id: item?.seller_id,
            shift_code: item?.shift_code,
          }),
        });

        const j = await r.json().catch(() => ({}));
        if (!r.ok || j?.ok === false) throw new Error(j?.error || `Erreur API (${r.status})`);

        setMissingCheckinAlerts((prev) => (prev || []).filter((it) => missingCheckinAlertId(it) !== id));
        setMissingCheckinsCount((n) => Math.max(0, Number(n || 0) - 1));
        setRefreshKey((k) => k + 1);

        await Promise.all([
          loadMissingCheckinsCount(),
          loadWeekAbsences(),
          loadAbsencesToday(),
          loadMonthAbsences(),
          loadMonthUpcomingAbsences(),
        ]);
      } catch (e) {
        setMissingCheckinErr(e?.message || "Impossible de marquer cette vendeuse absente.");
      } finally {
        setMissingCheckinBusy((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [
      missingCheckinAlertId,
      todayIso,
      loadMissingCheckinsCount,
      loadWeekAbsences,
      loadAbsencesToday,
      loadMonthAbsences,
      loadMonthUpcomingAbsences,
    ]
  );

  const validateMissingCheckinManualTime = useCallback(
    async (item) => {
      const id = missingCheckinAlertId(item);
      if (!id) return;

      const actualTime = String(missingCheckinTimes?.[id] || "").trim();
      if (!/^\d{2}:\d{2}$/.test(actualTime)) {
        setMissingCheckinErr("Choisis l'heure réelle d'arrivée avant d'enregistrer.");
        return;
      }

      setMissingCheckinBusy((prev) => ({ ...(prev || {}), [id]: true }));
      setMissingCheckinErr("");

      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        if (!token) throw new Error("Session admin manquante.");

        const r = await fetch("/api/admin/checkins/missing-resolution", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            action: "manual_checkin",
            day: item?.day || todayIso,
            seller_id: item?.seller_id,
            shift_code: item?.shift_code,
            actual_time: actualTime,
          }),
        });

        const j = await r.json().catch(() => ({}));
        if (!r.ok || j?.ok === false) throw new Error(j?.error || `Erreur API (${r.status})`);

        setMissingCheckinAlerts((prev) => (prev || []).filter((it) => missingCheckinAlertId(it) !== id));
        setMissingCheckinsCount((n) => Math.max(0, Number(n || 0) - 1));
        setMissingCheckinModes((prev) => ({ ...(prev || {}), [id]: "" }));
        setRefreshKey((k) => k + 1);

        await Promise.all([loadMissingCheckinsCount(), loadCoverageAlerts()]);
      } catch (e) {
        setMissingCheckinErr(e?.message || "Impossible d'enregistrer l'heure réelle d'arrivée.");
      } finally {
        setMissingCheckinBusy((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [missingCheckinAlertId, missingCheckinTimes, todayIso, loadMissingCheckinsCount, loadCoverageAlerts]
  );

  useEffect(() => {
    // ✅ Toujours tenter, même si la variable `session` n'est pas encore prête.
    // L'API est protégée: sans token => count = 0, sans casser l'admin.
    loadMissingCheckinsCount();
    const id = setInterval(loadMissingCheckinsCount, 60 * 1000);
    return () => clearInterval(id);
  }, [loadMissingCheckinsCount]);

  useEffect(() => {
    loadCoverageAlerts();
    // Vérification courte en secours du Realtime : l'alerte doit remonter vite pendant que l'admin est ouvert.
    const id = setInterval(loadCoverageAlerts, 10 * 1000);
    return () => clearInterval(id);
  }, [loadCoverageAlerts]);

  // Rafraîchir immédiatement quand on revient sur l'onglet (évite badge qui reste "bloqué")
  useEffect(() => {
    if (typeof window === "undefined") return;

    const onFocus = () => {
      loadMissingCheckinsCount();
      loadCoverageAlerts();
    };
    const onVis = () => {
      try {
        if (document.visibilityState === "visible") {
          loadMissingCheckinsCount();
          loadCoverageAlerts();
        }
      } catch {}
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadMissingCheckinsCount, loadCoverageAlerts]);

  // Sync instant badge si /admin/checkins "Marquer vu" (autre onglet / autre fenêtre)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const onStorage = (e) => {
      try {
        const k = e?.key || "";
        if (!k) return;
        if (k.startsWith("missing_checkins_ping_") || k.startsWith("seen_missing_checkins_")) {
          loadMissingCheckinsCount();
        }
      } catch {}
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [loadMissingCheckinsCount]);


  // ✅ Notification même depuis l'accueil admin (pas uniquement sur /admin/checkins)
  // Priorité au service worker / PWA (téléphone), puis fallback Notification navigateur.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!missingCheckinAlerts || missingCheckinAlerts.length <= 0) return;

    const ids = missingCheckinAlerts
      .map((it) => String(it?.id || it?.alert_id || ""))
      .filter(Boolean)
      .sort()
      .join(",");

    if (!ids) return;

    const now = Date.now();
    const last = lastMissingCheckinsNotifiedRef.current || { ids: "", ts: 0 };

    // Notifier pour une nouvelle alerte, ou relancer toutes les 30 min tant qu'elle n'est pas traitée.
    const shouldNotify = ids !== last.ids || now - (last.ts || 0) > 30 * 60 * 1000;
    if (!shouldNotify) return;

    lastMissingCheckinsNotifiedRef.current = { ids, ts: now };

    let cancelled = false;

    (async () => {
      try {
        if (!("Notification" in window) || Notification.permission !== "granted") return;

        const first = missingCheckinAlerts[0] || {};
        const n = missingCheckinAlerts.length;
        const who = first?.seller_name || "Une vendeuse";
        const shift = shiftHumanLabel(first?.shift_code);
        const title = "⏱️ Pointage manquant";
        const body =
          n === 1
            ? `${who} n’a pas pointé pour le créneau ${shift}. Est-elle absente ?`
            : `${n} pointages manquants à traiter. Ouvre l’admin pour indiquer absence ou heure réelle d’arrivée.`;

        // 1) Service worker / PWA en priorité: meilleure remontée sur téléphone
        if ("serviceWorker" in navigator) {
          try {
            let reg = await navigator.serviceWorker.getRegistration();
            if (!reg) {
              try {
                reg = await navigator.serviceWorker.ready;
              } catch {
                reg = null;
              }
            }

            if (!cancelled && reg && typeof reg.showNotification === "function") {
              await reg.showNotification(title, {
                body,
                tag: "admin-missing-checkins-resolution",
                renotify: true,
                requireInteraction: true,
                icon: "/icons/icon-192.png",
                badge: "/icons/icon-192.png",
                data: { url: "/admin" },
              });
              return;
            }
          } catch {
            // fallback navigateur ci-dessous
          }
        }

        // 2) Fallback navigateur classique
        if (!cancelled) {
          try {
            new Notification(title, { body, tag: "admin-missing-checkins-resolution" });
          } catch {
            // silence
          }
        }
      } catch {
        // silence
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [missingCheckinAlerts]);

  // Notification pour les retards confirmés: "Qui a couvert ?"
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!coverageAlerts || coverageAlerts.length <= 0) return;

    const ids = coverageAlerts.map((it) => String(it?.id || it?.checkin_id || "")).filter(Boolean).sort().join(",");
    const now = Date.now();
    const last = lastCoverageNotifiedRef.current || { ids: "", ts: 0 };
    const shouldNotify = ids !== last.ids || now - (last.ts || 0) > 20 * 60 * 1000;
    if (!shouldNotify) return;

    lastCoverageNotifiedRef.current = { ids, ts: now };

    let cancelled = false;
    (async () => {
      try {
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        const first = coverageAlerts[0];
        const who = first?.seller_name || "Une vendeuse";
        const at = checkinTimeLabel(first?.confirmed_at);
        const body = `${who} a pointé à ${at} avec ${fmtMinutesShort(first?.late_minutes)} de retard. Qui a couvert ?`;
        const title = "⏱️ Retard pointage";

        if ("serviceWorker" in navigator) {
          try {
            let reg = await navigator.serviceWorker.getRegistration();
            if (!reg) {
              try {
                reg = await navigator.serviceWorker.ready;
              } catch {
                reg = null;
              }
            }
            if (!cancelled && reg && typeof reg.showNotification === "function") {
              await reg.showNotification(title, {
                body,
                tag: "admin-late-coverage",
                renotify: true,
                requireInteraction: true,
                icon: "/icons/icon-192.png",
                badge: "/icons/icon-192.png",
                data: { url: "/admin" },
              });
              return;
            }
          } catch {}
        }

        if (!cancelled) {
          try {
            new Notification(title, { body, tag: "admin-late-coverage", requireInteraction: true });
          } catch {}
        }
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
  }, [coverageAlerts]);

  useEffect(() => {
    const ch = supabase
      .channel("daily_checkins_late_coverage_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_checkins" }, () => {
        loadCoverageAlerts();
        setRefreshKey((k) => k + 1);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [loadCoverageAlerts]);


  /* ---------- RENDER ---------- */

  const mhAwaitingSellerCount =
    mhPendingCount == null || mhToReviewCount == null ? null : Math.max(0, (mhPendingCount || 0) - (mhToReviewCount || 0));

  // ✅ Badge bouton: total global à traiter si dispo, sinon mois sélectionné
  const mhBadgeCount = mhToReviewTotal ?? mhToReviewCount;
  // ✅ Affichage compte au centre (jamais "-")
  const accountTopLabel = useMemo(() => {
    const forced = process.env.NEXT_PUBLIC_FORCE_ADMIN === "1";
    const rawEmail = session?.user?.email || "";
    const email = String(rawEmail).trim().toLowerCase();
    const role = String(profile?.role || "").trim().toLowerCase();

    // L'admin voit toujours "admin"
    const adminish = forced || role === "admin" || isAdminEmail(email);
    if (adminish) return "Compte : admin";

    // Fallback ultra robuste (ne jamais afficher "-")
    const who = profile?.full_name || email || "admin";
    return `Compte : ${who}`;
  }, [session?.user?.email, profile?.full_name, profile?.role]);

  return (
    <>
      <Head>
        <title>Admin - {BUILD_TAG}</title>
        <link rel="manifest" href="/admin.webmanifest" />
        {/* iOS */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Admin" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </Head>
      <div
        style={{
          padding: "6px 10px",
          background: "#fff",
          color: "#111827",
          borderBottom: "1px solid #e5e7eb",
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
            alignItems: "center",
            gap: 8,
            width: "100%",
            lineHeight: 1.15,
          }}
        >
          <div
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontWeight: 700,
              fontSize: "13px",
            }}
          >
            {BUILD_TAG}
          </div>

          <div
            style={{
              textAlign: "center",
              whiteSpace: "nowrap",
              fontWeight: 800,
              color: "#16a34a",
              fontSize: "12px",
              padding: "2px 10px",
              borderRadius: 9999,
              border: "1px solid #bbf7d0",
              background: "#f0fdf4",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            }}
          >
            {accountTopLabel}
          </div>

          <div
            style={{
              justifySelf: "end",
              fontWeight: 600,
              fontSize: "11px",
              whiteSpace: "nowrap",
              opacity: 0.85,
            }}
          >
            Supabase: {supabaseProjectRef || "?"}
          </div>
        </div>
      </div>

      <div className="p-3 max-w-7xl 2xl:max-w-screen-2xl mx-auto space-y-5">
        <div
          className="card"
          style={{
            padding: "14px",
            borderRadius: 24,
            border: "1px solid #e5e7eb",
            boxShadow: "0 14px 34px rgba(15,23,42,0.06)",
            background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
          }}
        >
          <div className="flex items-center justify-between gap-3 flex-wrap" style={{ marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: "1rem", color: "#0f172a" }}>Navigation admin</div>
              <div className="text-sm text-gray-600">
                Accès rapide aux outils du quotidien, sans les empiler au hasard.
              </div>
            </div>

            <button
              type="button"
              className="btn"
              onClick={handleSignOut}
              disabled={signingOut}
              style={{
                minHeight: 46,
                padding: "10px 16px",
                borderRadius: 16,
                backgroundColor: "#dc2626",
                borderColor: "transparent",
                color: "#fff",
                fontWeight: 900,
                whiteSpace: "nowrap",
              }}
            >
              {signingOut ? "Déconnexion…" : "Se déconnecter"}
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(178px, 1fr))",
              gap: 10,
              alignItems: "stretch",
            }}
          >
            <AdminNavLink href="/admin/sellers" icon="👥" label="Gérer les vendeuses" />
            <AdminNavLink
              href="/admin/checkins"
              icon="⏱️"
              label="Pointage"
              title="Pointages manquants (alerte après 1h)"
              badge={missingCheckinsCount > 0 ? missingCheckinsCount : null}
              badgeTitle={`${missingCheckinsCount} pointage(s) manquant(s)`}
            />
            <AdminNavLink href="/admin/supervisors" icon="🖥️" label="Superviseur" />
            <AdminNavLink
              href="/admin/monthly-hours"
              icon="🧾"
              label="Heures mensuelles"
              title="Validation des heures mensuelles"
              badge={mhBadgeCount != null && mhBadgeCount > 0 ? (mhBadgeCount > 99 ? "99+" : mhBadgeCount) : null}
              badgeTitle={`${mhBadgeCount || 0} à valider/refuser`}
            />
            <AdminNavLink href="/admin/leaves" icon="🏖️" label="Congés" />
            <AdminNavLink href="/admin/payslips" icon="📄" label="Fiches de paie" />
            <AdminNavLink href="/admin/shift-types" icon="🕒" label="Plages horaires" />
            <AdminNavLink href="/admin/payroll-email" icon="📨" label="Mail paie comptable" />
            <AdminNavLink href="/admin/retards-relais" icon="⏱️" label="Retards / relais" />
          </div>
        </div>
        {missingCheckinsCount > 0 ? (
          <div
            className="card"
            style={{
              borderColor: "#fecaca",
              background: "#fff1f2",
              padding: "10px 12px",
            }}
          >
            <div className="text-sm" style={{ fontWeight: 800, color: "#991b1b" }}>
              ⚠️ {missingCheckinsCount} pointage(s) manquant(s) à traiter
            </div>
            <div className="text-sm" style={{ marginTop: 4, color: "#7f1d1d" }}>
              Réponds juste en dessous : absence confirmée ou heure réelle d'arrivée. La page{" "}
              <Link href="/admin/checkins" legacyBehavior>
                <a style={{ textDecoration: "underline", fontWeight: 800 }}>Pointage</a>
              </Link>{" "}
              reste disponible pour le suivi général.
            </div>
          </div>
        ) : null}

        {missingCheckinAlerts.length > 0 ? (
          <MissingCheckinAlertsPanel
            items={missingCheckinAlerts}
            modes={missingCheckinModes}
            times={missingCheckinTimes}
            busy={missingCheckinBusy}
            error={missingCheckinErr}
            onMarkAbsent={markMissingCheckinAbsent}
            onOpenManual={openMissingCheckinManualMode}
            onCloseManual={closeMissingCheckinManualMode}
            onTimeChange={(id, value) => setMissingCheckinTimes((prev) => ({ ...(prev || {}), [String(id)]: value }))}
            onValidateManual={validateMissingCheckinManualTime}
          />
        ) : null}

        {coverageAlerts.length > 0 ? (
          <CoverageAlertsPanel
            items={coverageAlerts}
            choices={coverageChoices}
            busy={coverageBusy}
            error={coverageErr}
            onChoice={(id, sellerId) => setCoverageChoices((prev) => ({ ...(prev || {}), [String(id)]: sellerId }))}
            onValidate={validateCoverageTransfer}
            onDismiss={dismissCoverageAlert}
          />
        ) : null}

<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card">
                    <div className="hdr mb-2">Absences aujourd’hui</div>
                    {absencesToday.length === 0 ? (
                      <div className="text-sm">Aucune absence aujourd’hui</div>
                    ) : (
                      <ul className="list-disc pl-6 space-y-1">
                        {absencesToday.map((a) => (
                          <li key={a.id}>
                            <Chip name={nameFromId(a.seller_id)} /> - {a.status}
                            {a.reason ? (
                              <>
                                <span> · </span>
                                {a.reason}
                              </>
                            ) : (
                              ""
                            )}
                            {a.replacement ? (
                              <>
                                {" · "}
                                <span>Remplacement accepté : </span>
                                <Chip name={nameFromId(a.replacement.volunteer_id)} />
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
          
                  <div className="card">
                    <div className="hdr mb-2">Demandes d’absence - en attente (à venir)</div>
                    {pendingAbs.length === 0 ? (
                      <div className="text-sm text-gray-600">Aucune demande en attente.</div>
                    ) : (
                      <div className="space-y-2">
                        {pendingAbs.map((a) => {
                          const name = nameFromId(a.seller_id);
                          return (
                            <div key={a.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                              <div>
                                <div className="font-medium">{name}</div>
                                <div className="text-sm text-gray-600">
                                  {a.date}
                                  {a.reason ? (
                                    <>
                                      <span> · </span>
                                      {a.reason}
                                    </>
                                  ) : (
                                    ""
                                  )}
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <ApproveBtn onClick={() => approveAbs(a.id)} />
                                <RejectBtn onClick={() => rejectAbs(a.id)} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
          
                  <div className="card">
                    <div className="hdr mb-2">Demandes de congé - en attente</div>
                    {pendingLeaves.length === 0 ? (
                      <div className="text-sm text-gray-600">Aucune demande de congé en attente.</div>
                    ) : (
                      <div className="space-y-2">
                        {pendingLeaves.map((l) => {
                          const name = nameFromId(l.seller_id);
                          return (
                            <div key={l.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                              <div>
                                <div className="font-medium">{name}</div>
                                <div className="text-sm text-gray-600">
                                  Du {l.start_date} au {l.end_date}
                                  {l.reason ? (
                                    <>
                                      <span> · </span>
                                      {l.reason}
                                    </>
                                  ) : (
                                    ""
                                  )}
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <ApproveBtn onClick={() => approveLeave(l.id)} />
                                <RejectBtn onClick={() => rejectLeave(l.id)} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
          
                  <div className="card">
                    <div className="hdr mb-2">Congés approuvés - en cours ou à venir</div>
                    {approvedLeaves.length === 0 ? (
                      <div className="text-sm text-gray-600">Aucun congé approuvé à venir.</div>
                    ) : (
                      <div className="space-y-2">
                        {approvedLeaves.map((l) => {
                          const name = nameFromId(l.seller_id);
                          const isOngoing = betweenIso(todayIso, l.start_date, l.end_date);
                          const tag = isOngoing ? "En cours" : "À venir";
                          const tagBg = isOngoing ? "#16a34a" : "#2563eb";
                          return (
                            <div key={l.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                              <div>
                                <div className="font-medium">{name}</div>
                                <div className="text-sm text-gray-600">
                                  Du {l.start_date} au {l.end_date}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: tagBg }}>
                                  {tag}
                                </span>
                                {!isOngoing && l.start_date > todayIso ? (
                                  <button
                                    type="button"
                                    className="btn"
                                    onClick={() => cancelFutureLeave(l.id)}
                                    style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}
                                  >
                                    Annuler le congé
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
          
                  
        </div>

        <TodayColorBlocks today={today} todayIso={todayIso} assign={assign} nameFromId={nameFromId} shiftTypeRows={shiftTypeRows} />

        <div className="card">
          <div className="hdr mb-4">Planning de la semaine</div>

          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-3">
            <WeekNav
              monday={monday}
              onPrev={() => setMonday(addDays(monday, -7))}
              onToday={() => setMonday(startOfWeek(new Date()))}
              onNext={() => setMonday(addDays(monday, 7))}
            />
            <button type="button" className="btn" onClick={copyWeekToNext}>
              Copier la semaine {"\u2192"} la suivante
            </button>
          </div>

          <div className="overflow-x-auto">
            <div className="md:min-w-[1200px] grid grid-cols-1 md:grid-cols-7 gap-3">
            {days.map((d) => {
              const iso = fmtISODate(d);
              const sunday = isSunday(d);
              const highlight = isSameISO(d, todayIso);
              const currentAbs = absencesByDate[iso] || [];
              const effectiveMap = resolveEffectiveShiftMap(shiftTypeRows, iso);

              // defaults depuis le planning
              const morningId = assign[`${iso}|MORNING`] || "";
              const middayId = assign[`${iso}|MIDDAY`] || "";
              const eveningId = assign[`${iso}|EVENING`] || "";
              const defaultStayed = middayId || morningId || "";
              const defaultArrived = eveningId || "";

const recMorning = handoverByKey[`${iso}|MORNING_START`] || null;
const recEvening = handoverByKey[`${iso}|EVENING_START`] || null;

const draftMorning = handoverEdit[`${iso}|MORNING_START`] || null;
const draftEvening = handoverEdit[`${iso}|EVENING_START`] || null;

const handoverCount = (recMorning ? 1 : 0) + (recEvening ? 1 : 0);

// Matin (retard simple possible: stayed = null)
const plannedMorning = (draftMorning?.planned_time ?? recMorning?.planned_time ?? "06:30").toString();
const actualMorning = (draftMorning?.actual_time ?? recMorning?.actual_time ?? "").toString();
const stayedMorningId = (draftMorning?.stayed_seller_id ?? recMorning?.stayed_seller_id ?? "") || "";
const arrivedMorningId = (draftMorning?.arrived_seller_id ?? recMorning?.arrived_seller_id ?? (morningId || "")) || "";
const mP = parseHHMM(plannedMorning);
const mA = parseHHMM(actualMorning);
const deltaMorningMin = mP != null && mA != null ? mA - mP : null;

const stayedMorningName = stayedMorningId ? (nameFromId(stayedMorningId) || "-") : "-";
const arrivedMorningName = arrivedMorningId ? (nameFromId(arrivedMorningId) || "-") : "-";

// Soir
const plannedEvening = (draftEvening?.planned_time ?? recEvening?.planned_time ?? "13:30").toString();
const actualEvening = (draftEvening?.actual_time ?? recEvening?.actual_time ?? "").toString();
const stayedEveningId = (draftEvening?.stayed_seller_id ?? recEvening?.stayed_seller_id ?? defaultStayed) || "";
const arrivedEveningId = (draftEvening?.arrived_seller_id ?? recEvening?.arrived_seller_id ?? defaultArrived) || "";
const eP = parseHHMM(plannedEvening);
const eA = parseHHMM(actualEvening);
const deltaEveningMin = eP != null && eA != null ? eA - eP : null;

const stayedEveningName = stayedEveningId ? (nameFromId(stayedEveningId) || "-") : "-";
const arrivedEveningName = arrivedEveningId ? (nameFromId(arrivedEveningId) || "-") : "-";
              const candidatesStayed = Array.from(new Set([middayId, morningId].filter(Boolean)));
              const candidatesArrived = Array.from(new Set([eveningId].filter(Boolean)));

              // options all sellers (dedupe)
              const sellerOptions = (sellers || []).map((s) => ({ id: s.user_id, name: s.full_name }));

              return (
                <div
                  key={iso}
                  className="border rounded-2xl p-3 space-y-3"
                  style={highlight ? { boxShadow: "inset 0 0 0 2px rgba(37,99,235,0.5)" } : {}}
                >
                  <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{iso}</div>
                    {handoverCount > 0 ? (
                      <span
                        title={`Retard / relais: ${handoverCount}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          minWidth: 22,
                          height: 22,
                          padding: "0 7px",
                          borderRadius: 999,
                          background: "#dc2626",
                          color: "#fff",
                          fontSize: 12,
                          fontWeight: 800,
                          lineHeight: "22px",
                        }}
                      >
                        {handoverCount}
                      </span>
                    ) : null}
                  </div>

                  {/* Bloc Absents (inline admin) */}
                  <div className="space-y-1">
                    <div className="text-sm font-medium">Absents</div>
                    <div className="flex flex-wrap gap-2">
                      {currentAbs.length === 0 ? <span className="text-sm text-gray-500">-</span> : null}
                      {currentAbs.map((sid) => {
                        const name = nameFromId(sid);
                        return (
                          <span
                            key={sid}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs"
                            style={{ background: "#f5f5f5", border: "1px solid #e0e0e0" }}
                          >
                            <span className="inline-block w-2 h-2 rounded-full" style={{ background: colorForName(name) }} />
                            {name}
                            <button
                              className="ml-1 text-[11px] opacity-70 hover:opacity-100"
                              onClick={() => removeSellerAbsent(iso, sid)}
                              title="Supprimer"
                            >
                              ✕
                            </button>
                          </span>
                        );
                      })}
                    </div>
                    <select
                      className="select w-full"
                      defaultValue=""
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return;
                        setSellerAbsent(iso, v);
                        e.target.value = "";
                      }}
                    >
                      <option value="" disabled>
                        Marquer "Absent"
                      </option>
                      {sellers.length === 0 && <option value="" disabled>(Aucune vendeuse - vérifier droits/RPC)</option>}
                      {sellers
                        .filter((s) => !currentAbs.includes(s.user_id))
                        .map((s) => (
                          <option key={s.user_id} value={s.user_id}>
                            {s.full_name}
                          </option>
                        ))}
                    </select>
                  </div>

                  <ShiftRow
                    label={effectiveMap.MORNING?.display_label || "Matin (6h30-13h30)"}
                    iso={iso}
                    code="MORNING"
                    value={assign[`${iso}|MORNING`] || ""}
                    onChange={save}
                    sellers={sellers}
                    chipName={nameFromId(assign[`${iso}|MORNING`])}
                  />

                  {!sunday ? (
                    <ShiftRow
                      label={effectiveMap.MIDDAY?.display_label || "Midi (6h30-13h30)"}
                      iso={iso}
                      code="MIDDAY"
                      value={assign[`${iso}|MIDDAY`] || ""}
                      onChange={save}
                      sellers={sellers}
                      chipName={nameFromId(assign[`${iso}|MIDDAY`])}
                    />
                  ) : (
                    <div className="space-y-1">
                      <div className="text-sm">Midi - deux postes</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-xs mb-1">{effectiveMap.MIDDAY?.display_label || "Midi (6h30-13h30)"}</div>
                          <select
                            className="select"
                            value={assign[`${iso}|MIDDAY`] || ""}
                            onChange={(e) => save(iso, "MIDDAY", e.target.value || null)}
                          >
                            <option value="">- Choisir vendeuse -</option>
                            {sellers.map((s) => (
                              <option key={s.user_id} value={s.user_id}>
                                {s.full_name}
                              </option>
                            ))}
                          </select>
                          <div className="mt-1">
                            <Chip name={nameFromId(assign[`${iso}|MIDDAY`])} />
                          </div>
                        </div>
                        <div>
                          <div className="text-xs mb-1">{effectiveMap.SUNDAY_EXTRA?.display_label || "Dimanche 9h-13h30"}</div>
                          <select
                            className="select"
                            value={assign[`${iso}|SUNDAY_EXTRA`] || ""}
                            onChange={(e) => save(iso, "SUNDAY_EXTRA", e.target.value || null)}
                          >
                            <option value="">- Choisir vendeuse -</option>
                            {sellers.map((s) => (
                              <option key={s.user_id} value={s.user_id}>
                                {s.full_name}
                              </option>
                            ))}
                          </select>
                          <div className="mt-1">
                            <Chip name={nameFromId(assign[`${iso}|SUNDAY_EXTRA`])} />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <ShiftRow
                    label={effectiveMap.EVENING?.display_label || "Soir (13h30-20h30)"}
                    iso={iso}
                    code="EVENING"
                    value={assign[`${iso}|EVENING`] || ""}
                    onChange={save}
                    sellers={sellers}
                    chipName={nameFromId(assign[`${iso}|EVENING`])}
                  />
                

</div>
              );
            })}
            </div>
          </div>
        </div>






        <div className="card">
          <div className="hdr mb-2">Choisir le mois pour “Total heures (mois)”</div>
          <div className="grid sm:grid-cols-3 gap-3 items-center">
            <div className="sm:col-span-2">
              <div className="text-sm mb-1">Mois</div>
              <input
                type="month"
                className="input"
                value={monthInputValue(selectedMonth)}
                onChange={(e) => {
                  const [y, m] = e.target.value.split("-").map(Number);
                  setSelectedMonth(new Date(y, m - 1, 1));
                }}
              />
            </div>
            <div className="text-sm text-gray-600">
              Mois sélectionné : <span className="font-medium">{labelMonthFR(selectedMonth)}</span>
            </div>
          </div>
        </div>

        <TotalsGrid
          sellers={sellers}
          monthFrom={monthFrom}
          monthTo={monthTo}
          monthLabel={labelMonthFR(selectedMonth)}
          refreshKey={refreshKey}
          monthAbsences={monthAbsences}
          monthUpcomingAbsences={monthUpcomingAbsences}
          shiftTypeRows={shiftTypeRows}
        />

        <div className="card">
          <div className="hdr mb-2">Absences approuvées - mois : {labelMonthFR(selectedMonth)}</div>
          {(() => {
            if (!monthAbsences || monthAbsences.length === 0) {
              return <div className="text-sm text-gray-600">Aucune absence (passée/aujourd’hui) sur ce mois.</div>;
            }
            const bySeller = {};
            monthAbsences.forEach((a) => {
              if (!bySeller[a.seller_id]) bySeller[a.seller_id] = [];
              bySeller[a.seller_id].push(a);
            });
            const entries = Object.entries(bySeller);
            return (
              <div className="space-y-3">
                {entries.map(([sid, arr]) => {
                  arr.sort((a, b) => a.date.localeCompare(b.date));
                  const name = nameFromId(sid);
                  return (
                    <div key={sid} className="border rounded-2xl p-3">
                      <div className="font-medium mb-1">{name}</div>
                      <ul className="text-sm space-y-1">
                        {arr.map((a) => {
                          const repl = monthAcceptedRepl[a.id];
                          return (
                            <li key={a.id}>
                              <span className="font-medium">{frDate(a.date)}</span>
                              {repl ? (
                                <>
                                  {" - "}
                                  <Chip name={nameFromId(repl.volunteer_id)} /> remplace <Chip name={name} />
                                  {repl.shift ? (
                                    <>
                                      {" "}
                                      (<span>{shiftHumanLabel(repl.shift)}</span>)
                                    </>
                                  ) : null}
                                </>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        <div className="card">
          <div className="hdr mb-2">Absences approuvées à venir - mois : {labelMonthFR(selectedMonth)}</div>
          {(() => {
            if (!monthUpcomingAbsences || monthUpcomingAbsences.length === 0) {
              return <div className="text-sm text-gray-600">Aucune absence à venir sur ce mois.</div>;
            }
            const bySeller = {};
            monthUpcomingAbsences.forEach((a) => {
              if (!bySeller[a.seller_id]) bySeller[a.seller_id] = [];
              bySeller[a.seller_id].push(a);
            });
            const entries = Object.entries(bySeller);
            return (
              <div className="space-y-3">
                {entries.map(([sid, arr]) => {
                  arr.sort((a, b) => a.date.localeCompare(b.date));
                  const name = nameFromId(sid);
                  return (
                    <div key={sid} className="border rounded-2xl p-3">
                      <div className="font-medium mb-1">{name}</div>
                      <ul className="text-sm space-y-1">
                        {arr.map((a) => {
                          const repl = monthAcceptedRepl[a.id];
                          return (
                            <li key={a.id}>
                              <span className="font-medium">{frDate(a.date)}</span>
                              {repl ? (
                                <>
                                  {" - "}
                                  <Chip name={nameFromId(repl.volunteer_id)} /> remplace <Chip name={name} />
                                  {repl.shift ? (
                                    <>
                                      {" "}
                                      (<span>{shiftHumanLabel(repl.shift)}</span>)
                                    </>
                                  ) : null}
                                </>
                              ) : (
                                <>
                                  {" "}
                                  - <span className="text-gray-500">pas de volontaire accepté</span>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>
    </>
  );
}

/* ---------- SOUS-COMPOSANTS ---------- */

function MissingCheckinAlertsPanel({
  items,
  modes,
  times,
  busy,
  error,
  onMarkAbsent,
  onOpenManual,
  onCloseManual,
  onTimeChange,
  onValidateManual,
}) {
  return (
    <div
      className="card"
      style={{
        borderColor: "#fecaca",
        background: "linear-gradient(135deg, #fff1f2 0%, #ffffff 72%)",
        boxShadow: "0 10px 30px rgba(220, 38, 38, 0.10)",
      }}
    >
      <div className="hdr mb-2" style={{ color: "#991b1b" }}>
        🚨 Pointage manquant à traiter
      </div>
      <div className="text-sm" style={{ color: "#7f1d1d", marginBottom: 10 }}>
        Une vendeuse planifiée n’a pas pointé. Indique si elle est absente ou sa vraie heure d’arrivée. L’application calculera le retard réel, même si tu régularises plusieurs heures plus tard.
      </div>

      {error ? (
        <div className="text-sm" style={{ color: "#b91c1c", fontWeight: 700, marginBottom: 10 }}>
          {error}
        </div>
      ) : null}

      <div className="space-y-3">
        {(items || []).map((it) => {
          const id = String(it?.id || it?.alert_id || "");
          const isBusy = !!busy?.[id];
          const manualMode = modes?.[id] === "manual";
          const selectedTime = String(times?.[id] || it?.planned_time || "");
          const shift = shiftHumanLabel(it?.shift_code);
          const since = Number(it?.minutes_since_start || 0) || 0;

          return (
            <div key={id} className="border rounded-2xl p-3" style={{ background: "#fff", borderColor: "#fca5a5" }}>
              <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
                <div>
                  <div className="font-semibold" style={{ color: "#111827" }}>
                    {it?.seller_name || "Vendeuse"} n’a pas pointé pour le créneau {shift}
                  </div>
                  <div className="text-sm" style={{ color: "#7f1d1d", marginTop: 3 }}>
                    Prévu à <b>{it?.planned_time || "--:--"}</b> · {frDate(it?.day)} · alerte ouverte depuis {fmtMinutesShort(since)}
                  </div>
                </div>

                {!manualMode ? (
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                    <button
                      type="button"
                      className="btn"
                      disabled={isBusy}
                      onClick={() => onMarkAbsent?.(it)}
                      style={{
                        background: isBusy ? "#9ca3af" : "#dc2626",
                        borderColor: "transparent",
                        color: "#fff",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isBusy ? "Traitement…" : "Oui, absente"}
                    </button>

                    <button
                      type="button"
                      className="btn"
                      disabled={isBusy}
                      onClick={() => onOpenManual?.(it)}
                      style={{
                        background: "#fff",
                        borderColor: "#fca5a5",
                        color: "#991b1b",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Non, elle était présente
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                    <label className="text-sm" style={{ color: "#7f1d1d", fontWeight: 700 }}>
                      Arrivée réelle
                    </label>
                    <input
                      type="time"
                      className="input"
                      value={selectedTime}
                      onChange={(e) => onTimeChange?.(id, e.target.value)}
                      disabled={isBusy}
                      style={{ minWidth: 132 }}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={isBusy || !selectedTime}
                      onClick={() => onValidateManual?.(it)}
                      style={{
                        background: isBusy || !selectedTime ? "#9ca3af" : "#16a34a",
                        borderColor: "transparent",
                        color: "#fff",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isBusy ? "Enregistrement…" : "Enregistrer l’heure"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={isBusy}
                      onClick={() => onCloseManual?.(it)}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      Retour
                    </button>
                  </div>
                )}
              </div>

              {manualMode ? (
                <div className="text-xs" style={{ color: "#7f1d1d", marginTop: 8 }}>
                  Exemple : si le créneau commence à 13:30 et que tu indiques 13:33, le retard enregistré sera exactement de 3 min.
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CoverageAlertsPanel({ items, choices, busy, error, onChoice, onValidate, onDismiss }) {
  return (
    <div
      className="card"
      style={{
        borderColor: "#fed7aa",
        background: "linear-gradient(135deg, #fff7ed 0%, #ffffff 70%)",
        boxShadow: "0 10px 30px rgba(234, 88, 12, 0.10)",
      }}
    >
      <div className="hdr mb-2" style={{ color: "#9a3412" }}>
        ⏱️ Retard pointage à traiter
      </div>
      <div className="text-sm" style={{ color: "#7c2d12", marginBottom: 10 }}>
        Choisis la vendeuse qui a couvert. Le retard reste compté pour la vendeuse arrivée en retard, et l'application ajoute automatiquement ce temps en travail en plus à celle qui a couvert. Si aucune couverture n’est à attribuer, clique sur « Pas de couverture ».
      </div>

      {error ? (
        <div className="text-sm" style={{ color: "#b91c1c", fontWeight: 700, marginBottom: 10 }}>
          {error}
        </div>
      ) : null}

      <div className="space-y-3">
        {(items || []).map((it) => {
          const id = String(it?.id || it?.checkin_id || "");
          const selected = choices?.[id] || it?.candidates?.[0]?.seller_id || "";
          const isBusy = !!busy?.[id];
          const candidates = Array.isArray(it?.candidates) ? it.candidates : [];
          return (
            <div key={id} className="border rounded-2xl p-3" style={{ background: "#fff", borderColor: "#fdba74" }}>
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div>
                  <div className="font-semibold" style={{ color: "#111827" }}>
                    {it?.seller_name || "Vendeuse"} a pointé à {checkinTimeLabel(it?.confirmed_at)}
                  </div>
                  <div className="text-sm" style={{ color: "#7c2d12", marginTop: 3 }}>
                    Retard détecté : <b>{fmtMinutesShort(it?.late_minutes)}</b> · Créneau : {shiftHumanLabel(it?.shift_code)} · {frDate(it?.day)}
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                  <select
                    className="select"
                    value={selected}
                    onChange={(e) => onChoice?.(id, e.target.value)}
                    disabled={isBusy || candidates.length === 0}
                    style={{ minWidth: 220 }}
                  >
                    <option value="">Qui a couvert ?</option>
                    {candidates.map((c) => (
                      <option key={c.seller_id} value={c.seller_id}>
                        {c.full_name || c.seller_name || "Vendeuse"} {c.shift_code ? `(${shiftHumanLabel(c.shift_code)})` : ""}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    className="btn"
                    disabled={isBusy || !selected}
                    onClick={() => onValidate?.(it)}
                    style={{
                      background: isBusy || !selected ? "#9ca3af" : "#16a34a",
                      borderColor: "transparent",
                      color: "#fff",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isBusy ? "Validation…" : `Valider +${fmtMinutesShort(it?.late_minutes)}`}
                  </button>

                  <button
                    type="button"
                    className="btn"
                    disabled={isBusy}
                    onClick={() => onDismiss?.(id, it?.day)}
                    style={{ whiteSpace: "nowrap" }}
                    title="Masquer cette alerte sans attribuer de couverture"
                  >
                    Pas de couverture
                  </button>
                </div>
              </div>

              {candidates.length === 0 ? (
                <div className="text-sm" style={{ color: "#b91c1c", marginTop: 8 }}>
                  Aucune vendeuse du matin trouvée dans le planning de ce jour. Tu peux encore corriger depuis “Retards / relais”.
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShiftSelect({ dateStr, value, onChange }) {
  const sunday = isSunday(new Date(dateStr));
  const options = [
    { code: "MORNING", label: "Matin (6h30-13h30)" },
    { code: "MIDDAY", label: "Midi (6h30-13h30)" },
    ...(sunday ? [{ code: "SUNDAY_EXTRA", label: "9h-13h30" }] : []),
    { code: "EVENING", label: "Soir (13h30-20h30)" },
  ];
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">- Choisir un créneau -</option>
      {options.map((op) => (
        <option key={op.code} value={op.code}>
          {op.label}
        </option>
      ))}
    </select>
  );
}

function TodayColorBlocks({ today, todayIso, assign, nameFromId, shiftTypeRows = [] }) {
  const codes = ["MORNING", "MIDDAY", ...(isSunday(today) ? ["SUNDAY_EXTRA"] : []), "EVENING"];
  return (
    <div className="card">
      <div className="hdr mb-2">Planning du jour</div>
      <div className={`grid ${isSunday(today) ? "md:grid-cols-4" : "md:grid-cols-3"} gap-3`}>
        {codes.map((code) => {
          const label = getShiftLabelForDate(shiftTypeRows, todayIso, code) || SHIFT_LABELS[code];
          const sellerId = assign[`${todayIso}|${code}`];
          const name = nameFromId(sellerId);
          const assigned = !!sellerId;
          const bg = assigned ? colorForName(name) : "#f3f4f6";
          const fg = assigned ? "#fff" : "#6b7280";
          const border = assigned ? "transparent" : "#e5e7eb";
          return (
            <div key={code} className="rounded-2xl p-3" style={{ backgroundColor: bg, color: fg, border: `1px solid ${border}` }}>
              <div className="font-medium">{label}</div>
              <div className="text-sm mt-1">{assigned ? name : "-"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShiftRow({ label, iso, code, value, onChange, sellers, chipName }) {
  return (
    <div className="space-y-1">
      <div className="text-sm">{label}</div>
      <select className="select" value={value} onChange={(e) => onChange(iso, code, e.target.value || null)}>
        <option value="">- Choisir vendeuse -</option>
        {sellers.length === 0 && <option value="" disabled>(Aucune vendeuse - vérifier droits/RPC)</option>}
        {sellers.map((s) => (
          <option key={s.user_id} value={s.user_id}>
            {s.full_name}
          </option>
        ))}
      </select>

      <div>
        <Chip name={chipName} />
      </div>
    </div>
  );
}

function TotalsGrid({ sellers, monthFrom, monthTo, monthLabel, refreshKey, monthAbsences = [], monthUpcomingAbsences = [], shiftTypeRows = [] }) {
  const [weekTotals, setWeekTotals] = useState({});
  const [monthTotals, setMonthTotals] = useState({});
  const [annualLeaveDays, setAnnualLeaveDays] = useState({});
  const [loading, setLoading] = useState(false);

  const todayIso = fmtISODate(new Date());

  // Agrégateur simple côté client
  function aggregateFromRows(rows, sellersList) {
    const dict = Object.fromEntries((sellersList || []).map((s) => [s.user_id, 0]));
    (rows || []).forEach((r) => {
      const h = getShiftDurationHoursForDate(shiftTypeRows, r.date, r.shift_code) ?? (SHIFT_HOURS[r.shift_code] ?? 0);
      if (r.seller_id) dict[r.seller_id] = (dict[r.seller_id] || 0) + h;
    });
    return dict;
  }

async function fetchExtraWorkRange(fromIso, toIso, sellersList) {
  const dict = Object.fromEntries((sellersList || []).map((s) => [s.user_id, 0]));

  try {
    const { data, error } = await supabase.rpc("admin_extra_work_by_range", { p_from: fromIso, p_to: toIso });
    if (!error && Array.isArray(data)) {
      data.forEach((r) => {
        if (!r?.seller_id) return;
        dict[r.seller_id] = Number(r.extra_work_hours) || 0;
      });
      return dict;
    }
  } catch (e) {
    console.warn("RPC admin_extra_work_by_range threw -> fallback", e);
  }

  try {
    const { data: rows, error } = await supabase
      .from("extra_work_entries")
      .select("seller_id, minutes, work_date")
      .gte("work_date", fromIso)
      .lte("work_date", toIso);
    if (error) throw error;
    (rows || []).forEach((r) => {
      if (!r?.seller_id) return;
      dict[r.seller_id] = Number(dict[r.seller_id] || 0) + (Number(r.minutes || 0) / 60);
    });
  } catch (e) {
    console.warn("extra_work_entries fallback failed", e);
  }

  return dict;
}

function applyExtraWorkHours(baseDict, extraDict) {
  const out = { ...(baseDict || {}) };
  Object.entries(extraDict || {}).forEach(([sellerId, hours]) => {
    out[sellerId] = Number(out[sellerId] || 0) + (Number(hours) || 0);
  });
  return out;
}

async function fetchHandoversRange(fromIso, toIso) {
  try {
    const { data, error } = await supabase
      .from("shift_handover_adjustments")
      .select("date, boundary, planned_time, actual_time, stayed_seller_id, arrived_seller_id")
      .in("boundary", ["MORNING_START", "EVENING_START", "MORNING", "EVENING"])
      .gte("date", fromIso)
      .lte("date", toIso);
    if (error) throw error;
    return data || [];
  } catch (e) {
    return [];
  }
}

function applyHandovers(dict, handovers) {
  const out = { ...(dict || {}) };
  const list = Array.isArray(handovers) ? [...handovers] : [];

  // ✅ En cas de doublon (MORNING vs MORNING_START), on préfère la version canonique (*_START)
  list.sort((a, b) => {
    const aCanon = (a?.boundary || "") === canonBoundary(a?.boundary || "");
    const bCanon = (b?.boundary || "") === canonBoundary(b?.boundary || "");
    if (aCanon === bCanon) return 0;
    return aCanon ? -1 : 1;
  });

  const seen = new Set();

  list.forEach((h) => {
    const b = canonBoundary(h.boundary);
    const k = `${h.date}|${b}`;
    if (seen.has(k)) return;
    seen.add(k);

    const fallbackPlanned = b === "MORNING_START" ? "06:30" : "13:30";
    const planned = parseHHMM(h.planned_time || fallbackPlanned);
    const actual = parseHHMM(h.actual_time || "");
    if (planned == null || actual == null) return;

    const deltaMin = clamp(actual - planned, -360, 360);
    const deltaHours = deltaMin / 60;

    const stayed = h.stayed_seller_id;
    const arrived = h.arrived_seller_id;

    if (stayed) out[stayed] = Number(out[stayed] || 0) + deltaHours;
    if (arrived) out[arrived] = Number(out[arrived] || 0) - deltaHours;
  });

  return out;
}


  function applyCheckinAdjustments(baseDict, rows) {
    const out = { ...(baseDict || {}) };
    (rows || []).forEach((r) => {
      const sellerId = r?.seller_id || null;
      if (!sellerId) return;
      const lateMin = Number(r?.late_minutes || 0) || 0;
      const earlyMin = Number(r?.early_minutes || 0) || 0;
      const deltaHours = (earlyMin - lateMin) / 60;
      out[sellerId] = Number(out[sellerId] || 0) + deltaHours;
    });
    return out;
  }

  async function fetchCheckinAdjustmentsRange(fromIso, toIso) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return [];

      const qs = new URLSearchParams({ from: fromIso, to: toIso });
      const r = await fetch(`/api/admin/checkins/by-range?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.warn("admin checkins by-range API failed", r.status, txt);
        return [];
      }

      const j = await r.json().catch(() => ({}));
      return Array.isArray(j?.items) ? j.items : [];
    } catch (e) {
      console.warn("admin checkins by-range API threw", e);
      return [];
    }
  }

  // Heures sur une plage : tente l'RPC admin, puis fallback table shifts
  async function fetchHoursRange(fromIso, toIso, sellersList) {
    let base = null;

    // 1) RPC (bypass RLS si la fonction est SECURITY DEFINER)
    try {
      const { data, error } = await supabase.rpc("admin_hours_by_range", { p_from: fromIso, p_to: toIso });
      if (!error && Array.isArray(data)) {
        const dict = Object.fromEntries((sellersList || []).map((s) => [s.user_id, 0]));
        data.forEach((r) => {
          if (r?.seller_id) dict[r.seller_id] = Number(r.hours) || 0;
        });
        base = dict;
      } else {
        console.warn("RPC admin_hours_by_range KO -> fallback", error);
      }
    } catch (e) {
      console.warn("RPC admin_hours_by_range threw -> fallback", e);
    }

    // 2) Fallback direct sur shifts
    if (!base) {
      try {
        const { data: rows, error } = await supabase.from("shifts").select("seller_id, date, shift_code").gte("date", fromIso).lte("date", toIso);
        if (error) throw error;
        base = aggregateFromRows(rows, sellersList);
      } catch (e) {
        console.error("hours fallback error:", e);
        base = Object.fromEntries((sellersList || []).map((s) => [s.user_id, 0]));
      }
    }

    // 3) Applique les ajustements de pointage (retard/avance confirmés)
    let checkinRows = [];
    try {
      checkinRows = await fetchCheckinAdjustmentsRange(fromIso, toIso);
    } catch {}

    // Fallback ancien chemin si l'API n'est pas encore déployée mais que le rôle a accès
    if (!Array.isArray(checkinRows) || checkinRows.length === 0) {
      try {
        const { data: fallbackRows, error: checkinErr } = await supabase
          .from("daily_checkins")
          .select("seller_id, late_minutes, early_minutes, confirmed_at, day")
          .gte("day", fromIso)
          .lte("day", toIso)
          .not("confirmed_at", "is", null);
        if (!checkinErr && Array.isArray(fallbackRows)) {
          checkinRows = fallbackRows;
        }
      } catch (e) {
        console.warn("checkins hours direct fallback failed", e);
      }
    }

    base = applyCheckinAdjustments(base, checkinRows || []);

    // 4) Ajoute le travail en plus / couverture validé par l'admin
    try {
      const extraWork = await fetchExtraWorkRange(fromIso, toIso, sellersList);
      return applyExtraWorkHours(base, extraWork);
    } catch {
      return base;
    }
  }

  // Heures semaine — du lundi de la semaine courante jusqu’à AUJOURD’HUI (inclus)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!sellers || sellers.length === 0) {
        setWeekTotals({});
        return;
      }
      const weekStartIso = fmtISODate(startOfWeek(new Date()));
      const dict = await fetchHoursRange(weekStartIso, todayIso, sellers);
      if (!cancelled) setWeekTotals(dict);
    })();
    return () => {
      cancelled = true;
    };
  }, [sellers, refreshKey, todayIso, shiftTypeRows]);

  // Heures mois — jusqu’à AUJOURD’HUI si mois courant, sinon jusqu’à fin du mois sélectionné
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!sellers || sellers.length === 0) {
        setMonthTotals({});
        return;
      }
      setLoading(true);
      try {
        const upper = todayIso < monthTo ? todayIso : monthTo;
        if (upper < monthFrom) {
          setMonthTotals({});
          return;
        }
        const dict = await fetchHoursRange(monthFrom, upper, sellers);
        if (!cancelled) setMonthTotals(dict);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sellers, monthFrom, monthTo, refreshKey, todayIso, shiftTypeRows]);

  // Jours de congé pris sur l'année en cours (approved, jusqu’à aujourd'hui inclus)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!sellers || sellers.length === 0) {
        setAnnualLeaveDays({});
        return;
      }
      const now = new Date();
      const yearStart = `${now.getFullYear()}-01-01`;
      const yearEnd = `${now.getFullYear()}-12-31`;

      const { data } = await supabase
        .from("leaves")
        .select("seller_id, start_date, end_date, status")
        .eq("status", "approved")
        .lte("start_date", yearEnd)
        .gte("end_date", yearStart);

      const dict = Object.fromEntries(sellers.map((s) => [s.user_id, 0]));
      (data || []).forEach((l) => {
        const start = l.start_date > yearStart ? l.start_date : yearStart;
        const endLimit = todayIso < yearEnd ? todayIso : yearEnd;
        const end = l.end_date < endLimit ? l.end_date : endLimit;
        if (start <= end) {
          const days = (new Date(end + "T00:00:00") - new Date(start + "T00:00:00")) / (1000 * 60 * 60 * 24) + 1;
          dict[l.seller_id] = (dict[l.seller_id] || 0) + Math.max(0, Math.floor(days));
        }
      });
      if (!cancelled) setAnnualLeaveDays(dict);
    })();
    return () => {
      cancelled = true;
    };
  }, [sellers, refreshKey, todayIso]);

  // Compteur d'absences du mois (approved, passées + à venir)
  const absencesCount = useMemo(() => {
    const all = [...(monthAbsences || []), ...(monthUpcomingAbsences || [])];
    const dict = Object.fromEntries((sellers || []).map((s) => [s.user_id, 0]));
    all.forEach((a) => {
      if (a?.seller_id) dict[a.seller_id] = (dict[a.seller_id] || 0) + 1;
    });
    return dict;
  }, [sellers, monthAbsences, monthUpcomingAbsences]);

  if (!sellers || sellers.length === 0) {
    return (
      <div className="card">
        <div className="hdr mb-2">Total heures vendeuses</div>
        <div className="text-sm text-gray-600">Aucune vendeuse enregistrée.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="hdr mb-1">Total heures - semaine en cours (jusqu’à aujourd’hui) & mois : {monthLabel}</div>
      {loading && <div className="text-sm text-gray-500 mb-3">Calcul en cours…</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {sellers.map((s) => {
          const week = weekTotals[s.user_id] ?? 0;
          const month = monthTotals[s.user_id] ?? 0;
          const absCount = absencesCount[s.user_id] ?? 0;
          const leaveDays = annualLeaveDays[s.user_id] ?? 0;
          return (
            <div key={s.user_id} className="border rounded-2xl p-2.5 space-y-1.5">
              <div className="flex items-center">
                <Chip name={s.full_name} />
              </div>
              <div className="text-sm text-gray-600">Semaine (jusqu’à aujourd’hui)</div>
              <div className="text-xl font-semibold">{Number(week).toFixed(1)} h</div>
              <div className="text-sm text-gray-600 mt-2">Mois ({monthLabel})</div>
              <div className="text-xl font-semibold">{Number(month).toFixed(1)} h</div>
              <div className="text-sm text-gray-600 mt-2">Absences (mois)</div>
              <div className="text-2xl font-semibold">{absCount}</div>
              <div className="text-sm text-gray-600 mt-2">Congés pris (année)</div>
              <div className="text-2xl font-semibold">{leaveDays}</div>
            </div>
          );
        })}
      </div>
      <div className="text-xs text-gray-500 mt-3">
        Les totaux incluent les ajustements de pointage et le travail en plus validé dans la page “Retards / relais”.
      </div>
    </div>
  );
}

