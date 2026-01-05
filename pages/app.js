/* eslint-disable react/no-unescaped-entities */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import WeekNav from "@/components/WeekNav";
import LeaveRequestForm from "@/components/LeaveRequestForm";
import { notifyAdminsNewAbsence } from "@/lib/pushNotify";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "@/lib/date";

/* Libellés + créneau dimanche */
const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9h-13h30" };

/* Couleurs stables */
const SELLER_COLOR_OVERRIDES = {
  antonia: "#e57373",
  olivia: "#64b5f6",
  colleen: "#81c784",
  ibtissam: "#ba68c8",
  charlene: "#f59e0b",
};

const normalize = (s) => String(s || "").trim().toLowerCase();
const isSunday = (d) => d.getDay() === 0;
const weekdayFR = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function isNamePlaceholder(name) {
  const n = String(name || "").trim();
  return !n || n === "-" || n === "—";
}
function hashStr(str) {
  let h = 2166136261;
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
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function autoColorFromName(name) {
  const key = normalize(name);
  const hue = hashStr(key) % 360;
  return hslToHex(hue, 65, 50);
}
function colorForSeller(sellerId, name) {
  const ovr = SELLER_COLOR_OVERRIDES[normalize(name)];
  if (ovr) return ovr;
  const key = isNamePlaceholder(name) ? String(sellerId || "unknown") : String(name);
  return autoColorFromName(key);
}
function frDate(iso) {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR");
  } catch {
    return iso;
  }
}
function firstDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function lastDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function betweenIso(iso, start, end) {
  return iso >= start && iso <= end;
}
function labelForShift(code) {
  switch (code) {
    case "MORNING":
      return "Matin (6h30-13h30)";
    case "MIDDAY":
      return "Midi (7h-13h)";
    case "SUNDAY_EXTRA":
      return "Dimanche 9h-13h30";
    case "EVENING":
      return "Soir (13h30-20h30)";
    default:
      return code || "—";
  }
}

async function rpcUpsertShift({ date, code, sellerId }) {
  // 1) tente planner_upsert_shift
  const r1 = await supabase.rpc("planner_upsert_shift", {
    p_date: date,
    p_code: code,
    p_seller: sellerId || null,
  });
  if (!r1?.error) return r1;

  // 2) si fonction inexistante, fallback admin_upsert_shift
  const msg = String(r1.error?.message || "");
  const codeErr = String(r1.error?.code || "");
  const missingFn = codeErr === "42883" || msg.toLowerCase().includes("does not exist");
  if (!missingFn) return r1;

  return supabase.rpc("admin_upsert_shift", {
    p_date: date,
    p_code: code,
    p_seller: sellerId || null,
  });
}

