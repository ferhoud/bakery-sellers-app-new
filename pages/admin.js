import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import WeekNav from "@/components/WeekNav";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "@/lib/date";

/* Heures par créneau (inclut le dimanche spécial) */
const SHIFT_HOURS = { MORNING: 7, MIDDAY: 6, EVENING: 7, SUNDAY_EXTRA: 4.5 };
const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9h–13h30" };

/* Couleurs fixes par vendeuse */
const SELLER_COLORS = {
  Antonia: "#e57373",
  Olivia: "#64b5f6",
  Colleen: "#81c784",
  Ibtissam: "#ba68c8",
};
const colorForName = (name) => SELLER_COLORS[name] || "#9e9e9e";

/* Utils date / libellés */
function firstDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function lastDayOfMonth(d)  { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function monthInputValue(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function labelMonthFR(d)    { return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }); }
const isSunday   = (d) => d.getDay() === 0;
const weekdayFR  = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });
const capFirst   = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const betweenIso = (iso, start, end) => iso >= start && iso <= end;
const frDate = (iso) => { try { return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR"); } catch { return iso; } };

function Chip({ name }) {
  if (!name || name === "—") return <span className="text-sm text-gray-500">—</span>;
  const bg = colorForName(name);
  return <span style={{ backgroundColor: bg, color: "#fff", borderRadius: 9999, padding: "2px 10px", fontSize: "0.8rem" }}>{name}</span>;
}

export default function Admin() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

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
  const [monthAbsences, setMonthAbsences] = useState([]);           // passées/aujourd’hui
  const [monthUpcomingAbsences, setMonthUpcomingAbsences] = useState([]); // à venir

  const [refreshKey, setRefreshKey] = useState(0);          // recalcul totaux mois
  const today = new Date();
  const todayIso = fmtISODate(today);

  /* Sécurité */
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
  const nameFromId = (id) => sellers.find((s) => s.user_id === id)?.full_name || "—";

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

  /* Absences d'aujourd'hui */
  const loadAbsencesToday = async () => {
  const { data: abs } = await supabase
    .from("absences")
    .select("id, seller_id, status, reason, date")
    .eq("date", todayIso)
    .in("status", ["pending", "approved"]);

  // Chercher, pour ces absences d'aujourd'hui, un remplacement ACCEPTÉ
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
        volunteer_name: names[r.volunteer_id] || "—",
      };
    });
  }

  const rows = (abs || []).map(a => ({ ...a, replacement: mapRepl[a.id] || null }));
  setAbsencesToday(rows);
};

  useEffect(() => { loadAbsencesToday(); }, [todayIso]);

  /* Absences en attente (toutes à venir) */
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

  /* Volontaires (absences approuvées) */
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
      id: r.id, volunteer_id: r.volunteer_id, volunteer_name: names[r.volunteer_id] || "—",
      absence_id: r.absence_id, date: r.absences?.date, absent_id: r.absences?.seller_id,
      absent_name: names[r.absences?.seller_id] || "—", status: r.status,
    }));
    setReplList(list);
  };
  useEffect(() => { loadReplacements(); }, [todayIso]);

  /* ======= CONGÉS ======= */
  const loadPendingLeaves = async () => {
    const { data } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, reason, status, created_at")
      .eq("status", "pending")
      .gte("end_date", todayIso)      // uniquement non passés
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
    setLatestLeave({ ...leave, seller_name: prof?.full_name || "—" });
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

  /* ======= ABSENCES DU MOIS (APPROUVÉES) ======= */
  const loadMonthAbsences = async () => {
  const tIso = fmtISODate(new Date());
  const { data } = await supabase
    .from("absences")
    .select("seller_id, date, status")
    .eq("status", "approved")
    .gte("date", monthFrom)
    .lte("date", monthTo)
    .lte("date", tIso); // passées/aujourd’hui

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
    .select("seller_id, date, status")
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


  useEffect(() => { loadPendingLeaves(); loadLatestLeave(); loadApprovedLeaves(); }, [todayIso]);
  useEffect(() => { loadMonthAbsences(); loadMonthUpcomingAbsences(); }, [monthFrom, monthTo, refreshKey]);

  /* Realtime : absences + replacement + leaves */
  useEffect(() => {
    const chAbs = supabase
      .channel("absences_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "absences" }, () => {
        loadPendingAbs(); loadAbsencesToday(); loadReplacements(); loadMonthAbsences(); loadMonthUpcomingAbsences();
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
            id: r.id, volunteer_id: r.volunteer_id, volunteer_name: vol.data?.full_name || "—",
            absence_id: r.absence_id, date: abs?.date, absent_id: abs?.seller_id,
            absent_name: absName.data?.full_name || "—", status: r.status,
          });
        }
        loadReplacements();
      }).subscribe();

    const chLeaves = supabase
      .channel("leaves_rt_admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "leaves" }, async () => {
        await loadPendingLeaves();
        await loadApprovedLeaves();
      }).subscribe();

    return () => { supabase.removeChannel(chAbs); supabase.removeChannel(chRepl); supabase.removeChannel(chLeaves); };
  }, [todayIso]);

  /* Sauvegarde d'une affectation */
  const save = async (iso, code, seller_id) => {
    const key = `${iso}|${code}`;
    setAssign((prev) => ({ ...prev, [key]: seller_id || null }));
    const { error } = await supabase
      .from("shifts")
      .upsert({ date: iso, shift_code: code, seller_id: seller_id || null }, { onConflict: "date,shift_code" })
      .select("date");
    if (error) { console.error("UPSERT shifts error:", error); alert("Échec de sauvegarde du planning (RLS ?)"); return; }
    setRefreshKey((k) => k + 1);
  };

  /* Copier la semaine -> semaine suivante */
  const copyWeekToNext = async () => {
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
  };

  /* Actions absence */
  const approveAbs = async (id) => {
    const { error } = await supabase.from("absences").update({ status: "approved" }).eq("id", id);
    if (error) { alert("Impossible d'approuver (RLS ?)"); return; }
    await loadPendingAbs(); await loadAbsencesToday(); await loadMonthAbsences(); await loadMonthUpcomingAbsences();
  };
  const rejectAbs = async (id) => {
    const { error } = await supabase.from("absences").update({ status: "rejected" }).eq("id", id);
    if (error) { alert("Impossible de rejeter (RLS ?)"); return; }
    await loadPendingAbs(); await loadAbsencesToday(); await loadMonthAbsences(); await loadMonthUpcomingAbsences();
  };

  /* Attribuer / Refuser volontaire */
  const assignVolunteer = async (repl) => {
  const shift = selectedShift[repl.id];
  if (!shift) { alert("Choisis d’abord un créneau."); return; }

  // 1) Mettre la volontaire dans le planning
  const { error: errUpsert } = await supabase
    .from("shifts")
    .upsert({ date: repl.date, shift_code: shift, seller_id: repl.volunteer_id }, { onConflict: "date,shift_code" })
    .select("date");
  if (errUpsert) { console.error(errUpsert); alert("Échec d’attribution (RLS ?)"); return; }

  // 2) Marquer cette proposition comme acceptée et les autres comme refusées
  await supabase.from("replacement_interest").update({ status: "accepted" }).eq("id", repl.id);
  await supabase.from("replacement_interest").update({ status: "declined" }).eq("absence_id", repl.absence_id).neq("id", repl.id);

  // 3) IMPORTANT : si l’absence est encore 'pending', l’approuver automatiquement
  const { data: absRow } = await supabase
    .from("absences")
    .select("status")
    .eq("id", repl.absence_id)
    .single();
  if (absRow?.status !== "approved") {
    await supabase.from("absences").update({ status: "approved" }).eq("id", repl.absence_id);
  }

  if (latestRepl && latestRepl.id === repl.id) setLatestRepl(null);

  // 4) Rafraîchir tous les blocs (y compris "à venir" du mois)
  setRefreshKey((k) => k + 1);
  await Promise.all([loadReplacements(), loadMonthAbsences(), loadMonthUpcomingAbsences()]);
  alert("Volontaire attribuée et absence approuvée.");
};

  const declineVolunteer = async (replId) => {
    const { error } = await supabase.from("replacement_interest").update({ status: "declined" }).eq("id", replId);
    if (error) { console.error(error); alert("Impossible de refuser ce volontaire."); return; }
    if (latestRepl && latestRepl.id === replId) setLatestRepl(null);
    await loadReplacements();
  };

  /* Actions congé */
  const approveLeave = async (id) => {
    const { error } = await supabase.from("leaves").update({ status: "approved" }).eq("id", id);
    if (error) { alert("Impossible d'approuver le congé."); return; }
    if (latestLeave && latestLeave.id === id) setLatestLeave(null);
    await loadPendingLeaves(); await loadApprovedLeaves();
  };
  const rejectLeave = async (id) => {
    const { error } = await supabase.from("leaves").update({ status: "rejected" }).eq("id", id);
    if (error) { alert("Impossible de rejeter le congé."); return; }
    if (latestLeave && latestLeave.id === id) setLatestLeave(null);
    await loadPendingLeaves(); await loadApprovedLeaves();
  };

  /* Boutons colorés */
  const ApproveBtn = ({ onClick }) => <button className="btn" onClick={onClick} style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}>Approuver</button>;
  const RejectBtn  = ({ onClick }) => <button className="btn" onClick={onClick} style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}>Rejeter</button>;

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
  <div className="hdr">
    Compte: {profile?.full_name || "—"} <span className="sub">(admin)</span>
  </div>
  <div className="flex items-center gap-2">
    <button className="btn" onClick={() => r.push('/push-setup')}>
      🔔 Activer les notifications
    </button>
    <button className="btn" onClick={() => supabase.auth.signOut()}>
      Se déconnecter
    </button>
  </div>
