/* pages/admin.js - unified, fixed structure (2025-10-11 16:14)
   - Single default export (AdminPage)
   - All React hooks are inside the component (no hooks at top-level)
   - Adds missing BUILD_TAG constant
   - Keeps your logic (absences/leaves/replacements/totals) intact
*/

import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState, useCallback } from "react";

import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";
import WeekNav from "../components/WeekNav";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "../lib/date";

/* ---------- CONSTANTES / UTILS GLOBAUX (SANS HOOKS) ---------- */

const BUILD_TAG = "ADMIN - 11/10/2025 08:00";

// Heures par créneau (inclut le dimanche spécial)
const SHIFT_HOURS = { MORNING: 7, MIDDAY: 6, EVENING: 7, SUNDAY_EXTRA: 4.5 };
// Libellés + créneau dimanche (doit exister dans shift_types)
const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9h-13h30" };

// Couleurs fixes par vendeuse
const SELLER_COLORS = {
  Antonia: "#e57373",
  Olivia: "#64b5f6",
  Colleen: "#81c784",
  Ibtissam: "#ba68c8",
};
const colorForName = (name) => SELLER_COLORS[name] || "#9e9e9e";

// Utils date / libellés
function firstDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function lastDayOfMonth(d)  { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function monthInputValue(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function labelMonthFR(d)    { return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }); }
const isSunday   = (d) => d.getDay() === 0;
const weekdayFR  = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });
const capFirst   = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const betweenIso = (iso, start, end) => iso >= start && iso <= end;
const frDate = (iso) => { try { return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR"); } catch { return iso; } };
const isSameISO = (d, iso) => fmtISODate(d) === iso;

/* ---------- PETITS COMPOSANTS SANS HOOKS ---------- */
function Chip({ name }) {
  if (!name || name === "-") return <span className="text-sm text-gray-500">-</span>;
  const bg = colorForName(name);
  return (
    <span
      style={{ backgroundColor: bg, color: "#fff", borderRadius: 9999, padding: "2px 10px", fontSize: "0.8rem" }}
    >
      {name}
    </span>
  );
}
const ApproveBtn = ({ onClick, children = "Approuver" }) => (
  <button type="button" className="btn" onClick={onClick}
    style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}>
    {children}
  </button>
);
const RejectBtn  = ({ onClick, children = "Rejeter" }) => (
  <button type="button" className="btn" onClick={onClick}
    style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}>
    {children}
  </button>
);
function shiftHumanLabel(code) { return SHIFT_LABELS[code] || code || "-"; }

