/* eslint-disable react/no-unescaped-entities */

import { notifyAdminsNewAbsence } from '../lib/pushNotify';

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import WeekNav from "@/components/WeekNav";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "@/lib/date";

/* Libellés + créneau dimanche (doit exister dans shift_types) */
const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9h–13h30" };

/* Couleurs (identiques à l’admin) */
const SELLER_COLORS = { Antonia: "#e57373", Olivia: "#64b5f6", Colleen: "#81c784", Ibtissam: "#ba68c8" };
const colorForName = (name) => SELLER_COLORS[name] || "#9e9e9e";

const isSunday = (d) => d.getDay() === 0;
const weekdayFR = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const betweenIso = (iso, start, end) => iso >= start && iso <= end;
const frDate = (iso) => {
  try { return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR"); } catch { return iso; }
};
function firstDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function lastDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

export default function AppSeller() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  // Semaine affichée
  const [monday, setMonday] = useState(startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(monday, i)), [monday]);

  // Planning (lecture seule)
  const [assign, setAssign] = useState({});

  // Notifications remplacement + validation
  const [replAsk, setReplAsk] = useState(null); // { absence_id, date, absent_name }
  const [approvalMsg, setApprovalMsg] = useState(null); // { absence_id, date, absent_name }

  // Absence (form 1 jour)
  const [reasonAbs, setReasonAbs] = useState("");
  const [absDate, setAbsDate] = useState(fmtISODate(new Date()));
  const [msgAbs, setMsgAbs] = useState("");

  // Congé (form période)
  const [leaveStart, setLeaveStart] = useState(fmtISODate(new Date()));
  const [leaveEnd, setLeaveEnd] = useState(fmtISODate(addDays(new Date(), 1)));
  const [leaveReason, setLeaveReason] = useState("");
  const [msgLeave, setMsgLeave] = useState("");

  // Congés approuvés (tout le monde voit) — end_date >= today
  const [approvedLeaves, setApprovedLeaves] = useState([]);

  // Mes absences approuvées — mois courant
  const now = new Date();
  const myMonthFrom = fmtISODate(firstDayOfMonth(now));
  const myMonthTo = fmtISODate(lastDayOfMonth(now));
  const [myMonthAbs, setMyMonthAbs] = useState([]); // passées/aujourd’hui (dédupliquées)
  // À venir : [{date, ids: [...] }]
  const [myMonthUpcomingAbs, setMyMonthUpcomingAbs] = useState([]);

  /* Sécurité / redirections */
  useEffect(() => {
    if (loading) return;
    if (!session) r.replace("/login");
    if (profile && profile.role === "admin") r.replace("/admin");
  }, [session, profile, loading, r]);

  // Charger le planning de la semaine (lecture seule)
  useEffect(() => {
    const load = async () => {
      const from = fmtISODate(days[0]);
      const to = fmtISODate(days[6]);
      const { data, error } = await supabase
        .from("view_week_assignments")
        .select("date, shift_code, seller_id, full_name")
        .gte("date", from)
        .lte("date", to);
      if (error) { console.error("view_week_assignments error:", error); setAssign({}); return; }
      const next = {};
      (data || []).forEach((row) => {
        next[`${row.date}|${row.shift_code}`] = { seller_id: row.seller_id, full_name: row.full_name || "—" };
      });
      setAssign(next);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monday]);

  /* ----------------- Absence (form) ----------------- */
  const submitAbs = async () => {
  setMsgAbs("");

  const { error } = await supabase.from("absences").insert({
    date: absDate,
    seller_id: session.user.id,
    reason: reasonAbs || null,
    status: "pending",
  });

  if (error) {
    console.error(error);
    setMsgAbs("Échec d'envoi de la demande.");
    return;
  }

  // 🔔 push aux admins
  const { data: { user } } = await supabase.auth.getUser();
  const sellerName =
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'Vendeuse';

  await notifyAdminsNewAbsence({
    sellerName,
    startDate: absDate,
    endDate:   absDate
  });

  setMsgAbs("Demande d'absence envoyée. En attente de validation.");
  setReasonAbs("");
};


  /* ----------------- Congé (form) ----------------- */
  const submitLeave = async () => {
    setMsgLeave("");
    if (!leaveStart || !leaveEnd) { setMsgLeave("Merci de choisir une période complète."); return; }
    if (leaveEnd < leaveStart)    { setMsgLeave("La date de retour doit être après la date de départ."); return; }
    const { error } = await supabase.from("leaves").insert({
      seller_id: session.user.id, start_date: leaveStart, end_date: leaveEnd, reason: leaveReason || null, status: "pending",
    });
    if (error) { console.error(error); setMsgLeave("Échec de l’envoi du congé."); return; }
    setMsgLeave("Demande de congé envoyée. En attente de validation."); setLeaveReason("");
  };

  /* ----------------- “Remplacer ?” (pending/approved) ----------------- */
  const shouldPrompt = async (absence) => {
    const me = session?.user?.id;
    if (!me || !absence) return false;
    const todayIso = fmtISODate(new Date());
    if (absence.seller_id === me) return false;  // ne pas prévenir l’absente
    if (absence.date < todayIso) return false;   // seulement futur
    if (!["pending", "approved"].includes(absence.status)) return false;
    const { data: mine } = await supabase
      .from("replacement_interest").select("id")
      .eq("absence_id", absence.id).eq("volunteer_id", me).limit(1).maybeSingle();
    return !mine;
  };

  const openPrompt = async (absence) => {
    const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", absence.seller_id).single();
    setReplAsk({ absence_id: absence.id, date: absence.date, absent_name: prof?.full_name || "Une vendeuse" });
  };

  /* ----------------- Temps réel : INSERT/UPDATE absences (pending/approved) ----------------- */
  useEffect(() => {
    if (!session?.user?.id) return;
    const ch = supabase
      .channel("absences_rt_seller_pending_approved")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "absences" }, async (payload) => {
        const abs = payload.new; if (await shouldPrompt(abs)) openPrompt(abs);
        await loadMyMonthAbs(); await loadMyMonthUpcomingAbs();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "absences" }, async (payload) => {
        const abs = payload.new; if (await shouldPrompt(abs)) openPrompt(abs);
        await loadMyMonthAbs(); await loadMyMonthUpcomingAbs();
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session?.user?.id]);

  /* ----------------- PRÉCHARGEMENT : proposer un remplacement à l’ouverture ----------------- */
  useEffect(() => {
    if (!session?.user?.id) return;
    const preload = async () => {
      const todayIso = fmtISODate(new Date());
      const { data: abs, error } = await supabase
        .from("absences").select("id, date, seller_id, status")
        .in("status", ["pending", "approved"]).gte("date", todayIso)
        .order("date", { ascending: true });
      if (error || !abs || abs.length === 0) return;
      const { data: mine } = await supabase.from("replacement_interest").select("absence_id").eq("volunteer_id", session.user.id);
      const responded = new Set((mine || []).map((r) => r.absence_id));
      const target = abs.find((a) => a.seller_id !== session.user.id && !responded.has(a.id));
      if (!target) return;
      await openPrompt(target);
    };
    preload();
  }, [session?.user?.id]);

  // Volontariat Oui/Non
  const volunteerYes = async () => {
    if (!replAsk) return;
    const { error } = await supabase.from("replacement_interest").insert({
      absence_id: replAsk.absence_id, volunteer_id: session.user.id, status: "pending",
    });
    if (error) { console.error(error); alert("Impossible d’enregistrer votre volontariat."); return; }
    setReplAsk(null);
    alert("Merci ! Votre proposition de remplacement a été envoyée à l’admin.");
  };
  const volunteerNo = () => setReplAsk(null);

  /* ----------------- mémoriser les “validé” déjà vus (localStorage) ----------------- */
  const seenKey = (absenceId) => `ri_seen_${absenceId}`;
  const isSeen = (absenceId) => typeof window !== "undefined" && localStorage.getItem(seenKey(absenceId)) === "1";
  const markSeen = (absenceId) => { if (typeof window !== "undefined") localStorage.setItem(seenKey(absenceId), "1"); };

  /* ----------------- NOTIF “VALIDÉ” pour la volontaire (temps réel) ----------------- */
  useEffect(() => {
    if (!session?.user?.id) return;
    const ch = supabase
      .channel("replacement_rt_seller_approved")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "replacement_interest" }, async (payload) => {
        const oldS = payload.old?.status, newS = payload.new?.status;
        if (payload.new?.volunteer_id === session.user.id && oldS !== "accepted" && newS === "accepted" && !isSeen(payload.new.absence_id)) {
          const { data: abs } = await supabase.from("absences").select("date, seller_id").eq("id", payload.new.absence_id).single();
          const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", abs?.seller_id).single();
          setApprovalMsg({ absence_id: payload.new.absence_id, date: abs?.date, absent_name: prof?.full_name || "Une vendeuse" });
        }
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session?.user?.id]);

  // Préchargement : notif “validé” pas encore vue
  useEffect(() => {
    if (!session?.user?.id) return;
    const preloadAccepted = async () => {
      const todayIso = fmtISODate(new Date());
      const { data: rows } = await supabase.from("replacement_interest").select("absence_id").eq("volunteer_id", session.user.id).eq("status", "accepted");
      const target = (rows || []).find((r) => !isSeen(r.absence_id)); if (!target) return;
      const { data: abs } = await supabase.from("absences").select("id, date, seller_id").eq("id", target.absence_id).gte("date", todayIso).maybeSingle();
      if (!abs) return;
      const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", abs.seller_id).single();
      setApprovalMsg({ absence_id: target.absence_id, date: abs.date, absent_name: prof?.full_name || "Une vendeuse" });
    };
    preloadAccepted();
  }, [session?.user?.id]);

  /* ----------------- Congés approuvés visibles à toutes (end_date >= today) ----------------- */
  const loadApprovedLeaves = async () => {
    const todayIso = fmtISODate(new Date());
    const { data } = await supabase.from("leaves")
      .select("id, seller_id, start_date, end_date, status")
      .eq("status", "approved").gte("end_date", todayIso).order("start_date", { ascending: true });
    if (!data) { setApprovedLeaves([]); return; }
    const ids = Array.from(new Set(data.map((l) => l.seller_id)));
    let names = {};
    if (ids.length > 0) {
      const { data: profs } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
      (profs || []).forEach((p) => { names[p.user_id] = p.full_name; });
    }
    setApprovedLeaves(data.map((l) => ({ ...l, seller_name: names[l.seller_id] || "—" })));
  };
  useEffect(() => { loadApprovedLeaves(); }, []);
  useEffect(() => {
    const chLeaves = supabase.channel("leaves_rt_seller_view")
      .on("postgres_changes", { event: "*", schema: "public", table: "leaves" }, async () => { await loadApprovedLeaves(); })
      .subscribe();
    return () => { supabase.removeChannel(chLeaves); };
  }, []);

  /* ----------------- Mes absences approuvées — mois courant ----------------- */
  const loadMyMonthAbs = async () => {
    if (!session?.user?.id) return;
    const todayIso = fmtISODate(new Date());
    const { data } = await supabase
      .from("absences")
      .select("date")
      .eq("seller_id", session.user.id)
      .eq("status", "approved")
      .gte("date", myMonthFrom)
      .lte("date", myMonthTo)
      .lt("date", todayIso); // seulement passées (exclut aujourd’hui)

    // déduplication
    const arr = Array.from(new Set((data || []).map((r) => r.date))).sort((a, b) => a.localeCompare(b));
    setMyMonthAbs(arr);
  };

  const loadMyMonthUpcomingAbs = async () => {
    if (!session?.user?.id) return;
    const todayIso = fmtISODate(new Date());
    const { data } = await supabase
      .from("absences")
      .select("id, date, status")
      .eq("seller_id", session.user.id)
      .in("status", ["approved", "pending"]) // inclure aussi les pending
      .gte("date", myMonthFrom)
      .lte("date", myMonthTo)
      .gte("date", todayIso); // >= aujourd’hui (et plus demain)

    // Regrouper par date -> { date, ids[] }
    const byDate = {};
    (data || []).forEach((r) => {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r.id);
    });
    const arr = Object.keys(byDate)
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({ date, ids: byDate[date] }));
    setMyMonthUpcomingAbs(arr);
  };

  useEffect(() => { loadMyMonthAbs(); loadMyMonthUpcomingAbs(); }, [session?.user?.id, myMonthFrom, myMonthTo]);

  /* ----------------- SUPPRIMER une absence (aujourd’hui ou futur) ----------------- */
  const deleteMyAbsencesForDate = async (date) => {
    if (!session?.user?.id) return;

    const todayIso = fmtISODate(new Date());
    // Autorisé : aujourd’hui OU futur. Interdit : passé
    if (date < todayIso) {
      alert("Vous ne pouvez pas supprimer une absence déjà passée.");
      return;
    }

    if (!window.confirm(`Supprimer votre absence du ${frDate(date)} ?`)) return;

    // Récupérer toutes mes absences à cette date
    const { data: rows, error: qErr } = await supabase
      .from("absences")
      .select("id")
      .eq("seller_id", session.user.id)
      .eq("date", date);
    if (qErr) { console.error(qErr); alert("Lecture impossible."); return; }

    const ids = (rows || []).map((r) => r.id);
    if (ids.length === 0) { alert("Aucune absence trouvée pour cette date."); return; }

    // Si un remplacement est déjà ACCEPTÉ, on bloque
    const { data: repl } = await supabase
      .from("replacement_interest")
      .select("id, status")
      .in("absence_id", ids);
    const hasAccepted = (repl || []).some((r) => r.status === "accepted");
    if (hasAccepted) {
      alert("Cette absence a déjà un remplacement validé. Merci de contacter l’admin pour l’annuler.");
      return;
    }

    // Supprimer d’abord les propositions (si présentes)
    if ((repl || []).length > 0) {
      const { error: delReplErr } = await supabase
        .from("replacement_interest")
        .delete()
        .in("absence_id", ids);
      if (delReplErr) { console.error(delReplErr); alert("Suppression des propositions impossible."); return; }
    }

    // Supprimer l’absence
    const { error: delErr } = await supabase
      .from("absences")
      .delete()
      .eq("seller_id", session.user.id)
      .eq("date", date);
    if (delErr) { console.error(delErr); alert("Suppression impossible (droits RLS ?)"); return; }

    // Rafraîchir l’affichage
    await loadMyMonthUpcomingAbs();
    await loadMyMonthAbs();
    if (replAsk?.date === date) setReplAsk(null);

    alert("Absence supprimée.");
  };

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Bonjour {profile?.full_name || "—"}</div>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Se déconnecter</button>
      </div>

      {/* Bannière “Remplacer ?” */}
      {replAsk && (
        <div className="border rounded-2xl p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
             style={{ backgroundColor: "#fff7ed", borderColor: "#fdba74" }}>
          <div className="text-sm">
            <span className="font-medium">{replAsk.absent_name}</span> sera absente le{" "}
            <span className="font-medium">{replAsk.date}</span>. Voulez-vous la remplacer ?
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={volunteerYes} style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}>Oui</button>
            <button className="btn" onClick={volunteerNo}  style={{ backgroundColor: "#6b7280", color: "#fff", borderColor: "transparent" }}>Non</button>
          </div>
        </div>
      )}

      {/* Bannière “Validé” — ne réapparaît plus après OK (localStorage) */}
      {approvalMsg && (
        <div className="border rounded-2xl p-3 flex items-start sm:items-center justify-between gap-2"
             style={{ backgroundColor: "#ecfccb", borderColor: "#a3e635" }}>
          <div className="text-sm">
            ✅ Votre remplacement pour <span className="font-medium">{approvalMsg.absent_name}</span> le{" "}
            <span className="font-medium">{approvalMsg.date}</span> a été <span className="font-medium">validé</span>.
          </div>
          <button className="btn"
                  onClick={() => { if (approvalMsg?.absence_id) markSeen(approvalMsg.absence_id); setApprovalMsg(null); }}
                  style={{ backgroundColor: "#15803d", color: "#fff", borderColor: "transparent" }}>
            OK
          </button>
        </div>
      )}

      {/* Planning de la semaine (lecture seule, toutes vendeuses) */}
      <WeekView days={days} assign={assign} />

      {/* CONGÉS APPROUVÉS — visibles à toutes tant que non passés */}
      <div className="card">
        <div className="hdr mb-2">Congés approuvés — en cours ou à venir</div>
        {approvedLeaves.length === 0 ? (
          <div className="text-sm text-gray-600">Aucun congé approuvé à venir.</div>
        ) : (
          <ul className="space-y-2">
            {approvedLeaves.map((l) => {
              const todayIso = fmtISODate(new Date());
              const tag = betweenIso(todayIso, l.start_date, l.end_date) ? "En cours" : "À venir";
              const tagBg = tag === "En cours" ? "#16a34a" : "#2563eb";
              return (
                <li key={l.id} className="flex items-center justify-between border rounded-2xl p-3">
                  <div className="text-sm"><span className="font-medium">{l.seller_name}</span> — du {l.start_date} au {l.end_date}</div>
                  <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: tagBg }}>{tag}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* VOS ABSENCES (passées / aujourd’hui) */}
      {/* VOS ABSENCES (passées / aujourd’hui) */}
<div className="card">
  <div className="hdr mb-2">Vos absences ce mois</div>
  {myMonthAbs.length === 0 ? (
    <>
      {/* eslint-disable-next-line react/no-unescaped-entities */}
      <div className="text-sm text-gray-600">
        Vous n&#39;avez aucune absence approuvée passée (ou aujourd&#39;hui) ce mois-ci.
      </div>
    </>
  ) : (
    <div className="text-sm">
      {(() => {
        const list = myMonthAbs.map(frDate);
        const sentence =
          list.length === 1
            ? list[0]
            : `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`;
        return (
          <>
            Vous avez <span className="font-medium">{myMonthAbs.length}</span> jour(s)
            d&#39;absence ce mois-ci : {sentence}.
          </>
        );
      })()}
    </div>
  )}
</div>

{/* VOS ABSENCES À VENIR (ce mois) + bouton Supprimer */}
<div className="card">
  <div className="hdr mb-2">Vos absences à venir ce mois</div>
  {myMonthUpcomingAbs.length === 0 ? (
    <div className="text-sm text-gray-600">
      Aucune absence approuvée à venir ce mois-ci.
    </div>
  ) : (
    <ul className="space-y-2">
      {myMonthUpcomingAbs.map(({ date, ids }) => (
        <li
          key={date}
          className="flex items-center justify-between border rounded-2xl p-3"
        >
          <div className="text-sm">{frDate(date)}</div>
          {/* eslint-disable-next-line react/no-unescaped-entities */}
          <button
            className="btn"
            onClick={() => deleteMyAbsencesForDate(date)}
            title={`Supprimer l&#39;absence du ${frDate(date)}`}
            style={{
              backgroundColor: "#dc2626",
              color: "#fff",
              borderColor: "transparent",
            }}
          >
            Supprimer
          </button>
        </li>
      ))}
    </ul>
  )}
</div>


      {/* Demander une absence (1 jour) */}
      <div className="card">
        <div className="hdr mb-2">Demander une absence (1 jour)</div>
        <div className="grid md:grid-cols-3 gap-3 items-end">
          <div>
            <div className="text-sm mb-1">Date</div>
            <input type="date" className="input" value={absDate} onChange={(e) => setAbsDate(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <div className="text-sm mb-1">Motif (optionnel)</div>
            <input type="text" className="input" placeholder="ex: RDV médical" value={reasonAbs} onChange={(e) => setReasonAbs(e.target.value)} />
          </div>
          <div><button className="btn" onClick={submitAbs}>Envoyer la demande</button></div>
        </div>
        {msgAbs && <div className="text-sm mt-2">{msgAbs}</div>}
      </div>

      {/* Demander un congé (période) */}
      <div className="card">
        <div className="hdr mb-2">Demander un congé (période)</div>
        <div className="grid md:grid-cols-4 gap-3 items-end">
          <div>
            <div className="text-sm mb-1">Départ</div>
            <input type="date" className="input" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} />
          </div>
          <div>
            <div className="text-sm mb-1">Retour</div>
            <input type="date" className="input" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <div className="text-sm mb-1">Motif (optionnel)</div>
            <input type="text" className="input" placeholder="ex: congés annuels" value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} />
          </div>
          <div><button className="btn" onClick={submitLeave}>Envoyer le congé</button></div>
        </div>
        {msgLeave && <div className="text-sm mt-2">{msgLeave}</div>}
      </div>
    </div>
  );

  /* --- composant interne pour la semaine (lecture seule) --- */
  function WeekView({ days, assign }) {
    return (
      <div className="card">
        <div className="hdr mb-4">Planning de la semaine</div>
        <WeekNav
          monday={monday}
          onPrev={() => setMonday(addDays(monday, -7))}
          onToday={() => setMonday(startOfWeek(new Date()))}
          onNext={() => setMonday(addDays(monday, 7))}
        />
        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          {days.map((d) => {
            const iso = fmtISODate(d);
            const sunday = isSunday(d);
            return (
              <div key={iso} className="border rounded-2xl p-3 space-y-3">
                <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                <div className="font-semibold">{iso}</div>
                {["MORNING", "MIDDAY", ...(sunday ? ["SUNDAY_EXTRA"] : []), "EVENING"].map((code) => {
                  const label = SHIFT_LABELS[code];
                  const rec = assign[`${iso}|${code}`];
                  const name = rec?.full_name || "—";
                  const assigned = rec?.seller_id;
                  const bg = assigned ? colorForName(name) : "#f3f4f6";
                  const fg = assigned ? "#fff" : "#6b7280";
                  const border = assigned ? "transparent" : "#e5e7eb";
                  return (
                    <div key={code} className="rounded-2xl p-3" style={{ backgroundColor: bg, color: fg, border: `1px solid ${border}` }}>
                      <div className="text-sm">{label}</div>
                      <div className="mt-1 text-sm">{name}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
}