export default function AppSeller() {
  const r = useRouter();
  const { session: hookSession, profile: hookProfile, loading: hookLoading } = useAuth();

  // Session source de vérité (évite le “je me déconnecte mais ça reste bizarre”)
  const [sbSession, setSbSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        setSbSession(data?.session ?? null);
      } finally {
        if (alive) setAuthChecked(true);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSbSession(s ?? null);
      setAuthChecked(true);
    });

    return () => {
      alive = false;
      try {
        sub?.subscription?.unsubscribe?.();
      } catch (_) {}
    };
  }, []);

  const session = sbSession ?? hookSession ?? null;
  const userId = session?.user?.id || null;
  const userEmail = session?.user?.email || null;

  // Fallback profil direct
  const [profileFallback, setProfileFallback] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) {
        if (alive) setProfileFallback(null);
        return;
      }
      if (hookProfile?.user_id === userId) return;

      try {
        const { data } = await supabase
          .from("profiles")
          .select("user_id, full_name, role")
          .eq("user_id", userId)
          .maybeSingle();
        if (!alive) return;
        setProfileFallback(data || null);
      } catch (_) {
        // ignore
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, hookProfile]);

  const role = hookProfile?.role ?? profileFallback?.role ?? null;

  // ----------------------------
  // IMPORTANT: TOUS LES HOOKS EN HAUT (aucun return avant)
  // ----------------------------

  // ✅ lazy init pour éviter toute surprise et garder un init stable
  const [monday, setMonday] = useState(() => startOfWeek(new Date()));
  const days = useMemo(
    () => Array.from({ length: 7 }).map((_, i) => addDays(monday, i)),
    [monday]
  );

  const todayIso = useMemo(() => fmtISODate(new Date()), []);
  const rangeTo = useMemo(() => fmtISODate(addDays(new Date(), 60)), []);

  const [isPlanner, setIsPlanner] = useState(false);
  const [plannerChecked, setPlannerChecked] = useState(false);
  const [editPlanning, setEditPlanning] = useState(false);

  const [names, setNames] = useState({}); // { user_id: full_name }
  const [assign, setAssign] = useState({}); // { "YYYY-MM-DD|CODE": { seller_id, full_name } }
  const [todayPlan, setTodayPlan] = useState({}); // { CODE: { seller_id, full_name } }

  const [reasonAbs, setReasonAbs] = useState("");
  const [absDate, setAbsDate] = useState(todayIso);
  const [msgAbs, setMsgAbs] = useState("");

  // (gardés même si non utilisés, pour éviter de “bouger” ton fichier)
  const [replAsk, setReplAsk] = useState(null);
  const [approvalMsg, setApprovalMsg] = useState(null);

  const [approvedLeaves, setApprovedLeaves] = useState([]);

  const now = new Date();
  const myMonthFromPast = useMemo(() => fmtISODate(firstDayOfMonth(now)), []); // stable au chargement
  const myMonthToPast = useMemo(() => fmtISODate(lastDayOfMonth(now)), []); // stable au chargement
  const [myMonthAbs, setMyMonthAbs] = useState([]);

  const [myMonthUpcomingAbs, setMyMonthUpcomingAbs] = useState([]);
  const [acceptedByAbsence, setAcceptedByAbsence] = useState({});
  const [myUpcomingRepl, setMyUpcomingRepl] = useState([]);

  // Validation mensuelle (si RPC existent)
  const monthStartPrev = useMemo(() => {
    const n = new Date();
    const firstThis = new Date(n.getFullYear(), n.getMonth(), 1);
    const prev = new Date(firstThis);
    prev.setMonth(prev.getMonth() - 1);
    return fmtISODate(prev);
  }, []);
  const monthLabel = useMemo(() => {
    const d = new Date(monthStartPrev + "T00:00:00");
    return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }, [monthStartPrev]);

  const [monthlyRow, setMonthlyRow] = useState(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyErr, setMonthlyErr] = useState("");
  const [corrHours, setCorrHours] = useState("");
  const [corrNote, setCorrNote] = useState("");
  const [monthlyFlash, setMonthlyFlash] = useState("");
  const [monthlyUnsupported, setMonthlyUnsupported] = useState(false);

  const displayName =
    hookProfile?.full_name ||
    profileFallback?.full_name ||
    session?.user?.user_metadata?.full_name ||
    (userEmail ? userEmail.split("@")[0] : "—");

  // ----------------------------
  // Redirects (APRÈS hooks)
  // ----------------------------
  useEffect(() => {
    if (!authChecked && !hookLoading) return;

    // Pas connecté => /login (au lieu de rester bloqué sur "Connexion requise…")
    if (!userId && authChecked && !hookLoading) {
      if (typeof window !== "undefined") {
        window.location.replace("/login?stay=1&next=/app");
      }
      return;
    }

    // Admin => /admin
    if (userId && role === "admin") {
      r.replace("/admin");
    }
  }, [authChecked, hookLoading, userId, role, r]);

  // Planner access (table planner_access)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) {
        if (alive) {
          setIsPlanner(false);
          setPlannerChecked(true);
        }
        return;
      }
      try {
        const { data, error } = await supabase
          .from("planner_access")
          .select("user_id")
          .eq("user_id", userId)
          .maybeSingle();
        if (!alive) return;
        setIsPlanner(!error && !!data);
      } catch (_) {
        if (!alive) return;
        setIsPlanner(false);
      } finally {
        if (alive) setPlannerChecked(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  // Noms vendeuses: RPC list_active_seller_names() fallback profiles
  const loadSellerNames = useCallback(async () => {
    if (!userId) return;
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("list_active_seller_names");
      let rows = null;

      if (!rpcErr && Array.isArray(rpcData)) {
        rows = rpcData;
      } else {
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
      console.warn("[app] loadSellerNames failed:", e?.message || e);
    }
  }, [userId]);

  useEffect(() => {
    loadSellerNames();
  }, [loadSellerNames]);

  const sellerOptions = useMemo(() => {
    const entries = Object.entries(names || {}).map(([id, full_name]) => ({
      user_id: id,
      full_name: (full_name || "").trim(),
    }));

    const inPlanning = new Set();
    Object.values(assign || {}).forEach((rec) => {
      if (rec?.seller_id) inPlanning.add(rec.seller_id);
    });
    inPlanning.forEach((id) => {
      if (!entries.find((e) => e.user_id === id)) entries.push({ user_id: id, full_name: "" });
    });

    return entries.sort((a, b) => (a.full_name || a.user_id).localeCompare(b.full_name || b.user_id, "fr"));
  }, [names, assign]);

  // Planning semaine (view fallback shifts)
  const loadWeekPlanning = useCallback(async () => {
    if (!userId) return;
    const from = fmtISODate(days[0]);
    const to = fmtISODate(days[6]);

    const { data: vw, error: e1 } = await supabase
      .from("view_week_assignments")
      .select("date, shift_code, seller_id, full_name")
      .gte("date", from)
      .lte("date", to);

    if (!e1 && Array.isArray(vw) && vw.length > 0) {
      const next = {};
      vw.forEach((row) => {
        next[`${row.date}|${row.shift_code}`] = {
          seller_id: row.seller_id,
          full_name: row.full_name || null,
        };
      });
      setAssign(next);
      return;
    }

    const { data: sh, error: e2 } = await supabase
      .from("shifts")
      .select("date, shift_code, seller_id")
      .gte("date", from)
      .lte("date", to);

    if (e2) {
      console.error("[app] loadWeekPlanning shifts error:", e2);
      return;
    }

    const next = {};
    (sh || []).forEach((row) => {
      next[`${row.date}|${row.shift_code}`] = { seller_id: row.seller_id, full_name: null };
    });
    setAssign(next);
  }, [userId, days]);

  useEffect(() => {
    loadWeekPlanning();
  }, [monday, loadWeekPlanning]);

  // Planning du jour
  const loadTodayPlan = useCallback(async () => {
    if (!userId) return;

    const { data: vw, error: e1 } = await supabase
      .from("view_week_assignments")
      .select("date, shift_code, seller_id, full_name")
      .eq("date", todayIso);

    if (!e1 && Array.isArray(vw) && vw.length > 0) {
      const next = {};
      vw.forEach((row) => {
        next[row.shift_code] = { seller_id: row.seller_id, full_name: row.full_name || null };
      });
      setTodayPlan(next);
      return;
    }

    const { data: sh, error: e2 } = await supabase
      .from("shifts")
      .select("shift_code, seller_id")
      .eq("date", todayIso);

    if (e2) {
      console.error("[app] loadTodayPlan shifts error:", e2);
      return;
    }

    const next = {};
    (sh || []).forEach((row) => {
      next[row.shift_code] = { seller_id: row.seller_id, full_name: null };
    });
    setTodayPlan(next);
  }, [userId, todayIso]);

  useEffect(() => {
    loadTodayPlan();
  }, [loadTodayPlan]);

  // Realtime shifts
  useEffect(() => {
    if (!userId) return;
    const ch = supabase
      .channel("shifts_rt_app")
      .on("postgres_changes", { event: "*", schema: "public", table: "shifts" }, async () => {
        await loadWeekPlanning();
        await loadTodayPlan();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, loadWeekPlanning, loadTodayPlan]);

  // Edition planning (planner uniquement)
  const saveShift = useCallback(
    async (iso, code, seller_id) => {
      if (!isPlanner) return;

      const key = `${iso}|${code}`;
      const resolvedName = seller_id ? names?.[seller_id] || null : null;

      setAssign((prev) => ({
        ...prev,
        [key]: { seller_id: seller_id || null, full_name: resolvedName },
      }));

      const { error } = await rpcUpsertShift({ date: iso, code, sellerId: seller_id || null });
      if (error) {
        console.error("[app] upsert shift error:", error);
        alert(error.message || "Échec sauvegarde planning");
        await loadWeekPlanning();
        await loadTodayPlan();
        return;
      }

      await loadWeekPlanning();
      await loadTodayPlan();
    },
    [isPlanner, names, loadWeekPlanning, loadTodayPlan]
  );

  // Absence demande
  const submitAbs = async () => {
    if (!userId) return;
    setMsgAbs("");

    const { error } = await supabase.from("absences").insert({
      date: absDate,
      seller_id: userId,
      reason: reasonAbs || null,
      status: "pending",
    });

    if (error) {
      console.error(error);
      setMsgAbs("Échec d'envoi de la demande.");
      return;
    }

    const sellerName =
      session?.user?.user_metadata?.full_name ||
      (userEmail ? userEmail.split("@")[0] : "Vendeuse");

    try {
      await notifyAdminsNewAbsence({ sellerName, startDate: absDate, endDate: absDate });
    } catch (_) {}

    setMsgAbs("Demande d'absence envoyée. En attente de validation.");
    setReasonAbs("");
  };

  // Mes absences (passées ce mois)
  const loadMyMonthAbs = useCallback(async () => {
    if (!userId) return;
    const tIso = fmtISODate(new Date());
    const { data } = await supabase
      .from("absences")
      .select("date")
      .eq("seller_id", userId)
      .eq("status", "approved")
      .gte("date", myMonthFromPast)
      .lte("date", myMonthToPast)
      .lt("date", tIso);

    const arr = Array.from(new Set((data || []).map((r) => r.date))).sort((a, b) => a.localeCompare(b));
    setMyMonthAbs(arr);
  }, [userId, myMonthFromPast, myMonthToPast]);

  // Mes absences à venir (jusqu’à +60j)
  const loadMyMonthUpcomingAbs = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from("absences")
      .select("id, date, status, admin_forced")
      .eq("seller_id", userId)
      .in("status", ["approved", "pending"])
      .gte("date", todayIso)
      .lte("date", rangeTo)
      .order("date", { ascending: true });

    const byDate = {};
    (data || []).forEach((r2) => {
      if (!byDate[r2.date]) byDate[r2.date] = { ids: [], approved: false, pending: false, locked: false };
      byDate[r2.date].ids.push(r2.id);
      if (r2.status === "approved") byDate[r2.date].approved = true;
      if (r2.status === "pending") byDate[r2.date].pending = true;
      if (r2.admin_forced) byDate[r2.date].locked = true;
    });

    const arr = Object.keys(byDate)
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({
        date,
        ids: byDate[date].ids,
        status: byDate[date].approved ? "approved" : "pending",
        locked: byDate[date].locked,
      }));

    setMyMonthUpcomingAbs(arr);
  }, [userId, todayIso, rangeTo]);

  // Remplacements acceptés pour mes absences
  const reloadAccepted = useCallback(async () => {
    if (!userId) return;

    const { data: rows, error } = await supabase
      .from("replacement_interest")
      .select("id, status, volunteer_id, accepted_shift_code, absence_id, absences(id, seller_id, date)")
      .eq("status", "accepted")
      .eq("absences.seller_id", userId)
      .order("id", { ascending: true });

    if (error) {
      setAcceptedByAbsence({});
      return;
    }

    const volunteerIds = Array.from(new Set((rows || []).map((r2) => r2.volunteer_id).filter(Boolean)));
    let vnames = {};
    if (volunteerIds.length) {
      const { data: profs } = await supabase.from("profiles").select("user_id, full_name").in("user_id", volunteerIds);
      (profs || []).forEach((p) => (vnames[p.user_id] = p.full_name));
    }

    const map = {};
    (rows || []).forEach((r2) => {
      map[r2.absence_id] = {
        volunteer_id: r2.volunteer_id,
        volunteer_name: vnames[r2.volunteer_id] || "—",
        shift: r2.accepted_shift_code || null,
      };
    });
    setAcceptedByAbsence(map);
  }, [userId]);

  // Mes remplacements à venir (en tant que volontaire acceptée)
  const loadMyUpcomingRepl = useCallback(async () => {
    if (!userId) return;

    const { data: riRows, error: e1 } = await supabase
      .from("replacement_interest")
      .select("absence_id, accepted_shift_code")
      .eq("volunteer_id", userId)
      .eq("status", "accepted");

    if (e1) {
      setMyUpcomingRepl([]);
      return;
    }

    const ids = Array.from(new Set((riRows || []).map((x) => x.absence_id).filter(Boolean)));
    if (ids.length === 0) {
      setMyUpcomingRepl([]);
      return;
    }

    const { data: absRows, error: e2 } = await supabase.from("absences").select("id, seller_id, date").in("id", ids);
    if (e2) {
      setMyUpcomingRepl([]);
      return;
    }

    const byId = new Map((riRows || []).map((x) => [x.absence_id, x.accepted_shift_code || null]));
    setMyUpcomingRepl(
      (absRows || []).map((a) => ({
        absence_id: a.id,
        date: a.date,
        absent_id: a.seller_id,
        accepted_shift_code: byId.get(a.id) || null,
      }))
    );
  }, [userId]);

  useEffect(() => {
    loadMyMonthAbs();
    loadMyMonthUpcomingAbs();
    reloadAccepted();
    loadMyUpcomingRepl();
  }, [loadMyMonthAbs, loadMyMonthUpcomingAbs, reloadAccepted, loadMyUpcomingRepl]);

  // Congés approuvés
  const loadApprovedLeaves = useCallback(async () => {
    if (!userId) return;
    const tIso = fmtISODate(new Date());
    const { data } = await supabase
      .from("leaves")
      .select("id, seller_id, start_date, end_date, status")
      .eq("status", "approved")
      .gte("end_date", tIso)
      .order("start_date", { ascending: true });

    if (!data) {
      setApprovedLeaves([]);
      return;
    }

    const ids = Array.from(new Set(data.map((l) => l.seller_id)));
    let namesMap = {};
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
      (profs || []).forEach((p) => (namesMap[p.user_id] = p.full_name));
    }

    setApprovedLeaves(data.map((l) => ({ ...l, seller_name: namesMap[l.seller_id] || "—" })));
  }, [userId]);

  useEffect(() => {
    loadApprovedLeaves();
  }, [loadApprovedLeaves]);

  // Validation mensuelle (si RPC existent)
  const ensureMonthlyRow = useCallback(async () => {
    if (!userId || monthlyUnsupported) return;
    setMonthlyErr("");
    setMonthlyLoading(true);
    try {
      const { data, error } = await supabase.rpc("ensure_monthly_hours_row", { p_month_start: monthStartPrev });
      if (error) {
        const msg = String(error?.message || "");
        const codeE = String(error?.code || "");
        const missingFn = codeE === "42883" || msg.toLowerCase().includes("does not exist");
        if (missingFn) {
          setMonthlyUnsupported(true);
          setMonthlyRow(null);
          return;
        }
        throw error;
      }
      setMonthlyRow(data || null);
      if (data?.seller_status === "disputed") setCorrHours(String(data?.seller_correction_hours ?? ""));
      if (data?.seller_comment) setCorrNote(data.seller_comment);
    } catch (e) {
      setMonthlyErr(e?.message || "Impossible de charger la validation mensuelle.");
    } finally {
      setMonthlyLoading(false);
    }
  }, [userId, monthStartPrev, monthlyUnsupported]);

  useEffect(() => {
    ensureMonthlyRow();
  }, [ensureMonthlyRow]);

  const sellerAcceptMonthly = useCallback(async () => {
    if (!userId || monthlyUnsupported) return;
    setMonthlyErr("");
    const { data, error } = await supabase.rpc("seller_monthly_hours_submit", {
      p_month_start: monthStartPrev,
      p_mode: "accept",
      p_corrected: null,
      p_comment: null,
    });
    if (error) {
      setMonthlyErr(error.message || "Échec de validation");
      return;
    }
    setMonthlyRow(data || null);
  }, [userId, monthStartPrev, monthlyUnsupported]);

  const sellerCorrectMonthly = useCallback(async () => {
    if (!userId || monthlyUnsupported) return;
    setMonthlyErr("");
    const val = Number(String(corrHours || "").replace(",", "."));
    if (!Number.isFinite(val) || val <= 0) {
      setMonthlyErr("Indique un total d'heures valide (ex: 151.5).");
      return;
    }
    const { data, error } = await supabase.rpc("seller_monthly_hours_submit", {
      p_month_start: monthStartPrev,
      p_mode: "correct",
      p_corrected: val,
      p_comment: (corrNote || "").trim() || null,
    });
    if (error) {
      setMonthlyErr(error.message || "Échec d'envoi de correction");
      return;
    }
    setMonthlyRow(data || null);
  }, [userId, monthStartPrev, corrHours, corrNote, monthlyUnsupported]);

  const absentToday = useMemo(() => {
    const entry = (myMonthUpcomingAbs || []).find((a) => a.date === todayIso);
    if (!entry) return null;
    let accepted = null;
    let acceptedShift = null;
    for (const id of entry.ids) {
      if (acceptedByAbsence[id]) {
        accepted = acceptedByAbsence[id];
        acceptedShift = acceptedByAbsence[id].shift || null;
        break;
      }
    }
    return { date: todayIso, status: entry.status, locked: !!entry.locked, accepted, acceptedShift };
  }, [myMonthUpcomingAbs, acceptedByAbsence, todayIso]);

  // ----------------------------
  // UI (après hooks)
  // ----------------------------
  const showLoading = hookLoading || !authChecked || !plannerChecked;
  const showNeedAuth = !userId && authChecked && !hookLoading;

  if (showLoading) {
    return <div className="p-4">Chargement…</div>;
  }

  if (showNeedAuth) {
    return (
      <div className="p-4 space-y-3">
        <div>Connexion requise…</div>
        <button className="btn" onClick={() => (window.location.href = "/login?stay=1&next=/app")}>
          Aller à /login
        </button>
        <button className="btn" onClick={() => (window.location.href = "/logout")}>
          Déconnexion hard (/logout)
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Bonjour {displayName}</div>
        <div className="flex items-center gap-2">
          {isPlanner && (
            <button className="btn" onClick={() => setEditPlanning((v) => !v)}>
              {editPlanning ? "Mode planning: ON" : "Modifier le planning"}
            </button>
          )}
          <button className="btn" onClick={() => (window.location.href = "/logout")}>
            Se déconnecter
          </button>
        </div>
      </div>

      {!monthlyUnsupported && (monthlyLoading || monthlyRow) && (
        <div className="card">
          <div className="hdr mb-2">Validation des heures - {capFirst(monthLabel)}</div>

          {monthlyFlash && (
            <div className="text-sm mb-2 border rounded-xl p-2" style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}>
              {monthlyFlash}
            </div>
          )}

          {monthlyErr && (
            <div className="text-sm mb-2 border rounded-xl p-2" style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}>
              {monthlyErr}
            </div>
          )}

          {monthlyLoading && <div className="text-sm text-gray-600">Chargement…</div>}

          {!monthlyLoading && monthlyRow && (
            <>
              <div className="text-sm">
                Total calculé sur le planning :{" "}
                <span className="font-semibold">{Number(monthlyRow.computed_hours || 0).toFixed(2)} h</span>
              </div>

              {monthlyRow.seller_status === "pending" && (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <button className="btn" onClick={sellerAcceptMonthly} style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}>
                      Valider
                    </button>
                    <div className="text-xs text-gray-500">
                      Si tu as échangé des créneaux sans que le planning ait été mis à jour, tu peux corriger ton total.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input className="input" value={corrHours} onChange={(e) => setCorrHours(e.target.value)} placeholder="Heures corrigées (ex: 151.5)" inputMode="decimal" />
                    <input className="input" value={corrNote} onChange={(e) => setCorrNote(e.target.value)} placeholder="Commentaire (optionnel)" />
                    <button className="btn" onClick={sellerCorrectMonthly} style={{ backgroundColor: "#111827", color: "#fff", borderColor: "transparent" }}>
                      Envoyer correction
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="card">
        <div className="hdr mb-2">Planning du jour - {todayIso}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {(() => {
            const d = new Date(todayIso + "T00:00:00");
            const codes = ["MORNING", "MIDDAY", ...(d.getDay() === 0 ? ["SUNDAY_EXTRA"] : []), "EVENING"];
            return codes.map((code) => {
              const rec = todayPlan?.[code] || {};
              const assigned = rec?.seller_id || null;
              const raw = rec?.full_name;
              const name = !isNamePlaceholder(raw) ? raw : assigned ? names?.[assigned] || "" : "";
              const shownName = assigned ? name || "Vendeuse" : "—";

              const bg = assigned ? colorForSeller(assigned, shownName) : "#f3f4f6";
              const fg = assigned ? "#fff" : "#6b7280";
              const border = assigned ? "transparent" : "#e5e7eb";

              return (
                <div key={code} className="rounded-2xl p-3" style={{ backgroundColor: bg, color: fg, border: `1px solid ${border}` }}>
                  <div className="text-sm">{SHIFT_LABELS[code] || code}</div>
                  <div className="mt-1 text-sm">{shownName}</div>

                  {isPlanner && editPlanning && (
                    <div className="mt-3">
                      <select className="input" value={assigned || ""} onChange={(e) => saveShift(todayIso, code, e.target.value || null)}>
                        <option value="">— (aucune)</option>
                        {sellerOptions.map((s) => (
                          <option key={s.user_id} value={s.user_id}>
                            {s.full_name || s.user_id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      </div>

      {absentToday && (
        <div className="border rounded-2xl p-3 flex flex-col gap-2" style={{ backgroundColor: absentToday.status === "approved" ? "#fee2e2" : "#fff7ed", borderColor: "#fca5a5" }}>
          <div className="font-medium">Absente aujourd’hui - {frDate(absentToday.date)}</div>
          <div className="text-sm">
            {absentToday.status === "approved" ? "Absence approuvée par l’administrateur." : "Demande d’absence en attente d’approbation."}
            {absentToday.accepted ? (
              <>
                {" "}
                Remplacée par <b>{absentToday.accepted.volunteer_name}</b>
                {absentToday.acceptedShift ? (
                  <>
                    {" "}
                    (
                    <span className="text-xs px-2 py-1 rounded-full" style={{ background: "#f3f4f6" }}>
                      {labelForShift(absentToday.acceptedShift)}
                    </span>
                    )
                  </>
                ) : null}
              </>
            ) : (
              <> — Aucun remplaçant validé pour le moment.</>
            )}
          </div>
        </div>
      )}

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
            const isToday = iso === todayIso;

            return (
              <div key={iso} className="border rounded-2xl p-3 space-y-3" style={{ borderWidth: isToday ? 2 : 1, borderColor: isToday ? "#2563eb" : "#e5e7eb" }}>
                <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                <div className="font-semibold">{iso}</div>

                {["MORNING", "MIDDAY", ...(sunday ? ["SUNDAY_EXTRA"] : []), "EVENING"].map((code) => {
                  const key = `${iso}|${code}`;
                  const rec = assign?.[key];
                  const assigned = rec?.seller_id || "";

                  const raw = rec?.full_name;
                  const name = !isNamePlaceholder(raw) ? raw : assigned ? names?.[assigned] || "" : "";
                  const shownName = assigned ? name || "Vendeuse" : "—";

                  const bg = assigned ? colorForSeller(assigned, name || shownName) : "#f3f4f6";
                  const fg = assigned ? "#fff" : "#6b7280";
                  const border = assigned ? "transparent" : "#e5e7eb";

                  return (
                    <div key={code} className="rounded-2xl p-3" style={{ backgroundColor: bg, color: fg, border: `1px solid ${border}` }}>
                      <div className="text-sm font-medium">{SHIFT_LABELS[code] || code}</div>
                      <div className="mt-1 text-sm">{shownName}</div>

                      {isPlanner && editPlanning && (
                        <div className="mt-3">
                          <select className="input" value={assigned} onChange={(e) => saveShift(iso, code, e.target.value || null)}>
                            <option value="">— (aucune)</option>
                            {sellerOptions.map((s) => (
                              <option key={s.user_id} value={s.user_id}>
                                {(s.full_name || names?.[s.user_id] || "").trim() || s.user_id.slice(0, 8)}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="hdr mb-2">Congés approuvés - en cours ou à venir</div>
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
                  <div className="text-sm">
                    <span className="font-medium">{l.seller_name}</span> - du {l.start_date} au {l.end_date}
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: tagBg }}>
                    {tag}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="hdr mb-2">Vos absences ce mois</div>
        {myMonthAbs.length === 0 ? (
          <div className="text-sm text-gray-600">Vous n'avez aucune absence approuvée passée (ou aujourd'hui) ce mois-ci.</div>
        ) : (
          <div className="text-sm">
            {(() => {
              const list = myMonthAbs.map(frDate);
              const sentence = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`;
              return (
                <>
                  Vous avez <span className="font-medium">{myMonthAbs.length}</span> jour(s) d'absence ce mois-ci : {sentence}.
                </>
              );
            })()}
          </div>
        )}
      </div>

      <div className="card">
        <div className="hdr mb-2">Demander une absence (1 jour)</div>
        <div className="grid md:grid-cols-3 gap-3 items-end">
          <div>
            <div className="text-sm mb-1">Date</div>
            <input type="date" className="input" value={absDate} min={todayIso} onChange={(e) => setAbsDate(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <div className="text-sm mb-1">Motif (optionnel)</div>
            <input type="text" className="input" placeholder="ex: RDV médical" value={reasonAbs} onChange={(e) => setReasonAbs(e.target.value)} />
          </div>
          <div>
            <button className="btn" onClick={submitAbs}>
              Envoyer la demande
            </button>
          </div>
        </div>
        {msgAbs && <div className="text-sm mt-2">{msgAbs}</div>}
      </div>

      <div className="card">
        <div className="hdr mb-2">Demander un congé (période)</div>
        <LeaveRequestForm />
      </div>
    </div>
  );
}
