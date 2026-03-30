// pages/admin.js
/* Admin page – stable (stop profiles recursion + show totals via RPC)
   - Avoid any .from("profiles") calls in the client
   - Compute names with nameFromId (built from sellers list)
   - Totals use admin_hours_by_range RPC first, then fallback to direct shifts

   + TRAVAIL EN PLUS / RETARDS SOIR
   - Bloc admin pour saisir un travail en plus / une couverture
   - Bloc admin pour traiter les retards du shift 13h30
   - Les totaux incluent public.extra_work_entries via admin_extra_work_by_range
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

/* ---- Helpers horaires ---- */
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
function toTimeWithSeconds(str) {
  const s = String(str || "").trim();
  if (!s) return "";
  return /^\d{1,2}:\d{2}$/.test(s) ? `${s}:00` : s;
}
function toInputHHMM(str) {
  return String(str || "").slice(0, 5);
}
function relayRowKey(row) {
  return `${row?.work_date || ""}|${row?.late_seller_id || ""}|${row?.shift_code || ""}`;
}
function extraWorkKindLabel(kind) {
  if (kind === "coverage") return "Couverture";
  if (kind === "relay") return "Relai";
  return "Travail en plus";
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
function shiftHumanLabel(code) {
  return SHIFT_LABELS[code] || code || "-";
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

  // Refs pour contrôler les reloads
  const reloadInFlight = useRef(false);
  const lastWakeRef = useRef(0);
  const prevLateRelayCountRef = useRef(0);
  // UI: jour sélectionné pour les blocs “retards soir” et “travail en plus”
  const [handoverDate, setHandoverDate] = useState(todayIso);
  const [showHandoverManager, setShowHandoverManager] = useState(false);

  const openHandover = useCallback((iso) => {
    setHandoverDate(iso || todayIso);
    setShowHandoverManager(true);
    setTimeout(() => {
      const wrap = document.getElementById("handover-day");
      if (wrap?.scrollIntoView) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, [todayIso]);

  const closeHandover = useCallback(() => {
    setShowHandoverManager(false);
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

/* ======= TRAVAIL EN PLUS + RETARDS SOIR À TRAITER ======= */
  const [extraWorkEntries, setExtraWorkEntries] = useState([]);
  const [extraWorkDayMap, setExtraWorkDayMap] = useState({});
  const [extraWorkForm, setExtraWorkForm] = useState({
    seller_id: "",
    start_time: "12:30",
    end_time: "13:30",
    kind: "manual_extra",
    reason: "Couverture absence matin",
    notes: "",
  });
  const [extraWorkSaving, setExtraWorkSaving] = useState(false);
  const [extraWorkDeletingId, setExtraWorkDeletingId] = useState("");

  const [lateRelayRows, setLateRelayRows] = useState([]);
  const [lateRelayDayMap, setLateRelayDayMap] = useState({});
  const [lateRelayOtherSellerByKey, setLateRelayOtherSellerByKey] = useState({});
  const [lateRelaySubmittingKey, setLateRelaySubmittingKey] = useState("");

  const getAdminAccessToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }, []);

  const fetchAdminJson = useCallback(
    async (url, options = {}) => {
      const token = await getAdminAccessToken();
      if (!token) throw new Error("Session introuvable");

      const headers = {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      };

      const res = await fetch(url, {
        cache: "no-store",
        ...options,
        headers,
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error || `Erreur API (${res.status})`);
      }
      return json;
    },
    [getAdminAccessToken]
  );

  const loadWeekExtraWork = useCallback(async () => {
    const from = fmtISODate(days[0]);
    const to = fmtISODate(days[6]);
    try {
      const json = await fetchAdminJson(`/api/admin/extra-work/list?from=${from}&to=${to}`);
      const rows = Array.isArray(json?.rows) ? json.rows : [];
      setExtraWorkEntries(rows);
      const grouped = {};
      rows.forEach((row) => {
        const iso = row.work_date;
        if (!grouped[iso]) grouped[iso] = [];
        grouped[iso].push(row);
      });
      setExtraWorkDayMap(grouped);
    } catch (e) {
      console.warn("loadWeekExtraWork error:", e?.message || e);
      setExtraWorkEntries([]);
      setExtraWorkDayMap({});
    }
  }, [days, fetchAdminJson]);

  const loadLateRelayRows = useCallback(async () => {
    const from = fmtISODate(days[0]);
    const to = fmtISODate(days[6]);
    try {
      const json = await fetchAdminJson(`/api/admin/late-relays/list?from=${from}&to=${to}`);
      const rows = Array.isArray(json?.rows) ? json.rows : [];
      setLateRelayRows(rows);
      const grouped = {};
      rows.forEach((row) => {
        const iso = row.work_date;
        if (!grouped[iso]) grouped[iso] = [];
        grouped[iso].push(row);
      });
      setLateRelayDayMap(grouped);
    } catch (e) {
      console.warn("loadLateRelayRows error:", e?.message || e);
      setLateRelayRows([]);
      setLateRelayDayMap({});
    }
  }, [days, fetchAdminJson]);

  const createExtraWorkEntry = useCallback(async () => {
    if (extraWorkSaving) return;
    const seller_id = extraWorkForm.seller_id || "";
    const start_time = (extraWorkForm.start_time || "").trim();
    const end_time = (extraWorkForm.end_time || "").trim();
    const reason = (extraWorkForm.reason || "Travail en plus").trim();
    const notes = (extraWorkForm.notes || "").trim();
    const kind = extraWorkForm.kind || "manual_extra";

    if (!handoverDate || !seller_id || !start_time || !end_time) {
      alert("Choisis le jour, la vendeuse, l'heure de début et l'heure de fin.");
      return;
    }
    const startMin = parseHHMM(start_time);
    const endMin = parseHHMM(end_time);
    if (startMin == null || endMin == null || endMin <= startMin) {
      alert("Plage horaire invalide.");
      return;
    }

    setExtraWorkSaving(true);
    try {
      await fetchAdminJson("/api/admin/extra-work/create", {
        method: "POST",
        body: JSON.stringify({
          work_date: handoverDate,
          seller_id,
          start_time: toTimeWithSeconds(start_time),
          end_time: toTimeWithSeconds(end_time),
          kind,
          reason,
          notes,
        }),
      });
      setExtraWorkForm((prev) => ({ ...prev, notes: "" }));
      await loadWeekExtraWork();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e?.message || "Impossible d'enregistrer le travail en plus.");
    } finally {
      setExtraWorkSaving(false);
    }
  }, [extraWorkForm, extraWorkSaving, fetchAdminJson, handoverDate, loadWeekExtraWork]);

  const deleteExtraWorkEntry = useCallback(
    async (id) => {
      if (!id || extraWorkDeletingId) return;
      setExtraWorkDeletingId(id);
      try {
        await fetchAdminJson("/api/admin/extra-work/delete", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        await loadWeekExtraWork();
        setRefreshKey((k) => k + 1);
      } catch (e) {
        alert(e?.message || "Impossible de supprimer l'entrée.");
      } finally {
        setExtraWorkDeletingId("");
      }
    },
    [extraWorkDeletingId, fetchAdminJson, loadWeekExtraWork]
  );

  const resolveLateRelay = useCallback(
    async (row, mode, coveringSellerId = "") => {
      const key = relayRowKey(row);
      if (!row || lateRelaySubmittingKey) return;

      const payload = {
        work_date: row.work_date,
        late_seller_id: row.late_seller_id,
        shift_code: row.shift_code || "EVENING",
        planned_start_time: row.planned_start_time || "13:30:00",
        actual_arrival_time: row.actual_arrival_time,
        late_minutes: Number(row.late_minutes || 0),
        coverage_status: mode,
        notes:
          mode === "covered"
            ? "Couverture validée par l'admin"
            : mode === "dismissed"
            ? "Ignoré par l'admin"
            : "Aucune couverture déclarée",
      };

      if (mode === "covered") {
        if (!coveringSellerId) {
          alert("Choisis la vendeuse qui a couvert.");
          return;
        }
        payload.covering_seller_id = coveringSellerId;
        payload.coverage_start_time = row.planned_start_time || "13:30:00";
        payload.coverage_end_time = row.actual_arrival_time;
      }

      setLateRelaySubmittingKey(key);
      try {
        await fetchAdminJson("/api/admin/late-relays/resolve", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        await Promise.all([loadLateRelayRows(), loadWeekExtraWork()]);
        setRefreshKey((k) => k + 1);
      } catch (e) {
        alert(e?.message || "Impossible d'enregistrer la décision.");
      } finally {
        setLateRelaySubmittingKey("");
      }
    },
    [fetchAdminJson, lateRelaySubmittingKey, loadLateRelayRows, loadWeekExtraWork]
  );

  useEffect(() => {
    const count = lateRelayRows?.length || 0;
    if (count > 0 && prevLateRelayCountRef.current === 0) {
      setShowHandoverManager(true);
      setHandoverDate((prev) => prev || lateRelayRows[0]?.work_date || todayIso);
    }
    prevLateRelayCountRef.current = count;
  }, [lateRelayRows, todayIso]);

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

    const chExtraWork = supabase
      .channel("extra_work_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "extra_work_entries" }, () => {
        loadWeekExtraWork();
        setRefreshKey((k) => k + 1);
      })
      .subscribe();

    const chLateRes = supabase
      .channel("late_arrival_resolutions_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "late_arrival_resolutions" }, () => {
        loadLateRelayRows();
        setRefreshKey((k) => k + 1);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(chAbs);
      supabase.removeChannel(chRepl);
      supabase.removeChannel(chLeaves);
      supabase.removeChannel(chCancel);
      supabase.removeChannel(chExtraWork);
      supabase.removeChannel(chLateRes);
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
    loadWeekExtraWork,
    loadLateRelayRows,
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
        loadWeekExtraWork(),
        loadLateRelayRows(),
        loadPendingAbs?.(),
        loadAbsencesToday?.(),
        loadReplacements?.(),
        loadLeavesUnified?.(),
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
    loadWeekExtraWork,
    loadLateRelayRows,
    loadPendingAbs,
    loadAbsencesToday,
    loadReplacements,
    loadLeavesUnified,
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
    if (!session) return;
    const id = setInterval(() => {
      loadLateRelayRows();
      loadWeekExtraWork();
    }, 30000);
    return () => clearInterval(id);
  }, [session, loadLateRelayRows, loadWeekExtraWork]);

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
      await Promise.all([
        loadSellers(),
        loadWeekAssignments(fmtISODate(days[0]), fmtISODate(days[6])),
        loadWeekExtraWork(),
        loadLateRelayRows(),
      ]);
      if (isMounted) setRefreshKey((k) => k + 1);
    };
    run();
    return () => {
      isMounted = false;
    };
  }, [days, loadSellers, loadWeekAssignments, loadWeekExtraWork, loadLateRelayRows]);


  // Badge bouton "Pointage" : vendeuses planifiées non pointées (alerte après 60 min)
  const [missingCheckinsCount, setMissingCheckinsCount] = useState(0);

  // Notifications UI (évite de spammer)
  const lastMissingCheckinsNotifiedRef = useRef({ count: 0, ts: 0 });

  const loadMissingCheckinsCount = useCallback(async () => {
    // Compte "Pointage" = uniquement les pointages manquants NON ACK (Marquer vu)
    // + on arrête de notifier/afficher après 2h (sinon ça spamme inutilement)
    function parisTodayISO() {
      try {
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
      } catch {
        return "";
      }
    }

    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) {
        setMissingCheckinsCount(0);
        return;
      }

      const r = await fetch("/api/admin/checkins/missing", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!r.ok) {
        // Si l'API n'existe pas encore sur un env, on ne casse pas l'admin
        setMissingCheckinsCount(0);
        return;
      }

      const j = await r.json().catch(() => ({}));
      const items = Array.isArray(j?.items) ? j.items : [];

      // ACK local (Marquer vu) stocké par /admin/checkins
      let seen = new Set();
      let day = "";
      try {
        day = (items[0]?.day || "") || parisTodayISO();
      } catch {
        day = parisTodayISO();
      }

      if (typeof window !== "undefined" && day) {
        try {
          const raw = window.localStorage?.getItem(`seen_missing_checkins_${day}`) || "[]";
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) seen = new Set(arr);
        } catch {}
      }

      // Règle: on ignore après 2h (120 min) pour éviter badge/notifications "fantômes"
      const filtered = items.filter((it) => {
        const k = `${it.day || day}:${it.seller_id}:${it.shift_code}`;
        if (seen.has(k)) return false;

        const mins = Number(it?.minutes_since_start ?? it?.minutes_since ?? 0);
        if (Number.isFinite(mins) && mins >= 120) return false;

        return true;
      });

      setMissingCheckinsCount(filtered.length);
    } catch {
      setMissingCheckinsCount(0);
    }
  }, []);

  useEffect(() => {
    // ✅ Toujours tenter, même si la variable `session` n'est pas encore prête.
    // L'API est protégée: sans token => count = 0, sans casser l'admin.
    loadMissingCheckinsCount();
    const id = setInterval(loadMissingCheckinsCount, 60 * 1000);
    return () => clearInterval(id);
  }, [loadMissingCheckinsCount]);


  // Rafraîchir immédiatement quand on revient sur l'onglet (évite badge qui reste "bloqué")
  useEffect(() => {
    if (typeof window === "undefined") return;

    const onFocus = () => loadMissingCheckinsCount();
    const onVis = () => {
      try {
        if (document.visibilityState === "visible") loadMissingCheckinsCount();
      } catch {}
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadMissingCheckinsCount]);

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
    const n = Number(missingCheckinsCount || 0);
    if (n <= 0) return;

    const now = Date.now();
    const last = lastMissingCheckinsNotifiedRef.current || { count: 0, ts: 0 };

    // Notifier si le nombre augmente, ou toutes les 30 min si ça persiste
    const shouldNotify = n > (last.count || 0) || now - (last.ts || 0) > 30 * 60 * 1000;
    if (!shouldNotify) return;

    lastMissingCheckinsNotifiedRef.current = { count: n, ts: now };

    let cancelled = false;

    (async () => {
      try {
        if (!("Notification" in window) || Notification.permission !== "granted") return;

        const title = "⏱️ Pointage manquant";
        const body = `${n} pointage(s) manquant(s). Ouvre “Pointage” pour traiter.`;

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
                tag: "admin-missing-checkins",
                renotify: true,
                requireInteraction: false,
                icon: "/icons/icon-192.png",
                badge: "/icons/icon-192.png",
                data: { url: "/admin/checkins" },
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
            new Notification(title, { body, tag: "admin-missing-checkins" });
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
  }, [missingCheckinsCount]);


  /* ---------- RENDER ---------- */

  const mhAwaitingSellerCount =
    mhPendingCount == null || mhToReviewCount == null ? null : Math.max(0, (mhPendingCount || 0) - (mhToReviewCount || 0));

  // ✅ Badge bouton: total global à traiter si dispo, sinon mois sélectionné
  const mhBadgeCount = mhToReviewTotal ?? mhToReviewCount;
  const handoverBadgeCount = lateRelayRows?.length || 0;
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
                <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/admin/sellers" legacyBehavior>
                          <a className="btn">👥 Gérer les vendeuses</a>
                        </Link>

                        <Link href="/admin/checkins" legacyBehavior>
                          <a
                            className="btn"
                            title="Pointages manquants (alerte après 1h)"
                            style={{ position: "relative", overflow: "visible" }}
                          >
                            ⏱️ Pointage
                            {missingCheckinsCount > 0 ? (
                              <span
                                title={`${missingCheckinsCount} pointage(s) manquant(s)`}
                                style={{
                                  position: "absolute",
                                  top: -6,
                                  right: -6,
                                  minWidth: 20,
                                  height: 20,
                                  padding: "0 6px",
                                  borderRadius: 999,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontSize: 12,
                                  fontWeight: 900,
                                  background: "#ef4444",
                                  color: "#fff",
                                  border: "2px solid #fff",
                                  boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
                                  lineHeight: "20px",
                                }}
                              >
                                {missingCheckinsCount}
                              </span>
                            ) : null}

                          </a>
                        </Link>

                        <a className="btn" href="/admin/supervisors">🖥️ Superviseur</a>

                        {/* ✅ Bouton UNIQUE en haut + badge rouge type notification */}
                        <Link href="/admin/monthly-hours" legacyBehavior>
                          <a className="btn" title="Validation des heures mensuelles" style={{ position: "relative", overflow: "visible" }}>
                            🧾 Heures mensuelles

                            {mhBadgeCount != null && mhBadgeCount > 0 ? (
                              <span
                                title={`${mhBadgeCount} à valider/refuser`}
                                style={{
                                  position: "absolute",
                                  top: -6,
                                  right: -6,
                                  minWidth: 20,
                                  height: 20,
                                  padding: "0 6px",
                                  borderRadius: 999,
                                  background: "#dc2626",
                                  color: "#fff",
                                  fontSize: 12,
                                  fontWeight: 800,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  lineHeight: "20px",
                                  border: "2px solid #fff",
                                  boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                                  zIndex: 20,
                                }}
                              >
                                {mhBadgeCount > 99 ? "99+" : mhBadgeCount}
                              </span>
                            ) : null}
                          </a>
                        </Link>

                        <button
                          type="button"
                          className="btn"
                          title="Retards / relais et travail en plus"
                          onClick={() => {
                            if (showHandoverManager) {
                              closeHandover();
                            } else {
                              openHandover(lateRelayRows[0]?.work_date || handoverDate || todayIso);
                            }
                          }}
                          style={{ position: "relative", overflow: "visible" }}
                        >
                          ⏱️ Retards / relais
                          {handoverBadgeCount > 0 ? (
                            <span
                              title={`${handoverBadgeCount} retard(s) après-midi à traiter`}
                              style={{
                                position: "absolute",
                                top: -6,
                                right: -6,
                                minWidth: 20,
                                height: 20,
                                padding: "0 6px",
                                borderRadius: 999,
                                background: "#dc2626",
                                color: "#fff",
                                fontSize: 12,
                                fontWeight: 800,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                lineHeight: "20px",
                                border: "2px solid #fff",
                                boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                                zIndex: 20,
                              }}
                            >
                              {handoverBadgeCount > 99 ? "99+" : handoverBadgeCount}
                            </span>
                          ) : null}
                        </button>

                        <Link href="/admin/leaves" legacyBehavior>
                          <a className="btn">🏖️ Congés</a>
                        </Link>
          </div>

          <button
            type="button"
            className="btn"
            onClick={handleSignOut}
            disabled={signingOut}
            style={{
              backgroundColor: "#dc2626",
              borderColor: "transparent",
              color: "#fff",
            }}
          >
            {signingOut ? "Déconnexion…" : "Se déconnecter"}
          </button>
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
              ⚠️ {missingCheckinsCount} pointage(s) manquant(s)
            </div>
            <div className="text-sm" style={{ marginTop: 4, color: "#7f1d1d" }}>
              Tu peux les traiter depuis{" "}
              <Link href="/admin/checkins" legacyBehavior>
                <a style={{ textDecoration: "underline", fontWeight: 800 }}>Pointage</a>
              </Link>
              .
            </div>
          </div>
        ) : null}

        {handoverBadgeCount > 0 && !showHandoverManager ? (
          <div
            className="card"
            style={{
              borderColor: "#fde68a",
              background: "#fffbeb",
              padding: "10px 12px",
            }}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm" style={{ fontWeight: 800, color: "#92400e" }}>
                  ⚠️ {handoverBadgeCount} retard(s) de l’après-midi à traiter
                </div>
                <div className="text-sm" style={{ marginTop: 4, color: "#78350f" }}>
                  Ouvre le bloc “Retards / relais” pour indiquer si quelqu’un a couvert entre 13h30 et l’heure réelle d’arrivée.
                </div>
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => openHandover(lateRelayRows[0]?.work_date || handoverDate || todayIso)}
                style={{ backgroundColor: "#f59e0b", borderColor: "transparent", color: "#111827" }}
              >
                Ouvrir retards / relais
              </button>
            </div>
          </div>
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

        <TodayColorBlocks today={today} todayIso={todayIso} assign={assign} nameFromId={nameFromId} />

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

              const dayExtraRows = extraWorkDayMap[iso] || [];
              const dayLateRelayRows = lateRelayDayMap[iso] || [];
              const dayInfoCount = dayExtraRows.length + dayLateRelayRows.length;

              return (
                <div
                  key={iso}
                  className="border rounded-2xl p-3 space-y-3"
                  style={highlight ? { boxShadow: "inset 0 0 0 2px rgba(37,99,235,0.5)" } : {}}
                >
                  <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{iso}</div>
                    {dayInfoCount > 0 ? (
                      <span
                        title={`Éléments à revoir : ${dayInfoCount}`}
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
                        {dayInfoCount}
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
                    label="Matin (6h30-13h30)"
                    iso={iso}
                    code="MORNING"
                    value={assign[`${iso}|MORNING`] || ""}
                    onChange={save}
                    sellers={sellers}
                    chipName={nameFromId(assign[`${iso}|MORNING`])}
                  />

                  {!sunday ? (
                    <ShiftRow
                      label="Midi (6h30-13h30)"
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
                          <div className="text-xs mb-1">6h30-13h30</div>
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
                          <div className="text-xs mb-1">9h-13h30</div>
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
                    label="Soir (13h30-20h30)"
                    iso={iso}
                    code="EVENING"
                    value={assign[`${iso}|EVENING`] || ""}
                    onChange={save}
                    sellers={sellers}
                    chipName={nameFromId(assign[`${iso}|EVENING`])}
                  />
                

                  <div
                    className="mt-2 flex items-center justify-between gap-2 border rounded-2xl px-3 py-2"
                    style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}
                  >
                    <div className="text-xs text-gray-700">
                      ⏱️ Travail en plus / retards soir
                      {dayLateRelayRows.length > 0 ? (
                        <span
                          className="ml-2"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minWidth: 20,
                            height: 20,
                            padding: "0 6px",
                            borderRadius: 999,
                            background: "#dc2626",
                            color: "#fff",
                            fontSize: 12,
                            fontWeight: 800,
                            lineHeight: "20px",
                          }}
                        >
                          {dayLateRelayRows.length}
                        </span>
                      ) : null}
                      {dayExtraRows.length > 0 ? (
                        <span className="ml-2 text-green-700 font-medium">+ {dayExtraRows.length} saisie(s)</span>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      className="btn"
                      onClick={() => openHandover(iso)}
                      title="Ouvrir le bloc travail en plus / retards"
                      style={{ padding: "0.35rem 0.6rem", borderRadius: "0.9rem" }}
                    >
                      Ouvrir
                    </button>
                  </div>

</div>
              );
            })}
            </div>
          </div>
        </div>




{/* ===================== TRAVAIL EN PLUS / RETARDS SOIR ===================== */}
{showHandoverManager ? (
        <>
        <div
          className="card"
          style={{
            borderColor: handoverBadgeCount > 0 ? "#fde68a" : "#e5e7eb",
            background: handoverBadgeCount > 0 ? "#fffdf5" : "#f8fafc",
          }}
          id="handover-day"
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="hdr mb-1">Retards / relais et travail en plus</div>
              <div className="text-sm text-gray-600">
                Gère ici les retards de l’après-midi, les couvertures et les arrivées anticipées exceptionnelles.
              </div>
            </div>
            <button type="button" className="btn" onClick={closeHandover}>
              Fermer
            </button>
          </div>
        </div>

<div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="card">
            <div className="hdr mb-2">Retards du soir à traiter {lateRelayRows.length > 0 ? `(${lateRelayRows.length})` : ""}</div>
            <div className="text-sm text-gray-600">
              Quand une vendeuse du shift <span className="font-medium">13h30</span> arrive en retard,
              indique ici si la caisse a été couverte en attendant.
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <div className="text-sm mb-1">Jour</div>
                <select className="input" value={handoverDate} onChange={(e) => setHandoverDate(e.target.value)}>
                  {days.map((d) => {
                    const iso = fmtISODate(d);
                    return (
                      <option key={iso} value={iso}>
                        {capFirst(weekdayFR(d))} {iso}
                      </option>
                    );
                  })}
                </select>
              </div>

              <button type="button" className="btn" onClick={() => setHandoverDate(todayIso)}>
                Aujourd’hui
              </button>
            </div>

            {(() => {
              const rows = lateRelayDayMap[handoverDate] || [];
              if (!rows.length) {
                return <div className="text-sm text-gray-600 mt-4">Aucun retard soir non traité pour ce jour.</div>;
              }

              return (
                <div className="mt-4 space-y-3">
                  {rows.map((row) => {
                    const rowKey = relayRowKey(row);
                    const submitting = lateRelaySubmittingKey === rowKey;
                    const otherSeller = lateRelayOtherSellerByKey[rowKey] || "";
                    const otherOptions = (sellers || []).filter((s) => s.user_id !== row.late_seller_id);

                    return (
                      <div key={rowKey} className="border rounded-2xl p-3" style={{ borderColor: "#e5e7eb" }}>
                        <div className="font-semibold text-red-700">⚠️ Retard détecté : {row.late_seller_name || nameFromId(row.late_seller_id) || "-"}</div>
                        <div className="text-sm text-gray-700 mt-1">
                          Prévu : <span className="font-medium">{toInputHHMM(row.planned_start_time) || "13:30"}</span>
                          {" · "}
                          Arrivée : <span className="font-medium">{toInputHHMM(row.actual_arrival_time) || "-"}</span>
                          {" · "}
                          Retard : <span className="font-medium text-red-700">{fmtDeltaMinutes(Number(row.late_minutes || 0))}</span>
                        </div>
                        <div className="text-sm text-gray-600 mt-2">La caisse a-t-elle été couverte jusqu’à son arrivée ?</div>

                        {(row.morning_sellers || []).length > 0 ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {(row.morning_sellers || []).map((ms) => (
                              <button
                                key={ms.id}
                                type="button"
                                className="btn"
                                disabled={submitting}
                                onClick={() => resolveLateRelay(row, "covered", ms.id)}
                                style={{ backgroundColor: "#16a34a", borderColor: "transparent", color: "#fff" }}
                              >
                                Oui, par {ms.full_name}
                              </button>
                            ))}
                          </div>
                        ) : null}

                        <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
                          <div>
                            <div className="text-sm mb-1">Oui, par une autre vendeuse</div>
                            <select
                              className="input"
                              value={otherSeller}
                              onChange={(e) =>
                                setLateRelayOtherSellerByKey((prev) => ({
                                  ...prev,
                                  [rowKey]: e.target.value,
                                }))
                              }
                            >
                              <option value="">— Choisir —</option>
                              {otherOptions.map((s) => (
                                <option key={s.user_id} value={s.user_id}>
                                  {s.full_name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            className="btn"
                            disabled={submitting || !otherSeller}
                            onClick={() => resolveLateRelay(row, "covered", otherSeller)}
                          >
                            Valider la couverture
                          </button>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn"
                            disabled={submitting}
                            onClick={() => resolveLateRelay(row, "not_covered")}
                            style={{ backgroundColor: "#dc2626", borderColor: "transparent", color: "#fff" }}
                          >
                            Non
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={submitting}
                            onClick={() => resolveLateRelay(row, "dismissed")}
                          >
                            Ignorer
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>

          <div className="card">
            <div className="hdr mb-2">Travail en plus / couverture {extraWorkEntries.length > 0 ? `(${extraWorkEntries.length})` : ""}</div>
            <div className="text-sm text-gray-600">
              Saisie admin pour les cas exceptionnels. Le pointage normal ne change pas, mais ces minutes
              s’ajoutent directement aux totaux.
            </div>

            <div className="mt-4 grid gap-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-sm mb-1">Jour</div>
                  <select className="input" value={handoverDate} onChange={(e) => setHandoverDate(e.target.value)}>
                    {days.map((d) => {
                      const iso = fmtISODate(d);
                      return (
                        <option key={iso} value={iso}>
                          {capFirst(weekdayFR(d))} {iso}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div>
                  <div className="text-sm mb-1">Vendeuse</div>
                  <select
                    className="input"
                    value={extraWorkForm.seller_id}
                    onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, seller_id: e.target.value }))}
                  >
                    <option value="">— Choisir —</option>
                    {sellers.map((s) => (
                      <option key={s.user_id} value={s.user_id}>
                        {s.full_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-sm mb-1">Heure début</div>
                  <input
                    type="time"
                    className="input"
                    value={extraWorkForm.start_time}
                    onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, start_time: e.target.value }))}
                  />
                </div>
                <div>
                  <div className="text-sm mb-1">Heure fin</div>
                  <input
                    type="time"
                    className="input"
                    value={extraWorkForm.end_time}
                    onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, end_time: e.target.value }))}
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-sm mb-1">Type</div>
                  <select
                    className="input"
                    value={extraWorkForm.kind}
                    onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, kind: e.target.value }))}
                  >
                    <option value="manual_extra">Travail en plus</option>
                    <option value="coverage">Couverture</option>
                    <option value="relay">Relai</option>
                  </select>
                </div>
                <div>
                  <div className="text-sm mb-1">Motif</div>
                  <input
                    className="input"
                    value={extraWorkForm.reason}
                    onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, reason: e.target.value }))}
                    placeholder="Ex: Couverture absence matin"
                  />
                </div>
              </div>

              <div>
                <div className="text-sm mb-1">Notes (optionnel)</div>
                <textarea
                  className="input"
                  rows={3}
                  value={extraWorkForm.notes}
                  onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder="Ex: arrivée à 12h30 au lieu de 13h30"
                />
              </div>

              <div className="flex justify-end">
                <button type="button" className="btn" onClick={createExtraWorkEntry} disabled={extraWorkSaving}>
                  {extraWorkSaving ? "Enregistrement…" : "Enregistrer"}
                </button>
              </div>
            </div>

            <div className="mt-5 border-t pt-4" style={{ borderColor: "#e5e7eb" }}>
              <div className="text-sm font-medium mb-2">Saisies du jour sélectionné</div>
              {(() => {
                const rows = extraWorkDayMap[handoverDate] || [];
                if (!rows.length) {
                  return <div className="text-sm text-gray-600">Aucune saisie pour ce jour.</div>;
                }
                return (
                  <div className="space-y-2">
                    {rows.map((row) => (
                      <div
                        key={row.id}
                        className="border rounded-2xl px-3 py-2 flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
                        style={{ borderColor: "#e5e7eb" }}
                      >
                        <div>
                          <div className="text-sm font-medium">
                            {row.seller_name || nameFromId(row.seller_id) || "-"} · {extraWorkKindLabel(row.kind)}
                          </div>
                          <div className="text-xs text-gray-600 mt-1">
                            {toInputHHMM(row.start_time)} → {toInputHHMM(row.end_time)}
                            {" · "}
                            <span className="font-medium text-green-700">{fmtDeltaMinutes(Number(row.minutes || 0))}</span>
                            {row.reason ? ` · ${row.reason}` : ""}
                          </div>
                          {row.notes ? <div className="text-xs text-gray-500 mt-1">{row.notes}</div> : null}
                        </div>
                        <button
                          type="button"
                          className="btn"
                          disabled={extraWorkDeletingId === row.id}
                          onClick={() => {
                            if (confirm("Supprimer cette saisie ?")) deleteExtraWorkEntry(row.id);
                          }}
                          style={{ backgroundColor: "#fff", color: "#111827", borderColor: "#ef4444" }}
                        >
                          Supprimer
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
        </>
      ) : null}


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

function TodayColorBlocks({ today, todayIso, assign, nameFromId }) {
  const codes = ["MORNING", "MIDDAY", ...(isSunday(today) ? ["SUNDAY_EXTRA"] : []), "EVENING"];
  return (
    <div className="card">
      <div className="hdr mb-2">Planning du jour</div>
      <div className={`grid ${isSunday(today) ? "md:grid-cols-4" : "md:grid-cols-3"} gap-3`}>
        {codes.map((code) => {
          const label = SHIFT_LABELS[code];
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

function TotalsGrid({ sellers, monthFrom, monthTo, monthLabel, refreshKey, monthAbsences = [], monthUpcomingAbsences = [] }) {
  const [weekTotals, setWeekTotals] = useState({});
  const [monthTotals, setMonthTotals] = useState({});
  const [annualLeaveDays, setAnnualLeaveDays] = useState({});
  const [loading, setLoading] = useState(false);

  const todayIso = fmtISODate(new Date());

  // Agrégateur simple côté client
  function aggregateFromRows(rows, sellersList) {
    const dict = Object.fromEntries((sellersList || []).map((s) => [s.user_id, 0]));
    (rows || []).forEach((r) => {
      const h = SHIFT_HOURS[r.shift_code] ?? 0;
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
  }, [sellers, refreshKey, todayIso]);

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
  }, [sellers, monthFrom, monthTo, refreshKey, todayIso]);

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
        Les totaux incluent le pointage confirmé ainsi que le travail en plus / la couverture saisis par l’admin.
      </div>
    </div>
  );
}