/* ---------- PAGE PRINCIPALE (TOUS LES HOOKS ICI) ---------- */
export default function AdminPage() {
  const r = useRouter();
  const { session, profile, loading } = useAuth();

  // Sécurité / redirections
  useEffect(() => {
    if (loading) return;
    if (!session) { r.replace("/login"); return; }
    if (isAdminEmail(session.user?.email)) return;
    if (profile?.role !== "admin") r.replace("/app");
  }, [session, profile, loading, r]);

  

  // Semaine affichée
  const [monday, setMonday] = useState(startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(monday, i)), [monday]);

  // Mois pour les totaux (sélecteur en bas)
  const [selectedMonth, setSelectedMonth] = useState(firstDayOfMonth(new Date()));
  const monthFrom = fmtISODate(firstDayOfMonth(selectedMonth));
  const monthTo   = fmtISODate(lastDayOfMonth(selectedMonth));

  // Données UI
  const [sellers, setSellers] = useState([]);               // [{user_id, full_name}]
  const [assign, setAssign] = useState({});                 // "YYYY-MM-DD|SHIFT" -> seller_id
  const [absencesByDate, setAbsencesByDate] = useState({}); // { "YYYY-MM-DD": [seller_id,...] }
  const [absencesToday, setAbsencesToday] = useState([]);   // d’aujourd’hui (pending/approved)
  const [pendingAbs, setPendingAbs] = useState([]);         // absences à venir (pending)
  const [replList, setReplList] = useState([]);             // volontaires (pending) sur absences approuvées
  const [selectedShift, setSelectedShift] = useState({});   // {replacement_interest_id: "MIDDAY"}
  const [latestRepl, setLatestRepl] = useState(null);       // bannière: dernier volontariat reçu

  // Congés
  const [pendingLeaves, setPendingLeaves] = useState([]);   // congés en attente (à venir ou en cours)
  const [latestLeave, setLatestLeave] = useState(null);     // bannière congé la plus récente (pending)
  const [approvedLeaves, setApprovedLeaves] = useState([]); // congés approuvés (end_date >= today)

  // Absences approuvées du mois sélectionné
  const [monthAbsences, setMonthAbsences] = useState([]);           // passées/aujourd’hui (items avec id)
  const [monthUpcomingAbsences, setMonthUpcomingAbsences] = useState([]); // à venir (items avec id)

  // Remplacements acceptés du mois (absence_id -> { volunteer_id, volunteer_name, shift })
  const [monthAcceptedRepl, setMonthAcceptedRepl] = useState({});

  // Bannière éphémère quand une vendeuse annule son absence (DELETE)
  const [latestCancel, setLatestCancel] = useState(null);   // { name, date }

  const [refreshKey, setRefreshKey] = useState(0);          // recalcul totaux mois
  const today = new Date();
  const todayIso = fmtISODate(today);

  // Déconnexion robuste
  const [signingOut, setSigningOut] = useState(false);
  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      if (typeof navigator !== "undefined" && navigator?.clearAppBadge) {
        try { await navigator.clearAppBadge(); } catch {}
      }
      await supabase.auth.signOut();
    } finally {
      setSigningOut(false);
      r.replace("/login");
    }
  }, [r, signingOut]);

  /* Vendeuses (robuste : RPC list_sellers -> profiles fallback) */
  const loadSellers = useCallback(async () => {
    let rows = [];
    try {
      const { data, error } = await supabase.rpc("list_sellers");
      if (error) console.warn("list_sellers RPC error:", error);
      if (Array.isArray(data) && data.length) rows = data;
    } catch (e) {
      console.warn("list_sellers RPC threw:", e);
    }
    if (rows.length === 0) {
      try {
        const { data: profs, error: e2 } = await supabase
          .from("profiles")
          .select("user_id, full_name, role, active")
          .eq("role", "seller");
        if (e2) console.warn("profiles fallback error:", e2);
        if (Array.isArray(profs) && profs.length) {
          rows = profs.map(({ user_id, full_name }) => ({ user_id, full_name }));
        }
      } catch (e) {
        console.warn("profiles fallback threw:", e);
      }
    }
    setSellers(rows || []);
  }, []);

  /* ✅ Index vendeuses + helper id→nom */
  const sellersById = useMemo(
    () => new Map((sellers || []).map((s) => [s.user_id, s])),
    [sellers]
  );
  const nameFromId = useCallback(
    (id) => {
      if (!id) return "";
      const s = sellersById.get(id);
      return s?.full_name || "";
    },
    [sellersById]
  );

  /* Planning semaine (avec fallback direct sur table shifts) */
  const loadWeekAssignments = useCallback(async (fromIso, toIso) => {
    let data = null, error = null;
    try {
      const res = await supabase.from("view_week_assignments").select("*").gte("date", fromIso).lte("date", toIso);
      data = res.data; error = res.error;
    } catch (e) { error = e; }
    if (error) console.warn("view_week_assignments error, fallback to shifts:", error);
    if (!data || data.length === 0) {
      const res2 = await supabase.from("shifts").select("date, shift_code, seller_id").gte("date", fromIso).lte("date", toIso);
      data = res2.data || [];
    }
    const next = {};
    (data || []).forEach((row) => { next[`${row.date}|${row.shift_code}`] = row.seller_id; });
    setAssign(next);
  }, []);
  useEffect(() => {
    const from = fmtISODate(days[0]);
    const to = fmtISODate(days[6]);
    loadWeekAssignments(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monday]);

  /* Absences d'aujourd'hui (avec remplacement accepté si existe) */
  const loadAbsencesToday = useCallback(async () => {
    const { data: abs, error } = await supabase
      .from("absences")
      .select("id, seller_id, status, reason, date")
      .eq("date", todayIso)
      .in("status", ["pending", "approved"]);
    if (error) console.error("absences today error:", error);

    const ids = (abs || []).map(a => a.id);
    let mapRepl = {};
    if (ids.length > 0) {
      const { data: repl } = await supabase
        .from("replacement_interest")
        .select("absence_id, volunteer_id, status")
        .in("absence_id", ids)
        .eq("status", "accepted");

      const volunteerIds = Array.from(new Set((repl || []).map(r => r.volunteer_id)));
      let names = {};
      if (volunteerIds.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", volunteerIds);
        (profs || []).forEach(p => { names[p.user_id] = p.full_name; });
      }
      (repl || []).forEach(r => {
        mapRepl[r.absence_id] = {
          volunteer_id: r.volunteer_id,
          volunteer_name: names[r.volunteer_id] || "-",
        };
      });
    }

    const rows = (abs || []).map(a => ({ ...a, replacement: mapRepl[a.id] || null }));
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

  /* Volontaires (absences approuvées) */
  const loadReplacements = useCallback(async () => {
    const { data: rows, error } = await supabase
  .from("replacement_interest")
  .select(`
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
  `)
  .eq("status", "pending")
  .eq("absences.status", "approved")
  .gte("absences.date", todayIso)
  .order("absences.date", { ascending: true });

    if (error) console.error("replacement list error:", error);

    const ids = new Set();
    (rows || []).forEach((r) => { if (r.volunteer_id) ids.add(r.volunteer_id); if (r.absences?.seller_id) ids.add(r.absences.seller_id); });
    let names = {};
    if (ids.size > 0) {
      const { data: profs } = await supabase.from("profiles").select("user_id, full_name").in("user_id", Array.from(ids));
      (profs || []).forEach((p) => (names[p.user_id] = p.full_name));
    }
    const list = (rows || []).map((r) => ({
      id: r.id, volunteer_id: r.volunteer_id, volunteer_name: names[r.volunteer_id] || "-",
      absence_id: r.absence_id, date: r.absences?.date, absent_id: r.absences?.seller_id,
      absent_name: names[r.absences?.seller_id] || "-", status: r.status,
    }));
    setReplList(list);
  }, [todayIso]);

  /* ======= CONGÉS ======= */
  const loadPendingLeaves = useCallback(async () => {
    const { data, error } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, reason, status, created_at")
      .eq("status", "pending")
      .gte("end_date", todayIso)
      .order("created_at", { ascending: false });
    if (error) console.error("pending leaves error:", error);
    setPendingLeaves(data || []);
  }, [todayIso]);

  const loadLatestLeave = useCallback(async () => {
    const { data, error } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, reason, status, created_at")
      .eq("status", "pending")
      .gte("end_date", todayIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) console.error("latest leave error:", error);
    if (!data || data.length === 0) { setLatestLeave(null); return; }
    const leave = data[0];
    const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", leave.seller_id).single();
    setLatestLeave({ ...leave, seller_name: prof?.full_name || "-" });
  }, [todayIso]);

  const loadApprovedLeaves = useCallback(async () => {
    const { data, error } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, reason, status")
      .eq("status", "approved")
      .gte("end_date", todayIso)
      .order("start_date", { ascending: true });
    if (error) console.error("approved leaves error:", error);
    setApprovedLeaves(data || []);
  }, [todayIso]);

  // Actions congés
  const approveLeave = useCallback(async (id) => {
    const { error } = await supabase.from("leaves").update({ status: "approved" }).eq("id", id);
    if (error) { alert("Impossible d'approuver (RLS ?)"); return; }
    await loadPendingLeaves(); await loadApprovedLeaves(); await loadLatestLeave();
  }, [loadPendingLeaves, loadApprovedLeaves, loadLatestLeave]);

  const rejectLeave = useCallback(async (id) => {
    const { error } = await supabase.from("leaves").update({ status: "rejected" }).eq("id", id);
    if (error) { alert("Impossible de rejeter (RLS ?)"); return; }
    await loadPendingLeaves(); await loadApprovedLeaves(); await loadLatestLeave();
  }, [loadPendingLeaves, loadApprovedLeaves, loadLatestLeave]);

  const cancelFutureLeave = useCallback(async (id) => {
    const { data: leave } = await supabase.from("leaves").select("start_date,status").eq("id", id).single();
    if (!leave) { alert("Congé introuvable."); return; }
    if (!(leave.status === "approved" || leave.status === "pending")) { alert("Seuls les congés approuvés/en attente peuvent être annulés."); return; }
    const tIso = fmtISODate(new Date());
    if (!(leave.start_date > tIso)) { alert("On ne peut annuler que les congés à venir."); return; }

    const { error } = await supabase.from("leaves").delete().eq("id", id);
    if (error) { console.error(error); alert("Échec de l’annulation du congé."); return; }

    await loadPendingLeaves(); await loadApprovedLeaves(); await loadLatestLeave();
    alert("Congé à venir annulé. La vendeuse peut refaire une demande.");
  }, [loadPendingLeaves, loadApprovedLeaves, loadLatestLeave]);

  /* ======= ABSENCES DU MOIS (APPROUVÉES) ======= */
  const loadMonthAbsences = useCallback(async () => {
  const tIso = fmtISODate(new Date());
  // 1) RPC admin — récupère TOUTE la plage du mois, on filtre côté client
  try {
    const { data, error } = await supabase.rpc("admin_absences_by_range", { p_from: monthFrom, p_to: monthTo });
    if (!error && Array.isArray(data)) {
      const seen = new Set();
      const pastOrToday = [];
      (data || [])
        .filter(r => r.status === "approved" && r.date <= tIso)
        .forEach(r => {
          const key = `${r.seller_id}|${r.date}`;
          if (!seen.has(key)) { seen.add(key); pastOrToday.push(r); }
        });
      setMonthAbsences(pastOrToday);
      return;
    }
    console.warn("admin_absences_by_range (month) KO -> fallback", error);
  } catch (e) {
    console.warn("admin_absences_by_range (month) threw -> fallback", e);
  }

  // 2) Fallback direct
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
  (data || []).forEach(r => {
    const key = `${r.seller_id}|${r.date}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(r); }
  });
  setMonthAbsences(uniq);
}, [monthFrom, monthTo]);


  const loadMonthUpcomingAbsences = useCallback(async () => {
  const tIso = fmtISODate(new Date());
  // 1) RPC admin
  try {
    const { data, error } = await supabase.rpc("admin_absences_by_range", { p_from: monthFrom, p_to: monthTo });
    if (!error && Array.isArray(data)) {
      const seen = new Set();
      const future = [];
      (data || [])
        .filter(r => r.status === "approved" && r.date > tIso)
        .forEach(r => {
          const key = `${r.seller_id}|${r.date}`;
          if (!seen.has(key)) { seen.add(key); future.push(r); }
        });
      setMonthUpcomingAbsences(future);
      return;
    }
    console.warn("admin_absences_by_range (upcoming) KO -> fallback", error);
  } catch (e) {
    console.warn("admin_absences_by_range (upcoming) threw -> fallback", e);
  }

  // 2) Fallback direct
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
  (data || []).forEach(r => {
    const key = `${r.seller_id}|${r.date}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(r); }
  });
  setMonthUpcomingAbsences(uniq);
}, [monthFrom, monthTo]);


  // Remplacements acceptés pour les absences du mois (passées/à venir)
  const loadMonthAcceptedRepl = useCallback(async () => {
    const ids = [
      ...(monthAbsences || []).map(a => a.id),
      ...(monthUpcomingAbsences || []).map(a => a.id),
    ];
    const uniq = Array.from(new Set(ids)).filter(Boolean);
    if (uniq.length === 0) { setMonthAcceptedRepl({}); return; }

    const { data: rows, error } = await supabase
      .from("replacement_interest")
      .select("absence_id, volunteer_id, accepted_shift_code")
      .in("absence_id", uniq)
      .eq("status", "accepted");
    if (error) console.error("month accepted repl error:", error);

    if (!rows || rows.length === 0) { setMonthAcceptedRepl({}); return; }

    const vIds = Array.from(new Set(rows.map(r => r.volunteer_id).filter(Boolean)));
    let names = {};
    if (vIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", vIds);
      (profs || []).forEach(p => { names[p.user_id] = p.full_name; });
    }

    const map = {};
    rows.forEach(r => {
      map[r.absence_id] = {
        volunteer_id: r.volunteer_id,
        volunteer_name: names[r.volunteer_id] || "-",
        shift: r.accepted_shift_code || null,
      };
    });
    setMonthAcceptedRepl(map);
  }, [monthAbsences, monthUpcomingAbsences]);

  // Déclencheurs init
  useEffect(() => { loadPendingLeaves(); loadLatestLeave(); loadApprovedLeaves(); }, [todayIso, loadPendingLeaves, loadLatestLeave, loadApprovedLeaves]);
  useEffect(() => { loadMonthAbsences(); loadMonthUpcomingAbsences(); }, [monthFrom, monthTo, loadMonthAbsences, loadMonthUpcomingAbsences]);
  useEffect(() => { loadMonthAcceptedRepl(); }, [loadMonthAcceptedRepl]);

  /* Realtime : absences + replacement + leaves */
  useEffect(() => {
    const chAbs = supabase
      .channel("absences_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "absences" }, () => {
        loadPendingAbs();
        loadAbsencesToday();
        loadMonthAbsences();
        loadMonthUpcomingAbsences();
      }).subscribe();

    const chRepl = supabase
      .channel("replacement_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "replacement_interest" }, async (payload) => {
        if (payload.eventType === "INSERT") {
          const r = payload.new;
          const { data: abs } = await supabase.from("absences").select("date, seller_id").eq("id", r.absence_id).single();
          const [vol, absName] = await Promise.all([
            supabase.from("profiles").select("full_name").eq("user_id", r.volunteer_id).single(),
            supabase.from("profiles").select("full_name").eq("user_id", abs?.seller_id).single(),
          ]);
          setLatestRepl({
            id: r.id, volunteer_id: r.volunteer_id, volunteer_name: vol.data?.full_name || "-",
            absence_id: r.absence_id, date: abs?.date, absent_id: abs?.seller_id,
            absent_name: absName.data?.full_name || "-", status: r.status,
          });
        }
        loadReplacements(); loadMonthAcceptedRepl();
      }).subscribe();

    const chLeaves = supabase
      .channel("leaves_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "leaves" }, async () => {
        await loadPendingLeaves();
        await loadApprovedLeaves();
      }).subscribe();

    // Nouveau : bannière quand une absence est supprimée par une vendeuse
    const chCancel = supabase
      .channel("absences_delete_banner")
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "absences" }, async (payload) => {
        const old = payload?.old;
        if (!old?.seller_id || !old?.date) return;
        const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", old.seller_id).single();
        setLatestCancel({ name: prof?.full_name || "-", date: old.date });
        setTimeout(() => setLatestCancel(null), 5000);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(chAbs);
      supabase.removeChannel(chRepl);
      supabase.removeChannel(chLeaves);
      supabase.removeChannel(chCancel);
    };
  }, [todayIso, loadPendingAbs, loadAbsencesToday, loadPendingLeaves, loadApprovedLeaves, loadMonthAbsences, loadMonthUpcomingAbsences, loadMonthAcceptedRepl, loadReplacements]);

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
    if (!window.confirm("Copier le planning de la semaine affichée vers la semaine prochaine ? Cela remplacera les affectations déjà présentes la semaine suivante.")) return;
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
    if (rows.length === 0) { alert("Aucune affectation à copier cette semaine."); return; }
    const { error } = await supabase.from("shifts").upsert(rows, { onConflict: "date,shift_code" }).select("date");
    if (error) { console.error(error); alert("La copie a échoué."); return; }
    setMonday(addDays(monday, 7));
    setRefreshKey((k) => k + 1);
    alert("Planning copié vers la semaine prochaine.");
  }, [days, assign, monday]);

  /* Actions absence */
  const approveAbs = useCallback(async (id) => {
    const { error } = await supabase.from("absences").update({ status: "approved" }).eq("id", id);
    if (error) { alert("Impossible d'approuver (RLS ?)"); return; }
    await loadPendingAbs(); await loadAbsencesToday(); await loadMonthAbsences(); await loadMonthUpcomingAbsences(); await loadMonthAcceptedRepl();
  }, [loadPendingAbs, loadAbsencesToday, loadMonthAbsences, loadMonthUpcomingAbsences, loadMonthAcceptedRepl]);

  const rejectAbs = useCallback(async (id) => {
    const { error } = await supabase.from("absences").update({ status: "rejected" }).eq("id", id);
    if (error) { alert("Impossible de rejeter (RLS ?)"); return; }
    await loadPendingAbs(); await loadAbsencesToday(); await loadMonthAbsences(); await loadMonthUpcomingAbsences(); await loadMonthAcceptedRepl();
  }, [loadPendingAbs, loadAbsencesToday, loadMonthAbsences, loadMonthUpcomingAbsences, loadMonthAcceptedRepl]);

  /* Attribuer / Refuser volontaire */
  const assignVolunteer = useCallback(async (repl) => {
    const shift = selectedShift[repl.id];
    if (!shift) { alert("Choisis d’abord un créneau."); return; }

    // 1) Mettre la volontaire dans le planning
    const { error: errUpsert } = await supabase
      .from("shifts")
      .upsert({ date: repl.date, shift_code: shift, seller_id: repl.volunteer_id }, { onConflict: "date,shift_code" })
      .select("date");
    if (errUpsert) { console.error(errUpsert); alert("Échec d’attribution (RLS ?)"); return; }

    // 2) Marquer cette proposition comme acceptée + stocker le créneau accepté
    await supabase.from("replacement_interest").update({ status: "accepted", accepted_shift_code: shift }).eq("id", repl.id);

    // 3) Les autres propositions deviennent 'declined'
    await supabase.from("replacement_interest").update({ status: "declined" }).eq("absence_id", repl.absence_id).neq("id", repl.id);

    // 4) IMPORTANT : si l’absence est encore 'pending', l’approuver automatiquement
    const { data: absRow } = await supabase.from("absences").select("status").eq("id", repl.absence_id).single();
    if (absRow?.status !== "approved") {
      await supabase.from("absences").update({ status: "approved" }).eq("id", repl.absence_id);
    }

    if (latestRepl && latestRepl.id === repl.id) setLatestRepl(null);

    // 5) Rafraîchir
    setRefreshKey((k) => k + 1);
    await Promise.all([loadReplacements(), loadMonthAbsences(), loadMonthUpcomingAbsences(), loadMonthAcceptedRepl()]);
    alert("Volontaire attribuée et absence approuvée.");
  }, [selectedShift, latestRepl, loadReplacements, loadMonthAbsences, loadMonthUpcomingAbsences, loadMonthAcceptedRepl]);

  const declineVolunteer = useCallback(async (replId) => {
    const { error } = await supabase.from("replacement_interest").update({ status: "declined" }).eq("id", replId);
    if (error) { console.error(error); alert("Impossible de refuser ce volontaire."); return; }
    if (latestRepl && latestRepl.id === replId) setLatestRepl(null);
    await loadReplacements(); await loadMonthAcceptedRepl();
  }, [latestRepl, loadReplacements, loadMonthAcceptedRepl]);

  /* Inline ABSENCES (admin) pour chaque jour de la semaine */
  const loadWeekAbsences = useCallback(async () => {
  const from = fmtISODate(days[0]);
  const to   = fmtISODate(days[6]);

  // 1) Essai RPC admin (bypass RLS)
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

  // 2) Fallback (si jamais)
  const { data, error } = await supabase
    .from("absences")
    .select("date, seller_id, status")
    .gte("date", from)
    .lte("date", to)
    .in("status", ["approved", "pending"]);
  if (error) { console.error("loadWeekAbsences error:", error); return; }
  const grouped = {};
  (data || []).forEach((r) => {
    if (!grouped[r.date]) grouped[r.date] = [];
    if (!grouped[r.date].includes(r.seller_id)) grouped[r.date].push(r.seller_id);
  });
  setAbsencesByDate(grouped);
}, [days]);


  // Était: upsert direct sur absences → remplace par l'RPC