</div>


      {/* BANNIÈRE : Demande de congé (la plus récente) */}
      {latestLeave && (
        <div className="border rounded-2xl p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2"
             style={{ backgroundColor: "#fef3c7", borderColor: "#fcd34d" }}>
          <div className="text-sm">
            <span className="font-medium">{latestLeave.seller_name}</span> demande un congé du{" "}
            <span className="font-medium">{latestLeave.start_date}</span> au <span className="font-medium">{latestLeave.end_date}</span>
            {latestLeave.reason ? <> — <span>{latestLeave.reason}</span></> : null}.
          </div>
          <div className="flex gap-2">
            <ApproveBtn onClick={() => approveLeave(latestLeave.id)} />
            <RejectBtn onClick={() => rejectLeave(latestLeave.id)} />
          </div>
        </div>
      )}

      {/* BANNIÈRE : Volontariat de remplacement */}
      {latestRepl && (
        <div className="border rounded-2xl p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2"
             style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}>
          <div className="text-sm">
            <span className="font-medium">{latestRepl.volunteer_name}</span> veut remplacer <Chip name={latestRepl.absent_name} /> le <span className="font-medium">{latestRepl.date}</span>.
          </div>
          <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
            <ShiftSelect dateStr={latestRepl.date} value={selectedShift[latestRepl.id] || ""} onChange={(val) => setSelectedShift(prev => ({ ...prev, [latestRepl.id]: val }))} />
            <button className="btn" onClick={() => assignVolunteer(latestRepl)} style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}>Approuver</button>
            <button className="btn" onClick={() => declineVolunteer(latestRepl.id)} style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}>Refuser</button>
          </div>
        </div>
      )}

      {/* Absences aujourd’hui — disparaît après le jour J */}
      <div className="card">
        <div className="hdr mb-2">Absences aujourd’hui</div>
        {absencesToday.length === 0 ? <div className="text-sm">Aucune absence aujourd’hui</div> : (
          <ul className="list-disc pl-6 space-y-1">
  {absencesToday.map((a) => (
    <li key={a.id}>
      <Chip name={nameFromId(a.seller_id)} /> — {a.status}
      {a.reason ? ` · ${a.reason}` : ""}
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

      {/* Demandes d’absence — en attente */}
      <div className="card">
        <div className="hdr mb-2">Demandes d’absence — en attente (à venir)</div>
        {pendingAbs.length === 0 ? <div className="text-sm text-gray-600">Aucune demande en attente.</div> : (
          <div className="space-y-2">
            {pendingAbs.map((a) => {
              const name = nameFromId(a.seller_id);
              return (
                <div key={a.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                  <div><div className="font-medium">{name}</div><div className="text-sm text-gray-600">{a.date} {a.reason ? `· ${a.reason}` : ""}</div></div>
                  <div className="flex gap-2"><ApproveBtn onClick={() => approveAbs(a.id)} /><RejectBtn onClick={() => rejectAbs(a.id)} /></div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Demandes de congé — en attente */}
      <div className="card">
        <div className="hdr mb-2">Demandes de congé — en attente</div>
        {pendingLeaves.length === 0 ? <div className="text-sm text-gray-600">Aucune demande de congé en attente.</div> : (
          <div className="space-y-2">
            {pendingLeaves.map((l) => {
              const name = nameFromId(l.seller_id);
              return (
                <div key={l.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                  <div>
                    <div className="font-medium">{name}</div>
                    <div className="text-sm text-gray-600">Du {l.start_date} au {l.end_date}{l.reason ? ` · ${l.reason}` : ""}</div>
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

      {/* Congés approuvés — en cours ou à venir */}
      <div className="card">
        <div className="hdr mb-2">Congés approuvés — en cours ou à venir</div>
        {approvedLeaves.length === 0 ? (
          <div className="text-sm text-gray-600">Aucun congé approuvé à venir.</div>
        ) : (
          <div className="space-y-2">
            {approvedLeaves.map((l) => {
              const name = nameFromId(l.seller_id);
              const tag = betweenIso(todayIso, l.start_date, l.end_date) ? "En cours" : "À venir";
              const tagBg = tag === "En cours" ? "#16a34a" : "#2563eb";
              return (
                <div key={l.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                  <div>
                    <div className="font-medium">{name}</div>
                    <div className="text-sm text-gray-600">Du {l.start_date} au {l.end_date}</div>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: tagBg }}>{tag}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Planning du jour */}
      <TodayColorBlocks today={today} todayIso={todayIso} assign={assign} nameFromId={nameFromId} />

      {/* Planning de la semaine (édition) */}
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
          <button className="btn" onClick={copyWeekToNext}>Copier la semaine → la suivante</button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          {days.map((d) => {
            const iso = fmtISODate(d);
            const sunday = isSunday(d);
            return (
              <div key={iso} className="border rounded-2xl p-3 space-y-3">
                <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                <div className="font-semibold">{iso}</div>

                <ShiftRow label="Matin (6h30–13h30)" iso={iso} code="MORNING" value={assign[`${iso}|MORNING`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|MORNING`])} />

                {!sunday ? (
                  <ShiftRow label="Midi (7h–13h)" iso={iso} code="MIDDAY" value={assign[`${iso}|MIDDAY`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|MIDDAY`])} />
                ) : (
                  <div className="space-y-1">
                    <div className="text-sm">Midi — deux postes</div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-xs mb-1">7h–13h</div>
                        <select className="select" value={assign[`${iso}|MIDDAY`] || ""} onChange={(e) => save(iso, "MIDDAY", e.target.value || null)}>
                          <option value="">— Choisir vendeuse —</option>
                          {sellers.map((s) => (<option key={s.user_id} value={s.user_id}>{s.full_name}</option>))}
                        </select>
                        <div className="mt-1"><Chip name={nameFromId(assign[`${iso}|MIDDAY`])} /></div>
                      </div>
                      <div>
                        <div className="text-xs mb-1">9h–13h30</div>
                        <select className="select" value={assign[`${iso}|SUNDAY_EXTRA`] || ""} onChange={(e) => save(iso, "SUNDAY_EXTRA", e.target.value || null)}>
                          <option value="">— Choisir vendeuse —</option>
                          {sellers.map((s) => (<option key={s.user_id} value={s.user_id}>{s.full_name}</option>))}
                        </select>
                        <div className="mt-1"><Chip name={nameFromId(assign[`${iso}|SUNDAY_EXTRA`])} /></div>
                      </div>
                    </div>
                  </div>
                )}

                <ShiftRow label="Soir (13h30–20h30)" iso={iso} code="EVENING" value={assign[`${iso}|EVENING`] || ""} onChange={save} sellers={sellers} chipName={nameFromId(assign[`${iso}|EVENING`])} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Sélecteur de MOIS */}
      <div className="card">
        <div className="hdr mb-2">Choisir le mois pour “Total heures (mois)”</div>
        <div className="grid sm:grid-cols-3 gap-3 items-center">
          <div className="sm:col-span-2">
            <div className="text-sm mb-1">Mois</div>
            <input type="month" className="input" value={monthInputValue(selectedMonth)} onChange={(e) => {
              const [y, m] = e.target.value.split("-").map(Number); setSelectedMonth(new Date(y, m - 1, 1)); }} />
          </div>
          <div className="text-sm text-gray-600">Mois sélectionné : <span className="font-medium">{labelMonthFR(selectedMonth)}</span></div>
        </div>
      </div>

      {/* Totaux */}
      <TotalsGrid sellers={sellers} days={days} assign={assign} monthFrom={monthFrom} monthTo={monthTo} monthLabel={labelMonthFR(selectedMonth)} refreshKey={refreshKey} />

      {/* Absences approuvées — MOIS (passées / aujourd’hui) */}
      <div className="card">
        <div className="hdr mb-2">Absences approuvées — mois : {labelMonthFR(selectedMonth)}</div>
        {(() => {
          const bySeller = {};
          monthAbsences.forEach((a) => {
            if (!bySeller[a.seller_id]) bySeller[a.seller_id] = [];
            bySeller[a.seller_id].push(a.date);
          });
          const entries = Object.entries(bySeller);
          if (entries.length === 0) {
            return <div className="text-sm text-gray-600">Aucune absence (passée/aujourd’hui) sur ce mois.</div>;
          }
          return (
            <ul className="space-y-2">
              {entries.map(([sid, dates]) => {
                dates.sort((a,b)=>a.localeCompare(b));
                const name = nameFromId(sid);
                const fr = dates.map(frDate);
                const list = fr.length === 1 ? fr[0] : `${fr.slice(0, -1).join(", ")} et ${fr[fr.length - 1]}`;
                return (
                  <li key={sid} className="text-sm">
                    <span className="font-medium">{name}</span> : {dates.length} jour(s) — {list}
                  </li>
                );
              })}
            </ul>
          );
        })()}
      </div>

      {/* === NOUVEAU : Absences approuvées à venir — MOIS (dates futures) === */}
      <div className="card">
        <div className="hdr mb-2">Absences approuvées à venir — mois : {labelMonthFR(selectedMonth)}</div>
        {(() => {
          const bySeller = {};
          monthUpcomingAbsences.forEach((a) => {
            if (!bySeller[a.seller_id]) bySeller[a.seller_id] = [];
            bySeller[a.seller_id].push(a.date);
          });
          const entries = Object.entries(bySeller);
          if (entries.length === 0) {
            return <div className="text-sm text-gray-600">Aucune absence à venir sur ce mois.</div>;
          }
          return (
            <ul className="space-y-2">
              {entries.map(([sid, dates]) => {
                dates.sort((a,b)=>a.localeCompare(b));
                const name = nameFromId(sid);
                const fr = dates.map(frDate);
                const list = fr.length === 1 ? fr[0] : `${fr.slice(0, -1).join(", ")} et ${fr[fr.length - 1]}`;
                return (
                  <li key={sid} className="text-sm">
                    <span className="font-medium">{name}</span> : {dates.length} jour(s) — {list}
                  </li>
                );
              })}
            </ul>
          );
        })()}
      </div>
    </div>
  );
}

/* ---------- Composants ---------- */
function ShiftSelect({ dateStr, value, onChange }) {
  const sunday = isSunday(new Date(dateStr));
  const options = [
    { code: "MORNING", label: "Matin (6h30–13h30)" },
    { code: "MIDDAY", label: "Midi (7h–13h)" },
    ...(sunday ? [{ code: "SUNDAY_EXTRA", label: "9h–13h30" }] : []),
    { code: "EVENING", label: "Soir (13h30–20h30)" },
  ];
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Choisir un créneau —</option>
      {options.map(op => <option key={op.code} value={op.code}>{op.label}</option>)}
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
              <div className="text-sm mt-1">{assigned ? name : "—"}</div>
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
        <option value="">— Choisir vendeuse —</option>
        {sellers.map((s) => (<option key={s.user_id} value={s.user_id}>{s.full_name}</option>))}
      </select>
      <div><Chip name={chipName} /></div>
    </div>
  );
}

function TotalsGrid({ sellers, days, assign, monthFrom, monthTo, monthLabel, refreshKey }) {
  const [monthTotals, setMonthTotals] = useState({});
  const [loading, setLoading] = useState(false);
  const weekTotals = useMemo(() => {
    const dict = Object.fromEntries(sellers.map((s) => [s.user_id, 0]));
    const isoDays = days.map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    Object.keys(SHIFT_HOURS).forEach((code) => {
      isoDays.forEach((iso) => {
        const sellerId = assign[`${iso}|${code}`];
        if (sellerId) dict[sellerId] = (dict[sellerId] || 0) + (SHIFT_HOURS[code] || 0);
      });
    });
    return dict;
  }, [sellers, days, assign]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!sellers || sellers.length === 0) { setMonthTotals({}); return; }
      setLoading(true);
      try {
        const mq = await supabase.from("shifts").select("date, shift_code, seller_id").gte("date", monthFrom).lte("date", monthTo);
        const rows = mq.data || [];
        const dict = Object.fromEntries(sellers.map((s) => [s.user_id, 0]));
        rows.forEach((r) => { if (!r.seller_id) return; const hrs = SHIFT_HOURS[r.shift_code] || 0; dict[r.seller_id] = (dict[r.seller_id] || 0) + hrs; });
        if (!cancelled) setMonthTotals(dict);
      } finally { if (!cancelled) setLoading(false); }
    };
    run();
    return () => { cancelled = true; };
  }, [sellers, monthFrom, monthTo, refreshKey]);

  if (!sellers || sellers.length === 0) return (<div className="card"><div className="hdr mb-2">Total heures vendeuses</div><div className="text-sm text-gray-600">Aucune vendeuse enregistrée.</div></div>);
  return (
    <div className="card">
      <div className="hdr mb-1">Total heures — semaine affichée & mois : {monthLabel}</div>
      {loading && <div className="text-sm text-gray-500 mb-3">Calcul en cours…</div>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {sellers.map((s) => {
          const week = weekTotals[s.user_id] || 0;
          const month = monthTotals[s.user_id] || 0;
          return (
            <div key={s.user_id} className="border rounded-2xl p-3 space-y-2">
              <div className="flex items-center justify-between"><Chip name={s.full_name} /></div>
              <div className="text-sm text-gray-600">Semaine</div>
              <div className="text-2xl font-semibold">{week}</div>
              <div className="text-sm text-gray-600 mt-2">Mois ({monthLabel})</div>
              <div className="text-2xl font-semibold">{month}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
