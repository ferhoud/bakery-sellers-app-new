// touch: 2025-10-09 v-admin-weekly-pastdays-db + cancel-future-leave + annual-leave-days

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/useAuth";
import WeekNav from "../components/WeekNav";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "../lib/date";

/* Heures par crÃ©neau (inclut le dimanche spÃ©cial) */
const SHIFT_HOURS = { MORNING: 7, MIDDAY: 6, EVENING: 7, SUNDAY_EXTRA: 4.5 };
const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9hâ€“13h30" };

/* Couleurs fixes par vendeuse */
const SELLER_COLORS = {
  Antonia: "#e57373",
  Olivia: "#64b5f6",
  Colleen: "#81c784",
  Ibtissam: "#ba68c8",
};
const colorForName = (name) => SELLER_COLORS[name] || "#9e9e9e";

/* Utils date / libellÃ©s */
function firstDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function lastDayOfMonth(d)  { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function monthInputValue(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function labelMonthFR(d)    { return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }); }
const isSunday   = (d) => d.getDay() === 0;
const weekdayFR  = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });
const capFirst   = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const betweenIso = (iso, start, end) => iso >= start && iso <= end;
const frDate = (iso) => { try { return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR"); } catch { return iso; } };
const isSameISO = (d, iso) => fmtISODate(d) === iso;

function Chip({ name }) {
  if (!name || name === "â€”") return <span className="text-sm text-gray-500">â€”</span>;
  const bg = colorForName(name);
  return <span style={{ backgroundColor: bg, color: "#fff", borderRadius: 9999, padding: "2px 10px", fontSize: "0.8rem" }}>{name}</span>;
}

export default function Admin() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  // Semaine affichÃ©e
  const [monday, setMonday] = useState(startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(monday, i)), [monday]);

  // Mois pour les totaux (sÃ©lecteur en bas)
  const [selectedMonth, setSelectedMonth] = useState(firstDayOfMonth(new Date()));
  const monthFrom = fmtISODate(firstDayOfMonth(selectedMonth));
  const monthTo   = fmtISODate(lastDayOfMonth(selectedMonth));

  // DonnÃ©es UI
  const [sellers, setSellers] = useState([]);               // [{user_id, full_name}]
  const [assign, setAssign] = useState({});                 // "YYYY-MM-DD|SHIFT" -> seller_id
  const [absencesToday, setAbsencesToday] = useState([]);   // dâ€™aujourdâ€™hui (pending/approved)
  const [pendingAbs, setPendingAbs] = useState([]);         // absences Ã  venir (pending)
  const [replList, setReplList] = useState([]);             // volontaires (pending) sur absences approuvÃ©es
  const [selectedShift, setSelectedShift] = useState({});   // {replacement_interest_id: "MIDDAY"}
  const [latestRepl, setLatestRepl] = useState(null);       // banniÃ¨re: dernier volontariat reÃ§u

  // CongÃ©s
  const [pendingLeaves, setPendingLeaves] = useState([]);   // congÃ©s en attente (Ã  venir ou en cours)
  const [latestLeave, setLatestLeave] = useState(null);     // banniÃ¨re congÃ© la plus rÃ©cente (pending)
  const [approvedLeaves, setApprovedLeaves] = useState([]); // congÃ©s approuvÃ©s (end_date >= today)

  // Absences approuvÃ©es du mois sÃ©lectionnÃ©
  const [monthAbsences, setMonthAbsences] = useState([]);           // passÃ©es/aujourdâ€™hui (items avec id)
  const [monthUpcomingAbsences, setMonthUpcomingAbsences] = useState([]); // Ã  venir (items avec id)

  // Remplacements acceptÃ©s du mois (absence_id -> { volunteer_id, volunteer_name, shift })
  const [monthAcceptedRepl, setMonthAcceptedRepl] = useState({});

  // BanniÃ¨re Ã©phÃ©mÃ¨re quand une vendeuse annule son absence (DELETE)
  const [latestCancel, setLatestCancel] = useState(null);   // { name, date }

  const [refreshKey, setRefreshKey] = useState(0);          // recalcul totaux mois
  const today = new Date();
  const todayIso = fmtISODate(today);

  /* SÃ©curitÃ© */
  useEffect(() => {
    if (loading) return;
    if (!session) r.replace("/login");
    if (profile && profile.role !== "admin") r.replace("/app");
  }, [session, profile, loading, r]);

  /* Vendeuses */
  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("list_sellers");
      setSellers(data || []);
    })();
  }, []);
  const nameFromId = (id) => sellers.find((s) => s.user_id === id)?.full_name || "â€”";

  /* Planning semaine */
  useEffect(() => {
    (async () => {
      const from = fmtISODate(days[0]);
      const to = fmtISODate(days[6]);
      const { data } = await supabase
        .from("view_week_assignments")
        .select("*")
        .gte("date", from)
        .lte("date", to);
      const next = {};
      (data || []).forEach((row) => { next[`${row.date}|${row.shift_code}`] = row.seller_id; });
      setAssign(next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monday]);

  /* Absences d'aujourd'hui (avec remplacement acceptÃ© si existe) */
  const loadAbsencesToday = async () => {
    const { data: abs } = await supabase
      .from("absences")
      .select("id, seller_id, status, reason, date")
      .eq("date", todayIso)
      .in("status", ["pending", "approved"]);

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
          volunteer_name: names[r.volunteer_id] || "â€”",
        };
      });
    }

    const rows = (abs || []).map(a => ({ ...a, replacement: mapRepl[a.id] || null }));
    setAbsencesToday(rows);
  };
  useEffect(() => { loadAbsencesToday(); }, [todayIso]);

  /* Absences en attente (toutes Ã  venir) */
  const loadPendingAbs = async () => {
    const { data } = await supabase
      .from("absences")
      .select("id, seller_id, date, reason, status")
      .gte("date", todayIso)
      .eq("status", "pending")
      .order("date", { ascending: true });
    setPendingAbs(data || []);
  };
  useEffect(() => { loadPendingAbs(); }, [todayIso]);

  /* Volontaires (absences approuvÃ©es) */
  const loadReplacements = async () => {
    const { data: rows } = await supabase
      .from("replacement_interest")
      .select("id, status, volunteer_id, absence_id, absences(id, date, seller_id, status)")
      .eq("status", "pending")
      .eq("absences.status", "approved")
      .gte("absences.date", todayIso)
      .order("absences.date", { ascending: true });

    const ids = new Set();
    (rows || []).forEach((r) => { if (r.volunteer_id) ids.add(r.volunteer_id); if (r.absences?.seller_id) ids.add(r.absences.seller_id); });
    let names = {};
    if (ids.size > 0) {
      const { data: profs } = await supabase.from("profiles").select("user_id, full_name").in("user_id", Array.from(ids));
      (profs || []).forEach((p) => (names[p.user_id] = p.full_name));
    }
    const list = (rows || []).map((r) => ({
      id: r.id, volunteer_id: r.volunteer_id, volunteer_name: names[r.volunteer_id] || "â€”",
      absence_id: r.absence_id, date: r.absences?.date, absent_id: r.absences?.seller_id,
      absent_name: names[r.absences?.seller_id] || "â€”", status: r.status,
    }));
    setReplList(list);
  };
  useEffect(() => { loadReplacements(); }, [todayIso]);

  /* ======= CONGÃ‰S ======= */
  const loadPendingLeaves = async () => {
    const { data } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, reason, status, created_at")
      .eq("status", "pending")
      .gte("end_date", todayIso)      // uniquement non passÃ©s
      .order("created_at", { ascending: false });
    setPendingLeaves(data || []);
  };
  const loadLatestLeave = async () => {
    const { data } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, reason, status, created_at")
      .eq("status", "pending")
      .gte("end_date", todayIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!data || data.length === 0) { setLatestLeave(null); return; }
    const leave = data[0];
    const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", leave.seller_id).single();
    setLatestLeave({ ...leave, seller_name: prof?.full_name || "â€”" });
  };
  const loadApprovedLeaves = async () => {
    const { data } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, reason, status")
      .eq("status", "approved")
      .gte("end_date", todayIso)      // tant que pas fini
      .order("start_date", { ascending: true });
    setApprovedLeaves(data || []);
  };

  // Actions congÃ©s
  const approveLeave = async (id) => {
    const { error } = await supabase.from("leaves").update({ status: "approved" }).eq("id", id);
    if (error) { alert("Impossible d'approuver (RLS ?)"); return; }
    await loadPendingLeaves(); await loadApprovedLeaves(); await loadLatestLeave();
  };
  const rejectLeave = async (id) => {
    const { error } = await supabase.from("leaves").update({ status: "rejected" }).eq("id", id);
    if (error) { alert("Impossible de rejeter (RLS ?)"); return; }
    await loadPendingLeaves(); await loadApprovedLeaves(); await loadLatestLeave();
  };
  const cancelFutureLeave = async (id) => {
    // admin-only action (on est dÃ©jÃ  sur /admin avec role admin)
    // VÃ©rifie que le congÃ© est Ã  venir, puis supprime l'entrÃ©e
    const { data: leave } = await supabase.from("leaves").select("start_date,status").eq("id", id).single();
    if (!leave) { alert("CongÃ© introuvable."); return; }
    if (!(leave.status === "approved" || leave.status === "pending")) { alert("Seuls les congÃ©s approuvÃ©s/en attente peuvent Ãªtre annulÃ©s."); return; }
    const tIso = fmtISODate(new Date());
    if (!(leave.start_date > tIso)) { alert("On ne peut annuler que les congÃ©s Ã  venir."); return; }

    const { error } = await supabase.from("leaves").delete().eq("id", id);
    if (error) { console.error(error); alert("Ã‰chec de lâ€™annulation du congÃ©."); return; }

    await loadPendingLeaves(); await loadApprovedLeaves(); await loadLatestLeave();
    alert("CongÃ© Ã  venir annulÃ©. La vendeuse peut refaire une demande.");
  };

  /* ======= ABSENCES DU MOIS (APPROUVÃ‰ES) ======= */
  const loadMonthAbsences = async () => {
    const tIso = fmtISODate(new Date());
    const { data } = await supabase
      .from("absences")
      .select("id, seller_id, date, status")
      .eq("status", "approved")
      .gte("date", monthFrom)
      .lte("date", monthTo)
      .lte("date", tIso); // passÃ©es/aujourdâ€™hui

    const seen = new Set();
    const uniq = [];
    (data || []).forEach(r => {
      const key = `${r.seller_id}|${r.date}`;
      if (!seen.has(key)) { seen.add(key); uniq.push(r); }
    });
    setMonthAbsences(uniq);
  };

  const loadMonthUpcomingAbsences = async () => {
    const tIso = fmtISODate(new Date());
    const { data } = await supabase
      .from("absences")
      .select("id, seller_id, date, status")
      .eq("status", "approved")
      .gte("date", monthFrom)
      .lte("date", monthTo)
      .gt("date", tIso); // futures

    const seen = new Set();
    const uniq = [];
    (data || []).forEach(r => {
      const key = `${r.seller_id}|${r.date}`;
      if (!seen.has(key)) { seen.add(key); uniq.push(r); }
    });
    setMonthUpcomingAbsences(uniq);
  };

  // Remplacements acceptÃ©s pour les absences du mois (passÃ©es/Ã  venir)
  const loadMonthAcceptedRepl = async () => {
    const ids = [
      ...(monthAbsences || []).map(a => a.id),
      ...(monthUpcomingAbsences || []).map(a => a.id),
    ];
    const uniq = Array.from(new Set(ids)).filter(Boolean);
    if (uniq.length === 0) { setMonthAcceptedRepl({}); return; }

    const { data: rows } = await supabase
      .from("replacement_interest")
      .select("absence_id, volunteer_id, accepted_shift_code")
      .in("absence_id", uniq)
      .eq("status", "accepted");

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
        volunteer_name: names[r.volunteer_id] || "â€”",
        shift: r.accepted_shift_code || null,
      };
    });
    setMonthAcceptedRepl(map);
  };

  useEffect(() => { loadPendingLeaves(); loadLatestLeave(); loadApprovedLeaves(); }, [todayIso]);
  useEffect(() => { loadMonthAbsences(); loadMonthUpcomingAbsences(); }, [monthFrom, monthTo, refreshKey]);
  useEffect(() => { loadMonthAcceptedRepl(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [monthAbsences, monthUpcomingAbsences]);

  /* Realtime : absences + replacement + leaves */
  useEffect(() => {
    const chAbs = supabase
      .channel("absences_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "absences" }, () => {
        loadPendingAbs();
        loadAbsencesToday();
        loadReplacements();
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
            id: r.id, volunteer_id: r.volunteer_id, volunteer_name: vol.data?.full_name || "â€”",
            absence_id: r.absence_id, date: abs?.date, absent_id: abs?.seller_id,
            absent_name: absName.data?.full_name || "â€”", status: r.status,
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

    // Nouveau : banniÃ¨re quand une absence est supprimÃ©e par une vendeuse
    const chCancel = supabase
      .channel("absences_delete_banner")
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "absences" },
        async (payload) => {
          const old = payload?.old;
          if (!old?.seller_id || !old?.date) return;
          const { data: prof } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("user_id", old.seller_id)
            .single();
          setLatestCancel({ name: prof?.full_name || "â€”", date: old.date });
          setTimeout(() => setLatestCancel(null), 5000);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chAbs);
      supabase.removeChannel(chRepl);
      supabase.removeChannel(chLeaves);
      supabase.removeChannel(chCancel);
    };
  }, [todayIso]);

  /* Sauvegarde d'une affectation */
  const save = async (iso, code, seller_id) => {
    const key = `${iso}|${code}`;
    setAssign((prev) => ({ ...prev, [key]: seller_id || null }));
    const { error } = await supabase
      .from("shifts")
      .upsert({ date: iso, shift_code: code, seller_id: seller_id || null }, { onConflict: "date,shift_code" })
      .select("date");
    if (error) { console.error("UPSERT shifts error:", error); alert("Ã‰chec de sauvegarde du planning (RLS ?)"); return; }
    setRefreshKey((k) => k + 1);
  };

  /* Copier la semaine -> semaine suivante */
  const copyWeekToNext = async () => {
    if (!window.confirm("Copier le planning de la semaine affichÃ©e vers la semaine prochaine ? Cela remplacera les affectations dÃ©jÃ  prÃ©sentes la semaine suivante.")) return;
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
    if (rows.length === 0) { alert("Aucune affectation Ã  copier cette semaine."); return; }
    const { error } = await supabase.from("shifts").upsert(rows, { onConflict: "date,shift_code" }).select("date");
    if (error) { console.error(error); alert("La copie a Ã©chouÃ©."); return; }
    setMonday(addDays(monday, 7));
    setRefreshKey((k) => k + 1);
    alert("Planning copiÃ© vers la semaine prochaine.");
  };

  /* Actions absence */
  const approveAbs = async (id) => {
    const { error } = await supabase.from("absences").update({ status: "approved" }).eq("id", id);
    if (error) { alert("Impossible d'approuver (RLS ?)"); return; }
    await loadPendingAbs(); await loadAbsencesToday(); await loadMonthAbsences(); await loadMonthUpcomingAbsences(); await loadMonthAcceptedRepl();
  };
  const rejectAbs = async (id) => {
    const { error } = await supabase.from("absences").update({ status: "rejected" }).eq("id", id);
    if (error) { alert("Impossible de rejeter (RLS ?)"); return; }
    await loadPendingAbs(); await loadAbsencesToday(); await loadMonthAbsences(); await loadMonthUpcomingAbsences(); await loadMonthAcceptedRepl();
  };

  /* Attribuer / Refuser volontaire */
  const assignVolunteer = async (repl) => {
    const shift = selectedShift[repl.id];
    if (!shift) { alert("Choisis dâ€™abord un crÃ©neau."); return; }

    // 1) Mettre la volontaire dans le planning
    const { error: errUpsert } = await supabase
      .from("shifts")
      .upsert({ date: repl.date, shift_code: shift, seller_id: repl.volunteer_id }, { onConflict: "date,shift_code" })
      .select("date");
    if (errUpsert) { console.error(errUpsert); alert("Ã‰chec dâ€™attribution (RLS ?)"); return; }

    // 2) Marquer cette proposition comme acceptÃ©e + stocker le crÃ©neau acceptÃ©
    await supabase
      .from("replacement_interest")
      .update({ status: "accepted", accepted_shift_code: shift })
      .eq("id", repl.id);

    // 3) Les autres propositions deviennent 'declined'
    await supabase
      .from("replacement_interest")
      .update({ status: "declined" })
      .eq("absence_id", repl.absence_id)
      .neq("id", repl.id);

    // 4) IMPORTANT : si lâ€™absence est encore 'pending', lâ€™approuver automatiquement
    const { data: absRow } = await supabase
      .from("absences")
      .select("status")
      .eq("id", repl.absence_id)
      .single();
    if (absRow?.status !== "approved") {
      await supabase.from("absences").update({ status: "approved" }).eq("id", repl.absence_id);
    }

    if (latestRepl && latestRepl.id === repl.id) setLatestRepl(null);

    // 5) RafraÃ®chir tous les blocs
    setRefreshKey((k) => k + 1);
    await Promise.all([loadReplacements(), loadMonthAbsences(), loadMonthUpcomingAbsences(), loadMonthAcceptedRepl()]);
    alert("Volontaire attribuÃ©e et absence approuvÃ©e.");
  };

  const declineVolunteer = async (replId) => {
    const { error } = await supabase.from("replacement_interest").update({ status: "declined" }).eq("id", replId);
    if (error) { console.error(error); alert("Impossible de refuser ce volontaire."); return; }
    if (latestRepl && latestRepl.id === replId) setLatestRepl(null);
    await loadReplacements(); await loadMonthAcceptedRepl();
  };

  /* ---------- ðŸ”” BADGE + REFRESH AUTO ---------- */

  // Pastille selon Ã©lÃ©ments en attente (plus de demandes dâ€™annulation ici)
  useEffect(() => {
    const count =
      (pendingAbs?.length || 0) +
      (pendingLeaves?.length || 0) +
      (replList?.length || 0);

    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav) return;

    if (count > 0 && nav.setAppBadge) {
      nav.setAppBadge(count).catch(() => {});
    } else if (nav?.clearAppBadge) {
      nav.clearAppBadge().catch(() => {});
    }
  }, [pendingAbs?.length, pendingLeaves?.length, replList?.length]);

  // Regroupe les rechargements + efface la pastille Ã  lâ€™ouverture
  const reloadAll = useCallback(async () => {
    await Promise.all([
      loadPendingAbs?.(),
      loadAbsencesToday?.(),
      loadReplacements?.(),
      loadPendingLeaves?.(),
      loadApprovedLeaves?.(),
      loadMonthAbsences?.(),
      loadMonthUpcomingAbsences?.(),
    ]);
    setRefreshKey((k) => k + 1);

    if (typeof navigator !== 'undefined' && navigator.clearAppBadge) {
      try { await navigator.clearAppBadge(); } catch {}
    }
  }, [
    loadPendingAbs,
    loadAbsencesToday,
    loadReplacements,
    loadPendingLeaves,
    loadApprovedLeaves,
    loadMonthAbsences,
    loadMonthUpcomingAbsences,
  ]);

  // Recharge quand lâ€™app revient au premier plan
  useEffect(() => {
    const onWake = () => reloadAll();
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [reloadAll]);

  // Ã‰coute les messages du Service Worker (reÃ§u Ã  chaque push) â†’ recharge
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (e) => {
      if (e?.data?.type === 'push') reloadAll();
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [reloadAll]);

  /* ----------------- UI ----------------- */
  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Compte: {profile?.full_name || "â€”"} <span className="sub">(admin)</span></div>
        <div className="flex items-center gap-2">
          <Link href="/admin/sellers" legacyBehavior><a className="btn">ðŸ‘¥ Gerer les vendeuses</a></Link>
          <Link href="/push-setup" legacyBehavior><a className="btn">ðŸ”” Activer les notifications</a></Link>
          <button type="button" className="btn" onClick={() => supabase.auth.signOut()}>Se dÃ©connecter</button>
        </div>
      </div>

      {/* BANNIÃˆRE : Annulation effectuÃ©e par une vendeuse (DELETE) */}
      {latestCancel && (
        <div className="border rounded-2xl p-3 flex items-start justify-between gap-2" style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}>
          <div className="text-sm">
            <span className="font-medium">{latestCancel.name}</span> a annulÃ© son absence du <span className="font-medium">{latestCancel.date}</span>.
          </div>
        </div>
      )}

      {/* BANNIÃˆRE : Demande de congÃ© (la plus rÃ©cente) */}
      {latestLeave && (
        <div className="border rounded-2xl p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2"
             style={{ backgroundColor: "#fef3c7", borderColor: "#fcd34d" }}>
          <div className="text-sm">
            <span className="font-medium">{latestLeave.seller_name}</span> demande un congÃ© du{" "}
            <span className="font-medium">{latestLeave.start_date}</span> au <span className="font-medium">{latestLeave.end_date}</span>
            {latestLeave.reason ? <> â€” <span>{latestLeave.reason}</span></> : null}.
          </div>
          <div className="flex gap-2">
            <ApproveBtn onClick={() => approveLeave(latestLeave.id)} />
            <RejectBtn onClick={() => rejectLeave(latestLeave.id)} />
          </div>
        </div>
      )}

      {/* BANNIÃˆRE : Volontariat de remplacement */}
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

      {/* Absences aujourdâ€™hui â€” disparaÃ®t aprÃ¨s le jour J */}
      <div className="card">
        <div className="hdr mb-2">Absences aujourdâ€™hui</div>
        {absencesToday.length === 0 ? <div className="text-sm">Aucune absence aujourdâ€™hui</div> : (
          <ul className="list-disc pl-6 space-y-1">
            {absencesToday.map((a) => (
              <li key={a.id}>
                <Chip name={nameFromId(a.seller_id)} /> â€” {a.status}
                {a.reason ? ` Â· ${a.reason}` : ""}
                {a.replacement ? (
                  <>
                    {" Â· "}
                    <span>Remplacement acceptÃ© : </span>
                    <Chip name={a.replacement.volunteer_name} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Demandes dâ€™absence â€” en attente */}
      <div className="card">
        <div className="hdr mb-2">Demandes dâ€™absence â€” en attente (Ã  venir)</div>
        {pendingAbs.length === 0 ? <div className="text-sm text-gray-600">Aucune demande en attente.</div> : (
          <div className="space-y-2">
            {pendingAbs.map((a) => {
              const name = nameFromId(a.seller_id);
              return (
                <div key={a.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                  <div><div className="font-medium">{name}</div><div className="text-sm text-gray-600">{a.date} {a.reason ? `Â· ${a.reason}` : ""}</div></div>
                  <div className="flex gap-2"><ApproveBtn onClick={() => approveAbs(a.id)} /><RejectBtn onClick={() => rejectAbs(a.id)} /></div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Demandes de congÃ© â€” en attente */}
      <div className="card">
        <div className="hdr mb-2">Demandes de congÃ© â€” en attente</div>
        {pendingLeaves.length === 0 ? <div className="text-sm text-gray-600">Aucune demande de congÃ© en attente.</div> : (
          <div className="space-y-2">
            {pendingLeaves.map((l) => {
              const name = nameFromId(l.seller_id);
              return (
                <div key={l.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                  <div>
                    <div className="font-medium">{name}</div>
                    <div className="text-sm text-gray-600">Du {l.start_date} au {l.end_date}{l.reason ? ` Â· ${l.reason}` : ""}</div>
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

      {/* CongÃ©s approuvÃ©s â€” en cours ou Ã  venir */}
      <div className="card">
        <div className="hdr mb-2">CongÃ©s approuvÃ©s â€” en cours ou Ã  venir</div>
        {approvedLeaves.length === 0 ? (
          <div className="text-sm text-gray-600">Aucun congÃ© approuvÃ© Ã  venir.</div>
        ) : (
          <div className="space-y-2">
            {approvedLeaves.map((l) => {
              const name = nameFromId(l.seller_id);
              const isOngoing = betweenIso(todayIso, l.start_date, l.end_date);
              const tag = isOngoing ? "En cours" : "Ã€ venir";
              const tagBg = isOngoing ? "#16a34a" : "#2563eb";
              return (
                <div key={l.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                  <div>
                    <div className="font-medium">{name}</div>
                    <div className="text-sm text-gray-600">Du {l.start_date} au {l.end_date}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: tagBg }}>{tag}</span>
                    {/* Bouton admin pour ANNULER un congÃ© Ã  venir */}
                    {!isOngoing && l.start_date > todayIso ? (
                      <button type="button" className="btn" onClick={() => cancelFutureLeave(l.id)}
                        style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}>
                        Annuler le congÃ©
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Planning du jour */}
      <TodayColorBlocks today={today} todayIso={todayIso} assign={assign} nameFromId={nameFromId} />

      {/* Planning de la semaine (Ã©dition) */}
      <div className="card">
        <div className="hdr mb-4">Planning de la semaine</div>

        {/* Nav + bouton copier */}
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-3">
          <WeekNav
            monday={monday}
            onPrev={() => setMonday(addDays(monday, -7))}
            onToday={() => setMonday(startOfWeek(new Date()))}
            onNext={() => setMonday(addDays(monday, 7))}
          />
          <button type="button" className="btn" onClick={copyWeekToNext}>Copier la semaine â†’ la suivante</button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          {days.map((d) => {
            const iso = fmtISODate(d);
            const sunday = isSunday(d);
            const highlight = isSameISO(d, todayIso);
            return (
              <div
                key={iso}
                className="border rounded-2xl p-3 space-y-3"
                style={highlight ? { boxShadow: "inset 0 0 0 2px rgba(37,99,235,0.5)" } : {}}
              >
                <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                <div className="font-semibold">{iso}</div>

                <ShiftRow label="Matin (6h30â€“13h30)" iso={iso} code="MORNING" value={assign[`${iso}|MORNING`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|MORNING`])} />

                {!sunday ? (
                  <ShiftRow label="Midi (7hâ€“13h)" iso={iso} code="MIDDAY" value={assign[`${iso}|MIDDAY`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|MIDDAY`])} />
                ) : (
                  <div className="space-y-1">
                    <div className="text-sm">Midi â€” deux postes</div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-xs mb-1">7hâ€“13h</div>
                        <select className="select" value={assign[`${iso}|MIDDAY`] || ""} onChange={(e) => save(iso, "MIDDAY", e.target.value || null)}>
                          <option value="">â€” Choisir vendeuse â€”</option>
                          {sellers.map((s) => (<option key={s.user_id} value={s.user_id}>{s.full_name}</option>))}
                        </select>
                        <div className="mt-1"><Chip name={nameFromId(assign[`${iso}|MIDDAY`])} /></div>
                      </div>
                      <div>
                        <div className="text-xs mb-1">9hâ€“13h30</div>
                        <select className="select" value={assign[`${iso}|SUNDAY_EXTRA`] || ""} onChange={(e) => save(iso, "SUNDAY_EXTRA", e.target.value || null)}>
                          <option value="">â€” Choisir vendeuse â€”</option>
                          {sellers.map((s) => (<option key={s.user_id} value={s.user_id}>{s.full_name}</option>))}
                        </select>
                        <div className="mt-1"><Chip name={nameFromId(assign[`${iso}|SUNDAY_EXTRA`])} /></div>
                      </div>
                    </div>
                  </div>
                )}

                <ShiftRow label="Soir (13h30â€“20h30)" iso={iso} code="EVENING" value={assign[`${iso}|EVENING`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|EVENING`])} />
              </div>
            );
          })}
        </div>
      </div>

      {/* SÃ©lecteur de MOIS */}
      <div className="card">
        <div className="hdr mb-2">Choisir le mois pour â€œTotal heures (mois)â€</div>
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
            Mois sÃ©lectionnÃ© : <span className="font-medium">{labelMonthFR(selectedMonth)}</span>
          </div>
        </div>
      </div>

      {/* Totaux */}
      <TotalsGrid
        sellers={sellers}
        monthFrom={monthFrom}
        monthTo={monthTo}
        monthLabel={labelMonthFR(selectedMonth)}
        refreshKey={refreshKey}
        monthAbsences={monthAbsences}
        monthUpcomingAbsences={monthUpcomingAbsences}
      />

      {/* Absences approuvÃ©es â€” MOIS (passÃ©es / aujourdâ€™hui) */}
      <div className="card">
        <div className="hdr mb-2">Absences approuvÃ©es â€” mois : {labelMonthFR(selectedMonth)}</div>
        {(() => {
          if (!monthAbsences || monthAbsences.length === 0) {
            return <div className="text-sm text-gray-600">Aucune absence (passÃ©e/aujourdâ€™hui) sur ce mois.</div>;
          }
          // Grouper par vendeuse
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
                              <> â€” <Chip name={repl.volunteer_name} /> remplace <Chip name={name} />{repl.shift ? <> (<span>{shiftHumanLabel(repl.shift)}</span>)</> : null}</>
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

      {/* Absences approuvÃ©es Ã  venir â€” MOIS (dates futures) */}
      <div className="card">
        <div className="hdr mb-2">Absences approuvÃ©es Ã  venir â€” mois : {labelMonthFR(selectedMonth)}</div>
        {(() => {
          if (!monthUpcomingAbsences || monthUpcomingAbsences.length === 0) {
            return <div className="text-sm text-gray-600">Aucune absence Ã  venir sur ce mois.</div>;
          }
          // Grouper par vendeuse
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
                              <> â€” <Chip name={repl.volunteer_name} /> remplace <Chip name={name} />{repl.shift ? <> (<span>{shiftHumanLabel(repl.shift)}</span>)</> : null}</>
                            ) : (
                              <> â€” <span className="text-gray-500">pas de volontaire acceptÃ©</span></>
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
  );
}

/* ---------- Composants ---------- */
function shiftHumanLabel(code) { return SHIFT_LABELS[code] || code || "â€”"; }

function ShiftSelect({ dateStr, value, onChange }) {
  const sunday = isSunday(new Date(dateStr));
  const options = [
    { code: "MORNING", label: "Matin (6h30â€“13h30)" },
    { code: "MIDDAY", label: "Midi (7hâ€“13h)" },
    ...(sunday ? [{ code: "SUNDAY_EXTRA", label: "9hâ€“13h30" }] : []),
    { code: "EVENING", label: "Soir (13h30â€“20h30)" },
  ];
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">â€” Choisir un crÃ©neau â€”</option>
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
              <div className="text-sm mt-1">{assigned ? name : "â€”"}</div>
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
        <option value="">â€” Choisir vendeuse â€”</option>
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

  // Heures semaine â€” depuis la DB, **semaine en cours** et **uniquement les jours passÃ©s** (date < aujourdâ€™hui)
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!sellers || sellers.length === 0) { setWeekTotals({}); return; }
      try {
        const weekStart = fmtISODate(startOfWeek(new Date()));
        const todayIso = fmtISODate(new Date());
        const { data } = await supabase
          .from("shifts")
          .select("date, shift_code, seller_id")
          .gte("date", weekStart)
          .lt("date", todayIso); // exclut aujourdâ€™hui et futurs

        const dict = Object.fromEntries(sellers.map((s) => [s.user_id, 0]));
        (data || []).forEach((r) => {
          if (!r?.seller_id) return;
          const hrs = SHIFT_HOURS[r.shift_code] || 0;
          dict[r.seller_id] = (dict[r.seller_id] || 0) + hrs;
        });
        if (!cancelled) setWeekTotals(dict);
      } catch {
        if (!cancelled) setWeekTotals({});
      }
    };
    run();
    return () => { cancelled = true; };
  }, [sellers, refreshKey]);

  // Heures mois (dÃ©dupliquÃ© + sans jours futurs si mois courant)
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!sellers || sellers.length === 0) { setMonthTotals({}); return; }
      setLoading(true);
      try {
        const todayIso = fmtISODate(new Date());
        const isCurrentMonth = todayIso >= monthFrom && todayIso <= monthTo;
        const upper = isCurrentMonth ? todayIso : monthTo;

        const mq = await supabase
          .from("shifts")
          .select("date, shift_code, seller_id")
          .gte("date", monthFrom)
          .lte("date", upper);

        const rows = mq.data || [];
        const dict = Object.fromEntries(sellers.map((s) => [s.user_id, 0]));
        const seen = new Set();

        rows.forEach((r) => {
          if (!r.seller_id) return;
          const key = `${r.date}|${r.shift_code}|${r.seller_id}`;
          if (seen.has(key)) return;
          seen.add(key);
          const hrs = SHIFT_HOURS[r.shift_code] || 0;
          dict[r.seller_id] = (dict[r.seller_id] || 0) + hrs;
        });

        if (!cancelled) setMonthTotals(dict);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [sellers, monthFrom, monthTo, refreshKey]);

  // Jours de congÃ© pris sur l'annÃ©e en cours (approved, jusquâ€™Ã  aujourdâ€™hui inclus)
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
        // chevauchement avec [yearStart, min(today, yearEnd)]
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

  // Compteur d'absences du mois (approved, passÃ©es + Ã  venir)
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
        <div className="text-sm text-gray-600">Aucune vendeuse enregistrÃ©e.</div>
      </div>
    );

  return (
    <div className="card">
      <div className="hdr mb-1">Total heures â€” semaine en cours (jusquâ€™Ã  hier) & mois : {monthLabel}</div>
      {loading && <div className="text-sm text-gray-500 mb-3">Calcul en coursâ€¦</div>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {sellers.map((s) => {
          const week = weekTotals[s.user_id] || 0;
          const month = monthTotals[s.user_id] || 0;
          const absCount = absencesCount[s.user_id] || 0;
          const leaveDays = annualLeaveDays[s.user_id] || 0;
          return (
            <div key={s.user_id} className="border rounded-2xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Chip name={s.full_name} />
              </div>
              <div className="text-sm text-gray-600">Semaine (jusquâ€™Ã  hier)</div>
              <div className="text-2xl font-semibold">{week}</div>
              <div className="text-sm text-gray-600 mt-2">Mois ({monthLabel})</div>
              <div className="text-2xl font-semibold">{month}</div>
              <div className="text-sm text-gray-600 mt-2">Absences (mois)</div>
              <div className="text-2xl font-semibold">{absCount}</div>
              <div className="text-sm text-gray-600 mt-2">CongÃ©s pris (annÃ©e)</div>
              <div className="text-2xl font-semibold">{leaveDays}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Boutons colorÃ©s */
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