const setSellerAbsent = useCallback(async (isoDate, sellerId) => {
  if (!sellerId) return;
  const { error } = await supabase.rpc("admin_upsert_absence", {
    p_date: isoDate,
    p_seller: sellerId,
    p_reason: "Absence non déclarée (admin)",
  });
  if (error) {
    console.error("admin_upsert_absence error:", error);
    alert("Impossible d'enregistrer l'absence.");
    return;
  }
  setAbsencesByDate((prev) => {
    const arr = new Set([...(prev[isoDate] || []), sellerId]);
    return { ...prev, [isoDate]: Array.from(arr) };
  });
}, []);

// Était: delete() direct → remplace par l'RPC
const removeSellerAbsent = useCallback(async (isoDate, sellerId) => {
  const { error } = await supabase.rpc("admin_delete_absence", {
    p_date: isoDate,
    p_seller: sellerId,
  });
  if (error) {
    console.error("admin_delete_absence error:", error);
    alert("Impossible de supprimer l'absence.");
    return;
  }
  setAbsencesByDate((prev) => {
    const set = new Set(prev[isoDate] || []);
    set.delete(sellerId);
    return { ...prev, [isoDate]: Array.from(set) };
  });
}, []);


  /* 🔔 BADGE + REFRESH AUTO */
  useEffect(() => {
    const count =
      (pendingAbs?.length || 0) +
      (pendingLeaves?.length || 0) +
      (replList?.length || 0);
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav) return;
    if (count > 0 && nav.setAppBadge) nav.setAppBadge(count).catch(() => {});
    else if (nav?.clearAppBadge) nav.clearAppBadge().catch(() => {});
  }, [pendingAbs?.length, pendingLeaves?.length, replList?.length]);

  const reloadAll = useCallback(async () => {
    await Promise.all([
      loadSellers(),
      loadWeekAssignments(fmtISODate(days[0]), fmtISODate(days[6])),
      loadWeekAbsences(),
      loadPendingAbs?.(),
      loadAbsencesToday?.(),
      loadReplacements?.(),
      loadPendingLeaves?.(),
      loadApprovedLeaves?.(),
      loadMonthAbsences?.(),
      loadMonthUpcomingAbsences?.(),
loadMonthAcceptedRepl?.(),
    ]);
    setRefreshKey((k) => k + 1);
    
  }, [
    days,
    loadSellers,
    loadWeekAssignments,
    loadWeekAbsences,
    loadPendingAbs,
    loadAbsencesToday,
    loadReplacements,
    loadPendingLeaves,
    loadApprovedLeaves,
    loadMonthAbsences,
    loadMonthUpcomingAbsences,
loadMonthAcceptedRepl,
  ]);

  // Initial load
  useEffect(() => { if (!loading && session) reloadAll(); }, [loading, session, reloadAll]);

  // Recharge quand l’app revient au premier plan
  useEffect(() => {
    const onWake = () => setTimeout(() => reloadAll(), 50);
    window.addEventListener('focus', onWake, { passive: true });
    document.addEventListener('visibilitychange', onWake, { passive: true });
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [reloadAll]);

  // SW push → reload
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (e) => { if (e?.data?.type === 'push') reloadAll(); };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [reloadAll]);

