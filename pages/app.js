/* eslint-disable react/no-unescaped-entities */

import { notifyAdminsNewAbsence } from '../lib/pushNotify';

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/useAuth";
import { isAdminEmail } from "@/lib/admin";
import WeekNav from "@/components/WeekNav";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "@/lib/date";
import LeaveRequestForm from "@/components/LeaveRequestForm";

/* Libellés + créneau dimanche (doit exister dans shift_types) */
const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9h-13h30" };
/* Couleurs (fixes + auto pour nouvelles vendeuses) */
const SELLER_COLOR_OVERRIDES = {
  antonia:  "#e57373",
  olivia:   "#64b5f6",
  colleen:  "#81c784",
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
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function autoColorFromName(name) {
  const key = normalize(name);
  const hue = hashStr(key) % 360;   // 0..359
  return hslToHex(hue, 65, 50);     // saturé, lisible
}

/** Placeholder (nom manquant) */
function isNamePlaceholder(name) {
  const n = String(name || "").trim();
  return !n || n === "-" || n === "—";
}

/** Couleur finale (stable) : priorité override par nom, sinon hash (nom → seller_id) */
function colorForSeller(sellerId, name) {
  const ovr = SELLER_COLOR_OVERRIDES[normalize(name)];
  if (ovr) return ovr;
  const key = isNamePlaceholder(name) ? String(sellerId || "unknown") : String(name);
  return autoColorFromName(key);
}

const isSunday = (d) => d.getDay() === 0;
const weekdayFR = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const betweenIso = (iso, start, end) => iso >= start && iso <= end;
const frDate = (iso) => { try { return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR"); } catch { return iso; } };
function firstDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function lastDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function labelForShift(code) {
  switch (code) {
    case "MORNING": return "Matin (6h30-13h30)";
    case "MIDDAY": return "Midi (7h-13h)";
    case "SUNDAY_EXTRA": return "Dimanche 9h-13h30";
    case "EVENING": return "Soir (13h30-20h30)";
    default: return code || "—";
  }
}

export default function AppSeller() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  // 🔧 Fallback local pour ne pas rester bloqué si profile tarde / manque
  const [profileFallback, setProfileFallback] = useState(null);
  const [profileTried, setProfileTried] = useState(false);

  useEffect(() => {
    // Quand on a une session mais pas de profile fourni par useAuth, on tente une lecture directe.
    const run = async () => {
      if (!session || profile || profileTried) return;
      try {
        const { data: p, error } = await supabase
          .from("profiles")
          .select("user_id, full_name, role")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (!error && p) setProfileFallback(p);
      } catch (e) {
        // ignore
      } finally {
        setProfileTried(true);
      }
    };
    run();
  }, [session, profile, profileTried]);

  const displayName =
    profile?.full_name ||
    profileFallback?.full_name ||
    session?.user?.user_metadata?.full_name ||
    (session?.user?.email ? session.user.email.split("@")[0] : "—");

  // Sécurité / redirections
  // 🔒 Redirection selon auth/role — UN SEUL useEffect
  useEffect(() => {
    if (loading) return;
    if (!session) { r.replace("/login"); return; }

    const role =
      profile?.role
      ?? profileFallback?.role
      ?? "seller";

    if (role === "admin") {
      r.replace("/admin");
    }
  }, [session, profile, profileFallback, loading, r]);

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
  const todayIso = useMemo(() => fmtISODate(new Date()), []);
  const [absDate, setAbsDate] = useState(fmtISODate(new Date()));
  const [msgAbs, setMsgAbs] = useState("");

  // Congés approuvés (tout le monde voit) — end_date >= today
  const [approvedLeaves, setApprovedLeaves] = useState([]);

  // Fenêtres de temps :
  const rangeTo  = fmtISODate(addDays(new Date(), 60)); // prochains 60 jours

  // Mes absences passées (approuvées) — mois courant
  const now = new Date();
  const myMonthFromPast = fmtISODate(firstDayOfMonth(now));
  const myMonthToPast   = fmtISODate(lastDayOfMonth(now));
  const [myMonthAbs, setMyMonthAbs] = useState([]);

  // Mes absences à venir (fenêtre glissante, pas seulement le mois)
  // [{ date, ids: [...], status: 'pending' | 'approved', locked: boolean }]
  const [myMonthUpcomingAbs, setMyMonthUpcomingAbs] = useState([]);

  // Remplacements acceptés pour MES absences (par absence_id)
  // { [absence_id]: { volunteer_id, volunteer_name, shift: accepted_shift_code } }
  const [acceptedByAbsence, setAcceptedByAbsence] = useState({});

  // Mes remplacements à venir (je suis la volontaire acceptée)
  // [{ absence_id, date, absent_id, accepted_shift_code }]
  const [myUpcomingRepl, setMyUpcomingRepl] = useState([]);
  const [names, setNames] = useState({}); // user_id -> full_name

  // 📛 Noms des vendeuses (planning / remplacements)
  // IMPORTANT : nécessite soit une policy SELECT sur profiles (vendeuses), soit la RPC "list_active_seller_names".
  const loadSellerNames = useCallback(async () => {
    try {
      // 1) On tente d'abord une RPC dédiée (recommandé pour ne pas ouvrir toute la table profiles)
      const { data: rpcData, error: rpcErr } = await supabase.rpc("list_active_seller_names");

      let rows = null;
      if (!rpcErr && Array.isArray(rpcData)) {
        rows = rpcData;
      } else {
        // 2) Fallback direct (marche si RLS le permet)
        const { data: profs, error } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .eq("role", "seller")
          .eq("active", true);

        if (error) throw error;
        rows = profs;
      }

      const map = {};
      (rows || []).forEach((p) => {
        if (p?.user_id) map[p.user_id] = p.full_name || "";
      });
      setNames(map);
    } catch (e) {
      console.warn("loadSellerNames failed (RLS ?):", e?.message || e);
    }
  }, []);

  useEffect(() => {
    if (!session?.user?.id) return;
    loadSellerNames();
  }, [session?.user?.id, loadSellerNames]);

  // ✅ DÉRIVÉ : bannière "Absente aujourd'hui" (pour la vendeuse connectée)
  const absentToday = useMemo(() => {
    const entry = (myMonthUpcomingAbs || []).find((a) => a.date === todayIso);
    if (!entry) return null;
    // Chercher un volontaire accepté pour l'un des ids
    let accepted = null;
    let acceptedShift = null;
    for (const id of entry.ids) {
      if (acceptedByAbsence[id]) {
        accepted = acceptedByAbsence[id];
        acceptedShift = acceptedByAbsence[id].shift || null;
        break;
      }
    }
    return {
      date: todayIso,
      status: entry.status,       // 'pending' | 'approved'
      locked: !!entry.locked,     // admin_forced => true
      accepted,                   // { volunteer_name, shift } | null
      acceptedShift,              // string | null
    };
  }, [myMonthUpcomingAbs, acceptedByAbsence, todayIso]);

  // Charger le planning de la semaine (lecture seule)
  useEffect(() => {
    if (!session) return; // ne rien faire tant qu’on n’a pas de session
    const load = async () => {
      const from = fmtISODate(days[0]);
      const to = fmtISODate(days[6]);
      const { data, error } = await supabase
        .from("view_week_assignments")
        .select("date, shift_code, seller_id, full_name")
        .gte("date", from)
        .lte("date", to);
      if (error) { console.error("view_week_assignments error:", error); return; }
      const next = {};
      (data || []).forEach((row) => {
        next[`${row.date}|${row.shift_code}`] = { seller_id: row.seller_id, full_name: row.full_name || null };
      });
      setAssign(next);
    };
    load();
  }, [monday, session, days]);

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

    await notifyAdminsNewAbsence({ sellerName, startDate: absDate, endDate: absDate });

    setMsgAbs("Demande d'absence envoyée. En attente de validation.");
    setReasonAbs("");
  };

  /* ----------------- “Remplacer ?” (pending/approved) ----------------- */
  const shouldPrompt = async (absence) => {
    const me = session?.user?.id;
    if (!me || !absence) return false;
    const tIso = fmtISODate(new Date());
    if (absence.seller_id === me) return false;  // ne pas prévenir l’absente
    if (absence.date < tIso) return false;       // seulement futur
    if (absence.status !== "approved") return false;
    if (absence.admin_forced) return false;      // 🚫 pas de prompt si absence posée par l’admin
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
        const abs = payload.new;
        if (await shouldPrompt(abs)) openPrompt(abs);
        await loadMyMonthAbs(); await loadMyMonthUpcomingAbs(); await reloadAccepted(); await loadMyUpcomingRepl();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "absences" }, async (payload) => {
        const abs = payload.new;
        if (await shouldPrompt(abs)) openPrompt(abs);
        await loadMyMonthAbs(); await loadMyMonthUpcomingAbs(); await reloadAccepted(); await loadMyUpcomingRepl();
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session?.user?.id]);

  /* ----------------- PRÉCHARGEMENT : proposer un remplacement à l’ouverture ----------------- */
  useEffect(() => {
    if (!session?.user?.id) return;
    const preload = async () => {
      const tIso = fmtISODate(new Date());
      const { data: abs, error } = await supabase
        .from("absences").select("id, date, seller_id, status, admin_forced")
        .eq("status", "approved").gte("date", tIso)
        .eq("admin_forced", false)  // 🚫 exclure absences admin
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

  /* ----------------- NOTIF “Validé” — volontaire ----------------- */
  useEffect(() => {
    if (!session?.user?.id) return;
    const ch = supabase
      .channel("replacement_rt_seller_approved")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "replacement_interest" }, async (payload) => {
        const oldS = payload.old?.status, newS = payload.new?.status;
        // 👉 Si JE suis la volontaire : bannière "validé"
        if (payload.new?.volunteer_id === session.user.id && oldS !== "accepted" && newS === "accepted" && !isSeen(payload.new.absence_id)) {
          const { data: abs } = await supabase.from("absences").select("date, seller_id").eq("id", payload.new.absence_id).single();
          const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", abs?.seller_id).single();
          setApprovalMsg({ absence_id: payload.new.absence_id, date: abs?.date, absent_name: prof?.full_name || "Une vendeuse" });
        }
        await reloadAccepted();
        await loadMyUpcomingRepl();
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session?.user?.id]);

  // Préchargement : notif “validé” pas encore vue
  useEffect(() => {
    if (!session?.user?.id) return;
    const preloadAccepted = async () => {
      const tIso = fmtISODate(new Date());
      const { data: rows } = await supabase.from("replacement_interest").select("absence_id").eq("volunteer_id", session.user.id).eq("status", "accepted");
      const target = (rows || []).find((r) => !isSeen(r.absence_id)); if (!target) return;
      const { data: abs } = await supabase.from("absences").select("id, date, seller_id").eq("id", target.absence_id).gte("date", tIso).maybeSingle();
      if (!abs) return;
      const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", abs.seller_id).single();
      setApprovalMsg({ absence_id: target.absence_id, date: abs.date, absent_name: prof?.full_name || "Une vendeuse" });
    };
    preloadAccepted();
  }, [session?.user?.id]);

  /* ----------------- Congés approuvés visibles à toutes (end_date >= today) ----------------- */
  const loadApprovedLeaves = async () => {
    const tIso = fmtISODate(new Date());
    const { data } = await supabase.from("leaves")
      .select("id, seller_id, start_date, end_date, status")
      .eq("status", "approved").gte("end_date", tIso).order("start_date", { ascending: true });
    if (!data) { setApprovedLeaves([]); return; }
    const ids = Array.from(new Set(data.map((l) => l.seller_id)));
    let namesMap = {};
    if (ids.length > 0) {
      const { data: profs } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
      (profs || []).forEach((p) => { namesMap[p.user_id] = p.full_name; });
    }
    setApprovedLeaves(data.map((l) => ({ ...l, seller_name: namesMap[l.seller_id] || "—" })));
  };
  useEffect(() => { loadApprovedLeaves(); }, []);
  useEffect(() => {
    const chLeaves = supabase.channel("leaves_rt_seller_view")
      .on("postgres_changes", { event: "*", schema: "public", table: "leaves" }, async () => { await loadApprovedLeaves(); })
      .subscribe();
    return () => { supabase.removeChannel(chLeaves); };
  }, []);

  /* ----------------- Mes absences approuvées — mois courant (passées uniquement) ----------------- */
  const loadMyMonthAbs = async () => {
    if (!session?.user?.id) return;
    const tIso = fmtISODate(new Date());
    const { data } = await supabase
      .from("absences")
      .select("date")
      .eq("seller_id", session.user.id)
      .eq("status", "approved")
      .gte("date", myMonthFromPast)
      .lte("date", myMonthToPast)
      .lt("date", tIso); // passées uniquement
    const arr = Array.from(new Set((data || []).map((r) => r.date))).sort((a, b) => a.localeCompare(b));
    setMyMonthAbs(arr);
  };

  /* ----------------- Mes absences à venir — fenêtre glissante (pending/approved) ----------------- */
  const loadMyMonthUpcomingAbs = async () => {
    if (!session?.user?.id) return;
    const { data } = await supabase
      .from("absences")
      .select("id, date, status, admin_forced")
      .eq("seller_id", session.user.id)
      .in("status", ["approved", "pending"])
      .gte("date", todayIso)
      .lte("date", rangeTo)
      .order("date", { ascending: true });

    const byDate = {};
    (data || []).forEach((r) => {
      if (!byDate[r.date]) byDate[r.date] = { ids: [], approved: false, pending: false, locked: false };
      byDate[r.date].ids.push(r.id);
      if (r.status === 'approved') byDate[r.date].approved = true;
      if (r.status === 'pending')  byDate[r.date].pending  = true;
      if (r.admin_forced)          byDate[r.date].locked   = true;
    });
    const arr = Object.keys(byDate)
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({
        date,
        ids: byDate[date].ids,
        status: byDate[date].approved ? 'approved' : 'pending',
        locked: byDate[date].locked,
      }));
    setMyMonthUpcomingAbs(arr);
  };

  /* ----------------- Remplacements ACCEPTÉS pour MES absences ----------------- */
  const reloadAccepted = async () => {
    if (!session?.user?.id) return;
    const { data: rows, error } = await supabase
      .from('replacement_interest')
      .select('id, status, volunteer_id, accepted_shift_code, absence_id, absences(id, seller_id, date)')
      .eq('status', 'accepted')
      .eq('absences.seller_id', session.user.id)
      .order('id', { ascending: true });
    if (error) { setAcceptedByAbsence({}); return; }

    const volunteerIds = Array.from(new Set((rows || []).map(r => r.volunteer_id).filter(Boolean)));
    let vnames = {};
    if (volunteerIds.length) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .in('user_id', volunteerIds);
      (profs || []).forEach(p => { vnames[p.user_id] = p.full_name; });
    }
    const map = {};
    (rows || []).forEach(r => {
      map[r.absence_id] = {
        volunteer_id: r.volunteer_id,
        volunteer_name: vnames[r.volunteer_id] || '—',
        shift: r.accepted_shift_code || null,
      };
    });
    setAcceptedByAbsence(map);
  };

  /* ----------------- Mes remplacements à venir (je suis la volontaire acceptée) ----------------- */
  const loadMyUpcomingRepl = useCallback(async () => {
    if (!session?.user?.id) return;

    // 1) Mes remplacements acceptés → récupère les absence_id
    const { data: riRows, error: e1 } = await supabase
      .from("replacement_interest")
      .select("absence_id, accepted_shift_code")
      .eq("volunteer_id", session.user.id)
      .eq("status", "accepted");
    if (e1) { console.error(e1); setMyUpcomingRepl([]); return; }

    const ids = Array.from(new Set((riRows || []).map(r => r.absence_id).filter(Boolean)));
    if (ids.length === 0) { setMyUpcomingRepl([]); return; }

    // 2) On lit les absences correspondantes
    const { data: absRows, error: e2 } = await supabase
      .from("absences")
      .select("id, seller_id, date")
      .in("id", ids);

    if (e2) { console.error(e2); setMyUpcomingRepl([]); return; }

    // 3) Join en mémoire pour reconstruire la liste
    const byId = new Map((riRows || []).map(r => [r.absence_id, r.accepted_shift_code || null]));
    const list = (absRows || []).map(a => ({
      absence_id: a.id,
      date: a.date,
      absent_id: a.seller_id,
      accepted_shift_code: byId.get(a.id) || null,
    }));

    setMyUpcomingRepl(list);
  }, [session?.user?.id]);

  useEffect(() => {
    loadMyMonthAbs();
    loadMyMonthUpcomingAbs();
    reloadAccepted();
    loadMyUpcomingRepl();
  }, [session?.user?.id, myMonthFromPast, myMonthToPast, loadMyUpcomingRepl]);

  /* ----------------- ANNULER une absence (direct, sans admin) ----------------- */
  const deleteMyAbsencesForDate = async (date) => {
    if (!window.confirm(`Annuler votre absence du ${frDate(date)} ?`)) return;

    // 🔒 Garde-fou : si l’une des entrées de cette date est admin_forced, on bloque
    const { data: rows } = await supabase
      .from("absences")
      .select("id, admin_forced")
      .eq("seller_id", session?.user?.id)
      .eq("date", date);

    if ((rows || []).some(r => r.admin_forced)) {
      alert("Cette absence a été enregistrée par l’admin et ne peut pas être annulée.");
      return;
    }

    const { data: { session: s} } = await supabase.auth.getSession();
    const resp = await fetch('/api/absences/delete-by-date', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s?.access_token||''}` },
      body: JSON.stringify({ date })
    });
    const json = await resp.json().catch(()=>({}));
    if (!resp.ok || !json.ok) { alert(`Échec de l’annulation: ${json.error || resp.statusText}`); return; }
    await Promise.all([loadMyMonthUpcomingAbs?.(), reloadAccepted?.(), loadMyUpcomingRepl?.()]);
    alert('Absence annulée.');
  };

  // Réveil / retour au premier plan (inclut iOS PWA)
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === 'visible') {
        loadMyMonthAbs();
        loadMyMonthUpcomingAbs();
        reloadAccepted();
        loadMyUpcomingRepl();
      }
    };
    window.addEventListener('focus', onWake);
    window.addEventListener('pageshow', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      window.removeEventListener('pageshow', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, []);

  // Push SW → rafraîchir sur message
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (e) => {
      if (e?.data?.type === 'push') {
        loadMyMonthAbs();
        loadMyMonthUpcomingAbs();
        reloadAccepted();
        loadMyUpcomingRepl();
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);

  // --- ÉTATS GÉNÉRAUX D'ACCÈS ---
  if (loading) return <div className="p-4">Chargement…</div>;
  if (!session) return <div className="p-4">Connexion requise…</div>;

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Bonjour {displayName}</div>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Se déconnecter</button>
      </div>

      {/* 🟥 Bannière “Absente aujourd’hui” (pour la vendeuse connectée) */}
      {absentToday && (
        <div className="border rounded-2xl p-3 flex flex-col gap-2"
             style={{ backgroundColor: absentToday.status === 'approved' ? "#fee2e2" : "#fff7ed", borderColor: "#fca5a5" }}>
          <div className="font-medium">Absente aujourd’hui — {frDate(absentToday.date)}</div>
          <div className="text-sm">
            {absentToday.status === 'approved' ? "Absence approuvée par l’administrateur." : "Demande d’absence en attente d’approbation."}
            {absentToday.accepted ? (
              <> Remplacée par <b>{absentToday.accepted.volunteer_name}</b>
              {absentToday.acceptedShift ? <> (<span className="text-xs px-2 py-1 rounded-full" style={{ background: "#f3f4f6" }}>{labelForShift(absentToday.acceptedShift)}</span>)</> : null}
              </>
            ) : <> — Aucun remplaçant validé pour le moment.</>}
          </div>
          <div className="flex gap-2">
            <button
              className="btn"
              disabled={absentToday.locked}
              onClick={() => deleteMyAbsencesForDate(todayIso)}
              title={absentToday.locked ? "Absence verrouillée par l’admin" : `Annuler l'absence du ${frDate(todayIso)}`}
              style={{ backgroundColor: absentToday.locked ? "#9ca3af" : "#dc2626", color: "#fff", borderColor: "transparent" }}
            >
              Annuler l'absence d'aujourd'hui
            </button>
          </div>
        </div>
      )}

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

      {/* Bannière “Validé” — volontaire */}
      {approvalMsg && (
        <div className="border rounded-2xl p-3 flex items-start sm:items-center justify-between gap-2"
             style={{ backgroundColor: "#ecfccb", borderColor: "#a3e635" }}>
          <div className="text-sm">
            ✅ Votre remplacement pour <span className="font-medium">{approvalMsg.absent_name}</span> le{" "}
            <span className="font-medium">{approvalMsg.date}</span> a été <span className="font-medium">validé</span>.
          </div>
          <button className="btn"
                  onClick={async () => {
                    try {
                      if (approvalMsg?.absence_id) {
                        const { error } = await supabase.rpc("acknowledge_replacement", { p_absence_id: approvalMsg.absence_id });
                        if (error) console.warn("acknowledge_replacement failed, fallback to localStorage", error);
                        localStorage.setItem(`ri_seen_${approvalMsg.absence_id}`, "1");
                      }
                    } finally {
                      setApprovalMsg(null);
                      await loadMyUpcomingRepl();
                    }
                  }}
                  style={{ backgroundColor: "#15803d", color: "#fff", borderColor: "transparent" }}>
            OK
          </button>
        </div>
      )}

      {/* 🟨 Bannière persistante : mes remplacements à venir */}
      {myUpcomingRepl.length > 0 && (
        <div className="border rounded-2xl p-3"
             style={{ backgroundColor: "#fff7ed", borderColor: "#fdba74" }}>
          <div className="font-medium mb-2">Rappels — remplacements à venir</div>
          <ul className="list-disc pl-6 space-y-1 text-sm">
            {myUpcomingRepl.map((r) => (
              <li key={r.absence_id}>
                Tu remplaces <b>{names[r.absent_id] || "Vendeuse"}</b> le <b>{r.date}</b>
                {r.accepted_shift_code ? <> — <span className="text-xs px-2 py-1 rounded-full" style={{ background: "#f3f4f6" }}>{labelForShift(r.accepted_shift_code)}</span></> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Planning de la semaine */}
      <WeekView days={days} assign={assign} todayIso={todayIso} names={names} />

      {/* CONGÉS APPROUVÉS */}
      <div className="card">
        <div className="hdr mb-2">Congés approuvés — en cours ou à venir</div>
        {approvedLeaves.length === 0 ? (
          <div className="text-sm text-gray-600">Aucun congé approuvé à venir.</div>
        ) : (
          <ul className="space-y-2">
            {approvedLeaves.map((l) => {
              const tIso = fmtISODate(new Date());
              const tag = betweenIso(tIso, l.start_date, l.end_date) ? "En cours" : "À venir";
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

      {/* VOS ABSENCES (passées) */}
      <div className="card">
        <div className="hdr mb-2">Vos absences ce mois</div>
        {myMonthAbs.length === 0 ? (
          <div className="text-sm text-gray-600">
            Vous n&#39;avez aucune absence approuvée passée (ou aujourd&#39;hui) ce mois-ci.
          </div>
        ) : (
          <div className="text-sm">
            {(() => {
              const list = myMonthAbs.map(frDate);
              const sentence = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`;
              return <>Vous avez <span className="font-medium">{myMonthAbs.length}</span> jour(s) d&#39;absence ce mois-ci : {sentence}.</>;
            })()}
          </div>
        )}
      </div>

      {/* VOS ABSENCES À VENIR (texte + badge + bouton d’annulation direct) */}
      <div className="card">
        <div className="hdr mb-2">Vos absences à venir</div>
        {myMonthUpcomingAbs.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune absence à venir.</div>
        ) : (
          <ul className="space-y-2">
            {myMonthUpcomingAbs.map(({ date, ids, status, locked }) => {
              let accepted;
              let acceptedShift = null;
              for (const id of ids) {
                if (acceptedByAbsence[id]) {
                  accepted = acceptedByAbsence[id];
                  acceptedShift = acceptedByAbsence[id].shift || null;
                  break;
                }
              }

              return (
                <li key={date} className="flex flex-col sm:flex-row sm:items-center sm:justify-between border rounded-2xl p-3 gap-2">
                  <div className="text-sm">
                    <b>{frDate(date)}</b>
                    {accepted ? (
                      <> — <b>{accepted.volunteer_name}</b> remplace <b>{displayName || "vous"}</b>
                        {acceptedShift ? <> (<span className="text-xs px-2 py-1 rounded-full" style={{ background: "#f3f4f6" }}>{labelForShift(acceptedShift)}</span>)</> : null}
                      </>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-2">
                      {status === 'approved' ? (
                        <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: '#16a34a' }}>
                          Absence approuvée par l’administrateur
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: '#f3f4f6', color: '#374151' }}>
                          En attente d’approbation
                        </span>
                      )}
                      {locked && (
                        <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: '#f3f4f6', color: '#374151' }}>
                          Définie par l’admin
                        </span>
                      )}
                    </div>
                  </div>

                  {locked ? (
                    <button
                      className="btn"
                      disabled
                      title="Absence verrouillée par l’admin"
                      style={{ backgroundColor: "#9ca3af", color: "#fff", borderColor: "transparent" }}
                    >
                      Annuler l'absence
                    </button>
                  ) : (
                    <button
                      className="btn"
                      onClick={() => deleteMyAbsencesForDate(date)}
                      title={`Annuler l'absence du ${frDate(date)}`}
                      style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}
                    >
                      Annuler l'absence
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Demander une absence (1 jour) */}
      <div className="card">
        <div className="hdr mb-2">Demander une absence (1 jour)</div>
        <div className="grid md:grid-cols-3 gap-3 items-end">
          <div>
            <div className="text-sm mb-1">Date</div>
            <input
              type="date"
              className="input"
              value={absDate}
              min={todayIso}                 /* ⬅️ bloque les dates passées */
              onChange={(e) => setAbsDate(e.target.value)}
            />
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
        <LeaveRequestForm /> {/* ✅ dates passées bloquées + fin ≥ début */}
      </div>
    </div>
  );

  /* --- composant interne pour la semaine (lecture seule) --- */
  function WeekView({ days, assign, todayIso, names }) {
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
            const isToday = iso === todayIso; // ✅ contour pour tout le jour courant
            return (
              <div
                key={iso}
                className="border rounded-2xl p-3 space-y-3"
                style={isToday ? { borderColor: "#1976d2", boxShadow: "0 0 0 3px rgba(25,118,210,0.15)" } : {}}
              >
                <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                <div className="font-semibold">{iso}</div>
                {["MORNING", "MIDDAY", ...(sunday ? ["SUNDAY_EXTRA"] : []), "EVENING"].map((code) => {
                  const label = SHIFT_LABELS[code];
                  const rec = assign[`${iso}|${code}`];
                  const assigned = rec?.seller_id;

                  // ⚠️ Dans certains setups RLS, `view_week_assignments.full_name` peut arriver vide côté vendeuse.
                  // On retombe alors sur notre cache `names[user_id]`.
                  const raw = rec?.full_name;
                  const name = (!isNamePlaceholder(raw) ? raw : (assigned ? (names?.[assigned] || "") : ""));
                  const shownName = assigned ? (name || "Vendeuse") : "—";

                  const bg = assigned ? colorForSeller(assigned, name || shownName) : "#f3f4f6";
                  const fg = assigned ? "#fff" : "#6b7280";
                  const border = assigned ? "transparent" : "#e5e7eb";
                  return (
                    <div key={code} className="rounded-2xl p-3" style={{ backgroundColor: bg, color: fg, border: `1px solid ${border}` }}>
                      <div className="text-sm">{label}</div>
                      <div className="mt-1 text-sm">{shownName}</div>
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