/* ---------- GUARDE AUTH (APRÈS TOUS LES HOOKS) ---------- */
if (loading || !session) {
  return (
    <>
      <Head><title>Connexion…</title></Head>
      <div className="p-4">Chargement…</div>
    </>
  );
}

  /* ---------- RENDER ---------- */
  return (
    <>
      <Head>
        <title>Admin - {BUILD_TAG}</title>
      </Head>
      <div style={{padding:'8px',background:'#111',color:'#fff',fontWeight:700}}>{BUILD_TAG}</div>

      <div className="p-4 max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="hdr">Compte: {profile?.full_name || "-"} <span className="sub">(admin)</span></div>
          <div className="flex items-center gap-2">
            <Link href="/admin/sellers" legacyBehavior><a className="btn">👥 Gerer les vendeuses</a></Link>
            <Link href="/push-setup" legacyBehavior><a className="btn">🔔 Activer les notifications</a></Link>
            <button type="button" className="btn" onClick={handleSignOut} disabled={signingOut}>
              {signingOut ? "Déconnexion…" : "Se déconnecter"}
            </button>
          </div>
        </div>

        {latestCancel && (
          <div className="border rounded-2xl p-3 flex items-start justify-between gap-2" style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}>
            <div className="text-sm">
              <span className="font-medium">{latestCancel.name}</span> a annulé son absence du <span className="font-medium">{latestCancel.date}</span>.
            </div>
          </div>
        )}

        {latestLeave && (
          <div className="border rounded-2xl p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2"
              style={{ backgroundColor: "#fef3c7", borderColor: "#fcd34d" }}>
            <div className="text-sm">
              <span className="font-medium">{latestLeave.seller_name}</span> demande un congé du{" "}
              <span className="font-medium">{latestLeave.start_date}</span> au <span className="font-medium">{latestLeave.end_date}</span>
              {latestLeave.reason ? <><span> - </span><span>{latestLeave.reason}</span></> : null}.
            </div>
            <div className="flex gap-2">
              <ApproveBtn onClick={() => approveLeave(latestLeave.id)} />
              <RejectBtn onClick={() => rejectLeave(latestLeave.id)} />
            </div>
          </div>
        )}

        {latestRepl && (
          <div className="border rounded-2xl p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2"
              style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}>
            <div className="text-sm">
              <span className="font-medium">{latestRepl.volunteer_name}</span> veut remplacer <Chip name={latestRepl.absent_name} /> le <span className="font-medium">{latestRepl.date}</span>.
            </div>
            <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
              <ShiftSelect dateStr={latestRepl.date} value={selectedShift[latestRepl.id] || ""} onChange={(val) => setSelectedShift(prev => ({ ...prev, [latestRepl.id]: val }))} />
              <ApproveBtn onClick={() => assignVolunteer(latestRepl)}>Approuver</ApproveBtn>
              <RejectBtn onClick={() => declineVolunteer(latestRepl.id)}>Refuser</RejectBtn>
            </div>
          </div>
        )}

        <div className="card">
          <div className="hdr mb-2">Absences aujourd’hui</div>
          {absencesToday.length === 0 ? <div className="text-sm">Aucune absence aujourd’hui</div> : (
            <ul className="list-disc pl-6 space-y-1">
              {absencesToday.map((a) => (
                <li key={a.id}>
                  <Chip name={nameFromId(a.seller_id)} /> - {a.status}
                  {a.reason ? <><span> · </span>{a.reason}</> : ""}
                  {a.replacement ? (
                    <>
                      {" · "}
                      <span>Remplacement accepté : </span>
                      <Chip name={a.replacement.volunteer_name} />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <div className="hdr mb-2">Demandes d’absence - en attente (à venir)</div>
          {pendingAbs.length === 0 ? <div className="text-sm text-gray-600">Aucune demande en attente.</div> : (
            <div className="space-y-2">
              {pendingAbs.map((a) => {
                const name = nameFromId(a.seller_id);
                return (
                  <div key={a.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                    <div><div className="font-medium">{name}</div><div className="text-sm text-gray-600">{a.date}{a.reason ? <><span> · </span>{a.reason}</> : ""}</div></div>
                    <div className="flex gap-2"><ApproveBtn onClick={() => approveAbs(a.id)} /><RejectBtn onClick={() => rejectAbs(a.id)} /></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="hdr mb-2">Demandes de congé - en attente</div>
          {pendingLeaves.length === 0 ? <div className="text-sm text-gray-600">Aucune demande de congé en attente.</div> : (
            <div className="space-y-2">
              {pendingLeaves.map((l) => {
                const name = nameFromId(l.seller_id);
                return (
                  <div key={l.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                    <div>
                      <div className="font-medium">{name}</div>
                      <div className="text-sm text-gray-600">Du {l.start_date} au {l.end_date}{l.reason ? <><span> · </span>{l.reason}</> : ""}</div>
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
                      <div className="text-sm text-gray-600">Du {l.start_date} au {l.end_date}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: tagBg }}>{tag}</span>
                      {!isOngoing && l.start_date > todayIso ? (
                        <button type="button" className="btn" onClick={() => cancelFutureLeave(l.id)}
                          style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}>
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

          <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
            {days.map((d) => {
              const iso = fmtISODate(d);
              const sunday = isSunday(d);
              const highlight = isSameISO(d, todayIso);
              const currentAbs = absencesByDate[iso] || [];
              return (
                <div
                  key={iso}
                  className="border rounded-2xl p-3 space-y-3"
                  style={highlight ? { boxShadow: "inset 0 0 0 2px rgba(37,99,235,0.5)" } : {}}
                >
                  <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                  <div className="font-semibold">{iso}</div>

                  {/* Bloc Absents (inline admin) */}
                  <div className="space-y-1">
                    <div className="text-sm font-medium">Absents</div>
                    <div className="flex flex-wrap gap-2">
                      {currentAbs.length === 0 ? <span className="text-sm text-gray-500">-</span> : null}
                      {currentAbs.map((sid) => {
                        const name = nameFromId(sid);
                        return (
                          <span key={sid} className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs" style={{ background:"#f5f5f5", border:"1px solid #e0e0e0" }}>
                            <span className="inline-block w-2 h-2 rounded-full" style={{ background: colorForName(name) }} />
                            {name}
                            <button className="ml-1 text-[11px] opacity-70 hover:opacity-100" onClick={() => removeSellerAbsent(iso, sid)} title="Supprimer">✕</button>
                          </span>
                        );
                      })}
                    </div>
                    <select
                      className="select w-full"
                      defaultValue=""
                      onChange={(e) => { const v = e.target.value; if (!v) return; setSellerAbsent(iso, v); e.target.value = ""; }}
                    >
                      <option value="" disabled>Marquer "Absent"</option>
                      {sellers.length === 0 && (
                        <option value="" disabled>(Aucune vendeuse - vérifier droits/RPC)</option>
                      )}
                      {sellers.filter((s) => !currentAbs.includes(s.user_id)).map((s) => (
                        <option key={s.user_id} value={s.user_id}>{s.full_name}</option>
                      ))}
                    </select>

                  </div>

                  <ShiftRow label="Matin (6h30-13h30)" iso={iso} code="MORNING" value={assign[`${iso}|MORNING`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|MORNING`])} />

                  {!sunday ? (
                    <ShiftRow label="Midi (7h-13h)" iso={iso} code="MIDDAY" value={assign[`${iso}|MIDDAY`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|MIDDAY`])} />
                  ) : (
                    <div className="space-y-1">
                      <div className="text-sm">Midi - deux postes</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-xs mb-1">7h-13h</div>
                          <select className="select" value={assign[`${iso}|MIDDAY`] || ""} onChange={(e) => save(iso, "MIDDAY", e.target.value || null)}>
                            <option value="">- Choisir vendeuse -</option>
                            {sellers.map((s) => (<option key={s.user_id} value={s.user_id}>{s.full_name}</option>))}
                          </select>
                          <div className="mt-1"><Chip name={nameFromId(assign[`${iso}|MIDDAY`])} /></div>
                        </div>
                        <div>
                          <div className="text-xs mb-1">9h-13h30</div>
                          <select className="select" value={assign[`${iso}|SUNDAY_EXTRA`] || ""} onChange={(e) => save(iso, "SUNDAY_EXTRA", e.target.value || null)}>
                            <option value="">- Choisir vendeuse -</option>
                            {sellers.map((s) => (<option key={s.user_id} value={s.user_id}>{s.full_name}</option>))}
                          </select>
                          <div className="mt-1"><Chip name={nameFromId(assign[`${iso}|SUNDAY_EXTRA`])} /></div>
                        </div>
                      </div>
                    </div>
                  )}

                  <ShiftRow label="Soir (13h30-20h30)" iso={iso} code="EVENING" value={assign[`${iso}|EVENING`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|EVENING`])} />
                </div>
              );
            })}
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
                                  <Chip name={repl.volunteer_name} /> remplace <Chip name={name} />
                                  {repl.shift ? <> (<span>{shiftHumanLabel(repl.shift)}</span>)</> : null}
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
                                  <Chip name={repl.volunteer_name} /> remplace <Chip name={name} />
                                  {repl.shift ? <> (<span>{shiftHumanLabel(repl.shift)}</span>)</> : null}
                                </>
                              ) : (
                                <> - <span className="text-gray-500">pas de volontaire accepté</span></>
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

/* ---------- SOUS-COMPOSANTS (SANS HOOKS OU HOOKS INTERNES) ---------- */

function ShiftSelect({ dateStr, value, onChange }) {
  const sunday = isSunday(new Date(dateStr));
  const options = [
    { code: "MORNING", label: "Matin (6h30-13h30)" },
    { code: "MIDDAY", label: "Midi (7h-13h)" },
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
        {sellers.length === 0 && (
          <option value="" disabled>(Aucune vendeuse - vérifier droits/RPC)</option>
        )}
        {sellers.map((s) => (
          <option key={s.user_id} value={s.user_id}>{s.full_name}</option>
        ))}
      </select>

      <div>
        <Chip name={chipName} />
      </div>
    </div>
  );
}

function TotalsGrid({
  sellers,
  monthFrom, monthTo, monthLabel, refreshKey,
  monthAbsences = [],
  monthUpcomingAbsences = [],
}) {
  const [weekTotals, setWeekTotals] = useState({});
  const [monthTotals, setMonthTotals] = useState({});
  const [annualLeaveDays, setAnnualLeaveDays] = useState({});
  const [loading, setLoading] = useState(false);

  // agrégateur simple côté client (fallback si RPC KO)
  function aggregateFromRows(rows, sellersList) {
    const dict = Object.fromEntries((sellersList || []).map(s => [s.user_id, 0]));
    (rows || []).forEach(r => {
      const h = SHIFT_HOURS[r.shift_code] ?? 0;
      if (r.seller_id) dict[r.seller_id] = (dict[r.seller_id] || 0) + h;
    });
    return dict;
    }

  // tente l'RPC ; sinon fallback en lisant shifts
  async function fetchHoursRange(fromIso, toIso, sellersList) {
    // 1) Essai RPC
    try {
      const { data, error } = await supabase.rpc("admin_hours_by_range", { p_from: fromIso, p_to: toIso });
      if (!error && Array.isArray(data)) {
        const dict = Object.fromEntries((sellersList || []).map(s => [s.user_id, 0]));
        data.forEach(r => { dict[r.seller_id] = Number(r.hours) || 0; });
        return dict;
      }
      console.warn("RPC admin_hours_by_range KO -> fallback", error);
    } catch (e) {
      console.warn("RPC admin_hours_by_range threw -> fallback", e);
    }

    // 2) Fallback direct
    try {
      const { data: rows, error: e2 } = await supabase
        .from("shifts")
        .select("seller_id, date, shift_code")
        .gte("date", fromIso)
        .lte("date", toIso);
      if (e2) { console.error("fallback shifts error:", e2); return Object.fromEntries((sellersList || []).map(s => [s.user_id, 0])); }
      return aggregateFromRows(rows, sellersList);
    } catch (e) {
      console.error("fallback shifts threw:", e);
      return Object.fromEntries((sellersList || []).map(s => [s.user_id, 0]));
    }
  }

  // Heures semaine — jusqu’à HIER (exclut aujourd’hui)
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!sellers || sellers.length === 0) { setWeekTotals({}); return; }
      const weekStartIso = fmtISODate(startOfWeek(new Date()));
      const yesterdayIso = fmtISODate(addDays(new Date(), -1)); // hier
      if (yesterdayIso < weekStartIso) { setWeekTotals({}); return; } // lundi -> rien à compter
      const dict = await fetchHoursRange(weekStartIso, yesterdayIso, sellers);
      if (!cancelled) setWeekTotals(dict);
    };
    run();
    return () => { cancelled = true; };
  }, [sellers, refreshKey]);

  // Heures mois — jusqu’à HIER si mois courant, sinon jusqu’à fin du mois sélectionné
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!sellers || sellers.length === 0) { setMonthTotals({}); return; }
      setLoading(true);
      try {
        const yesterdayIso = fmtISODate(addDays(new Date(), -1));
        const upper = (yesterdayIso < monthTo) ? yesterdayIso : monthTo;
        if (upper < monthFrom) { setMonthTotals({}); return; }
        const dict = await fetchHoursRange(monthFrom, upper, sellers);
        if (!cancelled) setMonthTotals(dict);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [sellers, monthFrom, monthTo, refreshKey]);

  // Jours de congé pris sur l'année en cours (approved, jusqu’à aujourd’hui inclus)
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!sellers || sellers.length === 0) { setAnnualLeaveDays({}); return; }
      const now = new Date();
      const yearStart = `${now.getFullYear()}-01-01`;
      const yearEnd   = `${now.getFullYear()}-12-31`;
      const todayIso  = fmtISODate(now);

      const { data } = await supabase
        .from("leaves")
        .select("seller_id, start_date, end_date, status")
        .eq("status", "approved")
        .lte("start_date", yearEnd)
        .gte("end_date", yearStart);

      const dict = Object.fromEntries(sellers.map((s) => [s.user_id, 0]));
      (data || []).forEach(l => {
        const start = l.start_date > yearStart ? l.start_date : yearStart;
        const endLimit = todayIso < yearEnd ? todayIso : yearEnd;
        const end = l.end_date < endLimit ? l.end_date : endLimit;
        if (start <= end) {
          const days = (new Date(end + "T00:00:00") - new Date(start + "T00:00:00")) / (1000*60*60*24) + 1;
          dict[l.seller_id] = (dict[l.seller_id] || 0) + Math.max(0, Math.floor(days));
        }
      });
      if (!cancelled) setAnnualLeaveDays(dict);
    };
    run();
    return () => { cancelled = true; };
  }, [sellers, refreshKey]);

  // Compteur d'absences du mois (approved, passées + à venir)
  const absencesCount = useMemo(() => {
    const all = [...(monthAbsences || []), ...(monthUpcomingAbsences || [])];
    const dict = Object.fromEntries(sellers.map((s) => [s.user_id, 0]));
    all.forEach(a => {
      if (a?.seller_id) dict[a.seller_id] = (dict[a.seller_id] || 0) + 1;
    });
    return dict;
  }, [sellers, monthAbsences, monthUpcomingAbsences]);

  if (!sellers || sellers.length === 0)
    return (
      <div className="card">
        <div className="hdr mb-2">Total heures vendeuses</div>
        <div className="text-sm text-gray-600">Aucune vendeuse enregistrée.</div>
      </div>
    );

  return (
    <div className="card">
      <div className="hdr mb-1">Total heures - semaine en cours (jusqu’à hier) & mois : {monthLabel}</div>
      {loading && <div className="text-sm text-gray-500 mb-3">Calcul en cours…</div>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {sellers.map((s) => {
          const week = weekTotals[s.user_id] ?? 0;
          const month = monthTotals[s.user_id] ?? 0;
          const absCount = absencesCount[s.user_id] ?? 0;
          const leaveDays = annualLeaveDays[s.user_id] ?? 0;
          return (
            <div key={s.user_id} className="border rounded-2xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Chip name={s.full_name} />
              </div>
              <div className="text-sm text-gray-600">Semaine (jusqu’à hier)</div>
              <div className="text-2xl font-semibold">{Number(week).toFixed(1)} h</div>
              <div className="text-sm text-gray-600 mt-2">Mois ({monthLabel})</div>
              <div className="text-2xl font-semibold">{Number(month).toFixed(1)} h</div>
              <div className="text-sm text-gray-600 mt-2">Absences (mois)</div>
              <div className="text-2xl font-semibold">{absCount}</div>
              <div className="text-sm text-gray-600 mt-2">Congés pris (année)</div>
              <div className="text-2xl font-semibold">{leaveDays}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
