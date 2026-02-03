/* eslint-disable react/no-unescaped-entities */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import WeekNav from "@/components/WeekNav";
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
      return "Midi (6h30-13h30)";
    case "SUNDAY_EXTRA":
      return "Dimanche 9h-13h30";
    case "EVENING":
      return "Soir (13h30-20h30)";
    default:
      return code || "—";
  }
}

function fmtMinutesHM(mins) {
  const n = Number(mins || 0);
  if (!Number.isFinite(n) || n === 0) return "0min";
  const m = Math.round(Math.abs(n));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h <= 0) return `${r}min`;
  return `${h}h${String(r).padStart(2, "0")}`;
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
  const { session: hookSession, profile: hookProfile } = useAuth();

  // Session source de vérité (évite le "je me déconnecte mais ça reste bizarre")
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


// Garde-fou "token invalide / session expirée"
const [sessionExpired, setSessionExpired] = useState(false);
const [sessionExpiredMsg, setSessionExpiredMsg] = useState("");

const markSessionExpired = useCallback(async (msg) => {
  setSessionExpired(true);
  setSessionExpiredMsg(msg || "Session expirée. Veuillez vous reconnecter.");
  try {
    await supabase.auth.signOut();
  } catch (_) {}
}, []);

const isLikelyAuthError = (x) => {
  const s = String(x || "").toLowerCase();
  return (
    s.includes("invalid token") ||
    s.includes("invalid jwt") ||
    s.includes("jwt expired") ||
    s.includes("token expired") ||
    s.includes("session expired") ||
    s.includes("expired") ||
    s.includes("auth")
  );
};

const handleAuthResponse = useCallback(
  async (resp, j) => {
    if (!resp) return false;
    const err = j?.error || j?.message || "";
    if (resp.status === 401 || isLikelyAuthError(err)) {
      await markSessionExpired("Session expirée. Veuillez vous reconnecter.");
      return true;
    }
    return false;
  },
  [markSessionExpired]
);


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

  const roleRaw = hookProfile?.role ?? profileFallback?.role ?? null;

  // Rôle "source de vérité" (utile pour la tablette kiosque superviseur)
  // On interroge /api/role avec le Bearer token afin d'identifier SUPERVISOR même si profile.role est vide / incorrect.
  const [apiRole, setApiRole] = useState(null);
  const [apiRoleChecked, setApiRoleChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;

    (async () => {
      if (!authChecked) return;

      // Pas connecté -> rien à vérifier
      if (!userId) {
        if (alive) {
          setApiRole(null);
          setApiRoleChecked(true);
        }
        return;
      }

      if (alive) {
        setApiRole(null);
        setApiRoleChecked(false);
      }

      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token || session?.access_token || null;

        if (!token) {
          if (alive) setApiRoleChecked(true);
          return;
        }

        // timeout court pour ne pas bloquer l'UI en cas de réseau capricieux
        const t = setTimeout(() => {
          try {
            ctrl?.abort?.();
          } catch (_) {}
        }, 2500);

        const resp = await fetch("/api/role", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl?.signal,
        });

        clearTimeout(t);

        const j = await resp.json().catch(() => ({}));
        const rr = String(j?.role || j?.data?.role || j?.user_role || "").trim().toLowerCase();

        if (!alive) return;
        setApiRole(rr || null);
        setApiRoleChecked(true);
      } catch (_) {
        if (!alive) return;
        setApiRole(null);
        setApiRoleChecked(true);
      }
    })();

    return () => {
      alive = false;
      try {
        ctrl?.abort?.();
      } catch (_) {}
    };
  }, [authChecked, userId, session?.access_token]);

  const role = apiRole || roleRaw || null;


  // ----------------------------
  // IMPORTANT: TOUS LES HOOKS EN HAUT (aucun return avant)
  // ----------------------------

  const [monday, setMonday] = useState(() => startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(monday, i)), [monday]);

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

  const [replAsk, setReplAsk] = useState(null);
  const [approvalMsg, setApprovalMsg] = useState(null);
  const now = new Date();
  const myMonthFromPast = useMemo(() => fmtISODate(firstDayOfMonth(now)), []); // stable au chargement
  const myMonthToPast = useMemo(() => fmtISODate(lastDayOfMonth(now)), []); // stable au chargement
  const [myMonthAbs, setMyMonthAbs] = useState([]);

  const [myMonthUpcomingAbs, setMyMonthUpcomingAbs] = useState([]);
  const [acceptedByAbsence, setAcceptedByAbsence] = useState({});
  const [myUpcomingRepl, setMyUpcomingRepl] = useState([]);

  // Remplacements disponibles (absences des autres vendeuses)
  const [openRepls, setOpenRepls] = useState(null); // null = pas encore chargé, [] = aucun
  const [openReplsLoading, setOpenReplsLoading] = useState(false);
  const [openReplsErr, setOpenReplsErr] = useState("");
  const [openReplsMsg, setOpenReplsMsg] = useState("");
  const [acceptReplBusy, setAcceptReplBusy] = useState({});

  // Pointage (checkins) — côté vendeuse
  const [checkinsUnsupported, setCheckinsUnsupported] = useState(false);
  const [checkinsLoading, setCheckinsLoading] = useState(false);
  const [checkinsErr, setCheckinsErr] = useState("");
  const [checkinsMsg, setCheckinsMsg] = useState("");
  const [checkinsByBoundary, setCheckinsByBoundary] = useState({}); // { BOUNDARY: row }
  const [checkinBusy, setCheckinBusy] = useState({}); // { BOUNDARY: boolean }
  const [checkinsStats, setCheckinsStats] = useState({ monthDelay: 0, monthExtra: 0, todayDelay: 0, todayExtra: 0 });


const [checkinCode, setCheckinCode] = useState("");
const [checkinLocalAtByBoundary, setCheckinLocalAtByBoundary] = useState({}); // fallback immédiat (sans attendre status)
const [clockNow, setClockNow] = useState(() => new Date());

const sanitize6Digits = (v) => String(v || "").replace(/\D/g, "").slice(0, 6);
const isValidCheckinCode = useMemo(() => /^\d{6}$/.test(checkinCode), [checkinCode]);

useEffect(() => {
  const id = setInterval(() => setClockNow(new Date()), 1000);
  return () => clearInterval(id);
}, []);



  // Retard / relais (mois en cours) — affichage permanent
  const [monthDelta, setMonthDelta] = useState({ extraMinutes: 0, delayMinutes: 0, netMinutes: 0 });
  const [monthDeltaLoading, setMonthDeltaLoading] = useState(false);
  const [monthDeltaErr, setMonthDeltaErr] = useState("");
  const [monthDeltaUnsupported, setMonthDeltaUnsupported] = useState(false);


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


  const monthEndPrev = useMemo(() => {
    try {
      const d = new Date(monthStartPrev + "T00:00:00");
      return fmtISODate(lastDayOfMonth(d));
    } catch {
      return monthStartPrev;
    }
  }, [monthStartPrev]);

  // Retards / relais pour le mois à valider (mois précédent)
  const [prevDelta, setPrevDelta] = useState({ extraMinutes: 0, delayMinutes: 0, netMinutes: 0 });
  const [prevDeltaLoading, setPrevDeltaLoading] = useState(false);
  const [prevDeltaErr, setPrevDeltaErr] = useState("");
  const [prevDeltaUnsupported, setPrevDeltaUnsupported] = useState(false);

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
    // On attend que Supabase nous dise clairement si une session existe ou non
    if (!authChecked) return;

    // On attend la détection serveur (/api/role) pour éviter d'afficher la page vendeuse sur la tablette kiosque
    if (userId && !apiRoleChecked) return;

    // Pas connecté => /login (au lieu de rester bloqué)
    if (!userId) {
      if (typeof window !== "undefined") {
        window.location.replace("/login?stay=1&next=/app");
      }
      return;
    }


    // Tablette kiosque: si le compte est superviseur, on force l'écran superviseur
    if (role === "supervisor") {
      if (typeof window !== "undefined") {
        window.location.replace("/supervisor?stay=1");
      } else {
        r.replace("/supervisor");
      }
      return;
    }

    // Empêche un appareil "vendeuse" de rester connecté en ADMIN (ex: tablette partagée)
    // Si une session admin est détectée sur /app, on déconnecte et on renvoie vers /login.
    if (role === "admin") {
      (async () => {
        try {
          await supabase.auth.signOut();
        } catch (_) {}
        if (typeof window !== "undefined") {
          window.location.replace("/login?stay=1&next=/app");
        }
      })();
      return;
    }
  }, [authChecked, userId, role, r, apiRoleChecked]);

  // Déconnexion robuste (évite les sessions "collées")
  const hardLogout = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn("[app] signOut failed:", e?.message || e);
    }

    if (typeof window === "undefined") return;

    try {
      const ls = window.localStorage;
      const ss = window.sessionStorage;

      const collectKeys = (st) => {
        const out = [];
        try {
          for (let i = 0; i < st.length; i++) {
            const k = st.key(i);
            if (k) out.push(k);
          }
        } catch (_) {}
        return out;
      };

      const shouldRemove = (k) =>
        k.startsWith("sb-") ||
        k.includes("supabase") ||
        k.includes("auth-token") ||
        k.includes("token") ||
        k.includes("refresh");

      collectKeys(ls).forEach((k) => {
        if (shouldRemove(k)) ls.removeItem(k);
      });
      collectKeys(ss).forEach((k) => {
        if (shouldRemove(k)) ss.removeItem(k);
      });
    } catch (_) {}

    // On repart proprement
    window.location.replace("/login?stay=1&next=/app");
  }, []);

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

  // ----------------------------
  // Pointage (checkins) — vendeuse
  // ----------------------------
  const myCheckinSlots = useMemo(() => {
    if (!userId) return [];

    const isMorning = todayPlan?.MORNING?.seller_id === userId;
    const isMidday = todayPlan?.MIDDAY?.seller_id === userId;
    const isEvening = todayPlan?.EVENING?.seller_id === userId;
    const isSundayExtra = todayPlan?.SUNDAY_EXTRA?.seller_id === userId;

    const slots = [];

    // Matin / Midi / Dimanche utilisent la même "fenêtre d'arrivée" (START)
    // On garde primary=*_START pour les APIs qui l'acceptent, et alt=shift_code en fallback.
    if (isMorning) slots.push({ label: "Matin", primary: "MORNING_START", alt: "MORNING" });
    if (isMidday) slots.push({ label: "Midi", primary: "MORNING_START", alt: "MIDDAY" });
    if (isSundayExtra) slots.push({ label: "Dimanche", primary: "MORNING_START", alt: "SUNDAY_EXTRA" });

    if (isEvening) slots.push({ label: "Soir", primary: "EVENING_START", alt: "EVENING" });

    return slots;
  }, [todayPlan, userId]);

  const CHECKIN_OPEN_BEFORE_MIN = 30; // 30 min avant l'heure prévue (évite de demander un code trop tôt)
  const CHECKIN_HIDE_AFTER_MIN = 120; // 2h après l'heure prévue (après, on masque le code => oubli ≠ retard)

  const plannedMinutesFromShift = (shiftCode) => {
    const sc = String(shiftCode || "").toUpperCase();
    if (sc === "EVENING") return 13 * 60 + 30; // 13:30
    if (sc === "SUNDAY_EXTRA") return 9 * 60;  // 09:00
    // MORNING + MIDDAY => même arrivée 06:30
    return 6 * 60 + 30;
  };

  const nowMinLocal = useMemo(() => (clockNow.getHours() * 60 + clockNow.getMinutes()), [clockNow]);

  const getCheckinPhase = (shiftCode) => {
    const planned = plannedMinutesFromShift(shiftCode);
    const start = planned - CHECKIN_OPEN_BEFORE_MIN;
    const end = planned + CHECKIN_HIDE_AFTER_MIN;
    if (nowMinLocal < start) return { phase: "before", planned, start, end };
    if (nowMinLocal > end) return { phase: "closed", planned, start, end };
    return { phase: "open", planned, start, end };
  };

  const isCheckinWindowOpen = (shiftCode) => getCheckinPhase(shiftCode).phase === "open";



  const hasPendingCheckin = useMemo(() => {
    if (!myCheckinSlots.length) return false;

    return myCheckinSlots.some((slot) => {
      const rec = checkinsByBoundary?.[slot.primary] || checkinsByBoundary?.[slot.alt] || null;
      const localAt =
        checkinLocalAtByBoundary?.[slot.primary] ||
        checkinLocalAtByBoundary?.[slot.alt] ||
        null;
      const at =
        rec?.checked_at ||
        rec?.checked_in_at ||
        rec?.checkin_at ||
        rec?.confirmed_at ||
        rec?.created_at ||
        rec?.at ||
        localAt ||
        null;
      const done =
        !!at ||
        rec?.checked === true ||
        rec?.ok === true ||
        rec?.status === "done" ||
        rec?.status === "confirmed";
      return !done;
    });
  }, [myCheckinSlots, checkinsByBoundary, checkinLocalAtByBoundary]);


  const hasPendingCheckinOpen = useMemo(() => {
    if (!myCheckinSlots.length) return false;

    return myCheckinSlots.some((slot) => {
      const rec = checkinsByBoundary?.[slot.primary] || checkinsByBoundary?.[slot.alt] || null;
      const localAt =
        checkinLocalAtByBoundary?.[slot.primary] ||
        checkinLocalAtByBoundary?.[slot.alt] ||
        null;
      const at =
        rec?.checked_at ||
        rec?.checked_in_at ||
        rec?.checkin_at ||
        rec?.confirmed_at ||
        rec?.created_at ||
        rec?.at ||
        localAt ||
        null;
      const done =
        !!at ||
        rec?.checked === true ||
        rec?.ok === true ||
        rec?.status === "done" ||
        rec?.status === "confirmed";

      if (done) return false;

      // Si la fenêtre est dépassée (>2h), on ne considère plus "en attente"
      const sc = slot.alt || slot.primary || "";
      return isCheckinWindowOpen(sc);
    });
  }, [myCheckinSlots, checkinsByBoundary, checkinLocalAtByBoundary, nowMinLocal]);


  const fmtTimeHM = (iso) => {
    try {
      const d = new Date(String(iso));
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return "";
    }
  };

  const parseCheckinsToMap = (payload) => {
    const j = payload || {};
    const items = Array.isArray(j.items)
      ? j.items
      : Array.isArray(j.data)
      ? j.data
      : Array.isArray(j)
      ? j
      : [];

    const map = {};
    for (const it of items) {
      if (!it) continue;
      const b = String(it.boundary || it.shift_boundary || it.code || it.type || "").toUpperCase();
      if (b) map[b] = it;
    }

    // Variante: { byBoundary: {...} }
    if (j.byBoundary && typeof j.byBoundary === "object") {
      for (const [k, v] of Object.entries(j.byBoundary)) {
        const b = String(k || "").toUpperCase();
        if (b) map[b] = v;
      }
    }


    // Fallback ancien format: { confirmed, confirmed_at, shift_code, late_minutes, early_minutes }
    const confirmedFlag =
      j?.confirmed === true ||
      j?.already_confirmed === true ||
      j?.status === "confirmed" ||
      j?.status === "done" ||
      !!j?.confirmed_at ||
      !!j?.confirmedAt ||
      !!j?.checked_at ||
      !!j?.checked_in_at ||
      !!j?.at;

    if (confirmedFlag) {
      const sc = String(j?.shift_code || "").toUpperCase();
      const boundary =
        sc === "EVENING" || sc === "EVENING_START" ? "EVENING_START" : "MORNING_START";

      const it = {
        boundary,
        shift_code: sc || null,
        confirmed_at:
          j?.confirmed_at ||
          j?.confirmedAt ||
          j?.checked_at ||
          j?.checked_in_at ||
          j?.at ||
          new Date().toISOString(),
        late_minutes: Number(j?.late_minutes || 0) || 0,
        early_minutes: Number(j?.early_minutes || 0) || 0,
        ok: true,
        status: "confirmed",
      };

      if (!map[boundary]) map[boundary] = it;
      if (sc && !map[sc]) map[sc] = it;
    }

    return map;
  };

  const loadCheckinsStatus = useCallback(async () => {
    if (!userId || role === "admin" || checkinsUnsupported) return;

    // Si pas planifiée sur matin/soir => rien à afficher
    if (!myCheckinSlots.length) {
      setCheckinsByBoundary({});
      return;
    }

    setCheckinsErr("");
    setCheckinsMsg("");
    setCheckinsLoading(true);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token || null;
      if (!token) {
        window.location.replace("/login?stay=1&next=/app");
        return;
      }

      const urls = [
        `/api/checkins/status?date=${encodeURIComponent(todayIso)}`,
        `/api/checkins/status?day=${encodeURIComponent(todayIso)}`,
        `/api/checkins/status?d=${encodeURIComponent(todayIso)}`,
      ];

      let r = null;
      for (const u of urls) {
        const rr = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
        if (rr.status === 404) continue;
        r = rr;
        break;
      }

      if (!r) {
        setCheckinsUnsupported(true);
        setCheckinsByBoundary({});
        return;
      }

      const j = await r.json().catch(() => ({}));
      if (await handleAuthResponse(r, j)) return;
      if (!r.ok || j?.ok === false) {
        setCheckinsErr(String(j?.error || `HTTP ${r.status}`));
        return;
      }

      setCheckinsByBoundary(parseCheckinsToMap(j));
      // Totaux pointage (retard/avance) utiles pour afficher "ce mois-ci"
      setCheckinsStats({
        monthDelay: Number(j?.month_delay_minutes || 0) || 0,
        monthExtra: Number(j?.month_extra_minutes || 0) || 0,
        todayDelay: Number(j?.today_delay_minutes ?? j?.late_minutes ?? 0) || 0,
        todayExtra: Number(j?.today_extra_minutes ?? j?.early_minutes ?? 0) || 0,
      });

    } catch (e) {
      setCheckinsErr(e?.message || "Impossible de charger le pointage.");
    } finally {
      setCheckinsLoading(false);
    }
  }, [userId, role, checkinsUnsupported, myCheckinSlots.length, todayIso]);

  const confirmCheckin = useCallback(
    async (slot) => {
      if (!userId || role === "admin" || checkinsUnsupported) return;
      const busyKey = slot?.primary || "CHECKIN";
      setCheckinBusy((prev) => ({ ...prev, [busyKey]: true }));
      setCheckinsErr("");
      setCheckinsMsg("");

const code6 = String(checkinCode || "").trim();
if (!/^\d{6}$/.test(code6)) {
  setCheckinsErr("Saisis le code à 6 chiffres avant de pointer.");
  setCheckinBusy((prev) => ({ ...prev, [busyKey]: false }));
  return;
}

      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token || null;
        if (!token) {
          window.location.replace("/login?stay=1&next=/app");
          return;
        }

        const paths = ["/api/checkins/confirm", "/api/checkins/cofirm"]; // (cofirm = tolérance faute de frappe)
        const tryOnce = async (path, boundary) => {
          const r = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ date: todayIso, boundary, source: "seller", code: code6 }),
          });
          const j = await r.json().catch(() => ({}));
                    if (await handleAuthResponse(r, j)) return { r, j, authExpired: true };
          return { r, j, authExpired: false };
        };

        let ok = false;
        let lastErr = "";
        let usedPath = null;

        for (const path of paths) {
          // ignore 404 and try next
          const first = await tryOnce(path, slot.primary);
          if (first.authExpired) return;
          if (first.r.status === 404) continue;

          usedPath = path;

          if (first.r.ok && first.j?.ok !== false) {
            ok = true;
            break;
          }

          // Si boundary "START" non supportée, on tente alt
          const err = String(first.j?.error || `HTTP ${first.r.status}`);
          lastErr = err;

          const eLower = err.toLowerCase();
          const boundaryIssue = eLower.includes("boundary") || eLower.includes("invalid") || eLower.includes("unknown");
          if (boundaryIssue && slot.alt && slot.alt !== slot.primary) {
            const second = await tryOnce(path, slot.alt);
            if (second.authExpired) return;
            if (second.r.ok && second.j?.ok !== false) {
              ok = true;
              break;
            }
            lastErr = String(second.j?.error || `HTTP ${second.r.status}`);
          }

          // sinon stop, on ne boucle pas inutilement
          break;
        }

        if (!usedPath) {
          setCheckinsUnsupported(true);
          setCheckinsErr("Pointage indisponible (API /api/checkins/* absente).");
          return;
        }

        if (!ok) {
          setCheckinsErr(lastErr || "Pointage impossible.");
          return;
        }

        const clickedAt = new Date();
        setCheckinLocalAtByBoundary((prev) => ({ ...prev, [slot.primary]: clickedAt.toISOString() }));
        setCheckinsMsg(`✅ Pointage enregistré à ${clickedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.`);
        await loadCheckinsStatus();
      } catch (e) {
        setCheckinsErr(e?.message || "Pointage impossible (exception).");
      } finally {
        setCheckinBusy((prev) => ({ ...prev, [busyKey]: false }));
      }
    },
    [userId, role, checkinsUnsupported, todayIso, loadCheckinsStatus, checkinCode]
  );

  useEffect(() => {
    if (!userId || role === "admin") return;
    if (!myCheckinSlots.length) return;
    loadCheckinsStatus();
    const id = setInterval(loadCheckinsStatus, 60 * 1000);
    return () => clearInterval(id);
  }, [userId, role, myCheckinSlots.length, loadCheckinsStatus]);


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
    (data || []).forEach((r) => {
      if (!byDate[r.date]) byDate[r.date] = { ids: [], approved: false, pending: false, locked: false };
      byDate[r.date].ids.push(r.id);
      if (r.status === "approved") byDate[r.date].approved = true;
      if (r.status === "pending") byDate[r.date].pending = true;
      if (r.admin_forced) byDate[r.date].locked = true;
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

    const volunteerIds = Array.from(new Set((rows || []).map((r) => r.volunteer_id).filter(Boolean)));
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

  
  // Remplacements disponibles (autres vendeuses) — via API serveur (service role)
  const loadOpenReplacements = useCallback(async () => {
    if (!userId) return;
    setOpenReplsErr("");
    setOpenReplsMsg("");
    setOpenReplsLoading(true);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token || null;
      if (!token) return;

      const r = await fetch(
        `/api/replacements/open?from=${encodeURIComponent(todayIso)}&to=${encodeURIComponent(rangeTo)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const j = await r.json().catch(() => ({}));
      if (await handleAuthResponse(r, j)) return;
      if (!r.ok || !j?.ok) {
        setOpenRepls(null);
        setOpenReplsErr(String(j?.error || `HTTP ${r.status}`));
        return;
      }

      setOpenRepls(Array.isArray(j.items) ? j.items : []);
    } catch (e) {
      setOpenRepls(null);
      setOpenReplsErr(e?.message || "Impossible de charger les remplacements.");
    } finally {
      setOpenReplsLoading(false);
    }
  }, [userId, todayIso, rangeTo]);

  const acceptReplacement = useCallback(
    async (item) => {
      if (!userId) return;
      const key = `${item.absence_id}|${item.shift_code}`;
      setAcceptReplBusy((prev) => ({ ...prev, [key]: true }));
      setOpenReplsMsg("");
      setOpenReplsErr("");

      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token || null;
        if (!token) {
          window.location.replace("/login?stay=1&next=/app");
          return;
        }

        const r = await fetch("/api/replacements/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ absence_id: item.absence_id, shift_code: item.shift_code }),
        });

        const j = await r.json().catch(() => ({}));
        if (await handleAuthResponse(r, j)) return;
        if (!r.ok || !j?.ok) {
          const e = String(j?.error || `HTTP ${r.status}`);
          if (e === "ALREADY_SCHEDULED") setOpenReplsErr("Impossible : vous êtes déjà planifiée ce jour-là.");
          else if (e === "TAKEN") setOpenReplsErr("Déjà pris : quelqu’un a déjà remplacé ce créneau.");
          else if (e === "NOT_APPROVED") setOpenReplsErr("Absence non approuvée.");
          else if (e === "NO_SHIFT_TO_REPLACE") setOpenReplsErr("Aucun créneau à remplacer pour cette absence.");
          else if (e === "Missing SUPABASE_SERVICE_ROLE_KEY") setOpenReplsErr("Serveur non configuré (service role).");
          else setOpenReplsErr(`Erreur: ${e}`);
          return;
        }

        setOpenReplsMsg("✅ Remplacement accepté. Le planning est mis à jour.");
        await loadWeekPlanning();
        await loadTodayPlan();
        await reloadAccepted();
        await loadMyUpcomingRepl();
        await loadOpenReplacements();
      } finally {
        setAcceptReplBusy((prev) => ({ ...prev, [key]: false }));
      }
    },
    [userId, loadWeekPlanning, loadTodayPlan, reloadAccepted, loadMyUpcomingRepl, loadOpenReplacements]
  );

  useEffect(() => {
    if (!userId) return;
    loadOpenReplacements().catch(() => {});
  }, [userId, loadOpenReplacements]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => {
      if (!userId) return;
      loadOpenReplacements().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [userId, loadOpenReplacements]);

useEffect(() => {
    loadMyMonthAbs();
    loadMyMonthUpcomingAbs();
    reloadAccepted();
    loadMyUpcomingRepl();
  }, [loadMyMonthAbs, loadMyMonthUpcomingAbs, reloadAccepted, loadMyUpcomingRepl]);

  // Retard / relais (mois en cours)
  const loadMyMonthDelta = useCallback(async () => {
    if (!userId) return;
    setMonthDeltaErr("");
    setMonthDeltaLoading(true);

    try {
      // 1) RPC (recommandée) : seller_handover_month_summary(p_month_start)
      const { data: rpcData, error: rpcErr } = await supabase.rpc("seller_handover_month_summary", {
        p_month_start: myMonthFromPast,
      });

      if (!rpcErr && rpcData != null) {
        const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        const extra = Number(row?.extra_minutes ?? row?.extraMinutes ?? 0) || 0;
        const delay = Number(row?.delay_minutes ?? row?.delayMinutes ?? 0) || 0;
        const net = Number(row?.net_minutes ?? row?.netMinutes ?? (extra - delay) ?? 0) || 0;

        setMonthDelta({ extraMinutes: extra, delayMinutes: delay, netMinutes: net });
        setMonthDeltaUnsupported(false);
        return;
      }

      const msg = String(rpcErr?.message || "");
      const codeE = String(rpcErr?.code || "");
      const missingFn = codeE === "42883" || msg.toLowerCase().includes("does not exist");

      // 2) fallback direct table si RPC absente
      if (missingFn) {
        const { data: rows, error: e2 } = await supabase
          .from("shift_handover_adjustments")
          .select("*")
          .gte("date", myMonthFromPast)
          .lte("date", myMonthToPast)
          .or(`staying_seller_id.eq.${userId},evening_seller_id.eq.${userId},seller_id.eq.${userId}`);

        if (e2) {
          const m2 = String(e2?.message || "");
          const c2 = String(e2?.code || "");
          const forbidden =
            m2.toLowerCase().includes("permission") ||
            m2.toLowerCase().includes("rls") ||
            m2.toLowerCase().includes("not allowed");
          const missingTbl = c2 === "42P01" || m2.toLowerCase().includes("does not exist");
          const missingCol = c2 === "42703" || m2.toLowerCase().includes("column");

          if (forbidden || missingTbl || missingCol) {
            setMonthDeltaUnsupported(true);
            setMonthDelta({ extraMinutes: 0, delayMinutes: 0, netMinutes: 0 });
            return;
          }
          throw e2;
        }

        let extra = 0;
        let delay = 0;
        let net = 0;

        (rows || []).forEach((row) => {
          const raw =
            row?.delta_minutes ??
            row?.delta ??
            row?.minutes ??
            row?.minute_delta ??
            row?.delta_min ??
            row?.deltaMinutes ??
            null;

          const base = Number(raw);
          if (!Number.isFinite(base) || base === 0) return;

          let signed = null;

          // Cas 1 : table déjà normalisée (seller_id + minutes signées)
          if (row?.seller_id && row.seller_id === userId) {
            signed = base;
          }

          // Cas 2 : une ligne = 2 vendeuses (celle qui reste / celle du soir)
          if (signed == null) {
            if (row?.staying_seller_id && row.staying_seller_id === userId) signed = Math.abs(base);
            else if (row?.evening_seller_id && row.evening_seller_id === userId) signed = -Math.abs(base);
          }

          // Cas 3 : variantes to/from
          if (signed == null) {
            if (row?.to_seller_id && row.to_seller_id === userId) signed = Math.abs(base);
            else if (row?.from_seller_id && row.from_seller_id === userId) signed = -Math.abs(base);
          }

          if (signed == null) return;

          net += signed;
          if (signed >= 0) extra += signed;
          else delay += -signed;
        });

        setMonthDelta({
          extraMinutes: Math.round(extra),
          delayMinutes: Math.round(delay),
          netMinutes: Math.round(net),
        });
        setMonthDeltaUnsupported(false);
        return;
      }

      // RPC existante mais erreur réelle
      if (rpcErr) throw rpcErr;
    } catch (e) {
      setMonthDeltaErr(e?.message || "Impossible de charger les retards/relais du mois.");
    } finally {
      setMonthDeltaLoading(false);
    }
  }, [userId, myMonthFromPast, myMonthToPast]);

  useEffect(() => {
    loadMyMonthDelta();
  }, [loadMyMonthDelta]);

  // Realtime (si la table existe et si l'utilisateur a accès)
  useEffect(() => {
    if (!userId || monthDeltaUnsupported) return;

    const ch = supabase
      .channel("handover_rt_app")
      .on("postgres_changes", { event: "*", schema: "public", table: "shift_handover_adjustments" }, () => {
        loadMyMonthDelta().catch(() => {});
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, monthDeltaUnsupported, loadMyMonthDelta]);

  // Refresh quand on revient sur l'onglet
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => loadMyMonthDelta().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadMyMonthDelta]);
  // Retards / relais pour le mois à valider (mois précédent)
  const loadPrevMonthDelta = useCallback(async () => {
    if (!userId || role === "admin") return;
    setPrevDeltaErr("");
    setPrevDeltaLoading(true);

    try {
      // 1) RPC (recommandée) : seller_handover_month_summary(p_month_start)
      const { data: rpcData, error: rpcErr } = await supabase.rpc("seller_handover_month_summary", {
        p_month_start: monthStartPrev,
      });

      if (!rpcErr && rpcData != null) {
        const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        const extra = Number(row?.extra_minutes ?? row?.extraMinutes ?? 0) || 0;
        const delay = Number(row?.delay_minutes ?? row?.delayMinutes ?? 0) || 0;
        const net = Number(row?.net_minutes ?? row?.netMinutes ?? (extra - delay) ?? 0) || 0;

        setPrevDelta({ extraMinutes: extra, delayMinutes: delay, netMinutes: net });
        setPrevDeltaUnsupported(false);
        return;
      }

      const msg = String(rpcErr?.message || "");
      const codeE = String(rpcErr?.code || "");
      const missingFn = codeE === "42883" || msg.toLowerCase().includes("does not exist");

      // 2) fallback direct table si RPC absente
      if (missingFn) {
        const { data: rows, error: e2 } = await supabase
          .from("shift_handover_adjustments")
          .select("*")
          .gte("date", monthStartPrev)
          .lte("date", monthEndPrev)
          .or(`staying_seller_id.eq.${userId},evening_seller_id.eq.${userId},seller_id.eq.${userId}`);

        if (e2) {
          const m2 = String(e2?.message || "");
          const c2 = String(e2?.code || "");
          const forbidden =
            m2.toLowerCase().includes("permission") ||
            m2.toLowerCase().includes("rls") ||
            m2.toLowerCase().includes("not allowed");
          const missingTbl = c2 === "42P01" || m2.toLowerCase().includes("does not exist");
          const missingCol = c2 === "42703" || m2.toLowerCase().includes("column");

          if (forbidden || missingTbl || missingCol) {
            setPrevDeltaUnsupported(true);
            setPrevDelta({ extraMinutes: 0, delayMinutes: 0, netMinutes: 0 });
            return;
          }
          throw e2;
        }

        let extra = 0;
        let delay = 0;
        let net = 0;

        (rows || []).forEach((row) => {
          const raw =
            row?.delta_minutes ??
            row?.delta ??
            row?.minutes ??
            row?.minute_delta ??
            row?.delta_min ??
            row?.deltaMinutes ??
            null;

          const base = Number(raw);
          if (!Number.isFinite(base) || base === 0) return;

          let signed = null;

          // Cas 1 : table déjà normalisée (seller_id + minutes signées)
          if (row?.seller_id && row.seller_id === userId) {
            signed = base;
          }

          // Cas 2 : une ligne = 2 vendeuses (celle qui reste / celle du soir)
          if (signed == null) {
            if (row?.staying_seller_id && row.staying_seller_id === userId) signed = Math.abs(base);
            else if (row?.evening_seller_id && row.evening_seller_id === userId) signed = -Math.abs(base);
          }

          // Cas 3 : variantes to/from
          if (signed == null) {
            if (row?.to_seller_id && row.to_seller_id === userId) signed = Math.abs(base);
            else if (row?.from_seller_id && row.from_seller_id === userId) signed = -Math.abs(base);
          }

          if (signed == null) return;

          net += signed;
          if (signed >= 0) extra += signed;
          else delay += -signed;
        });

        setPrevDelta({
          extraMinutes: Math.round(extra),
          delayMinutes: Math.round(delay),
          netMinutes: Math.round(net),
        });
        setPrevDeltaUnsupported(false);
        return;
      }

      // RPC existante mais erreur réelle
      if (rpcErr) throw rpcErr;
    } catch (e) {
      setPrevDeltaErr(e?.message || "Impossible de charger les retards/relais du mois.");
    } finally {
      setPrevDeltaLoading(false);
    }
  }, [userId, role, monthStartPrev, monthEndPrev]);

  useEffect(() => {
    loadPrevMonthDelta();
  }, [loadPrevMonthDelta]);


  // Validation mensuelle (si RPC existent)
  const ensureMonthlyRow = useCallback(async () => {
  // ✅ On ne crée/charge jamais d'attestation mensuelle pour un admin/non-seller
  if (!userId || monthlyUnsupported || role === "admin") return;

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
  }, [userId, monthStartPrev, monthlyUnsupported, role]);

  useEffect(() => {
    ensureMonthlyRow();
  }, [ensureMonthlyRow]);


  // Recharge simple (utile pour rafraîchir quand l'admin valide/refuse)
  const fetchMonthlyRow = useCallback(async () => {
    if (!userId || monthlyUnsupported || role === "admin") return null;
    try {
      const { data, error } = await supabase
        .from("monthly_hours_attestations")
        .select("*")
        .eq("seller_id", userId)
        .eq("month_start", monthStartPrev)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        setMonthlyRow(data || null);
        if (data?.seller_status === "disputed") setCorrHours(String(data?.seller_correction_hours ?? ""));
        if (data?.seller_comment) setCorrNote(String(data?.seller_comment || ""));
      }
      return data || null;
    } catch (e) {
      return null;
    }
  }, [userId, monthStartPrev, monthlyUnsupported, role]);

  // Auto-refresh pendant l'attente de décision admin (évite Ctrl+F5)
  useEffect(() => {
    if (!userId || role === "admin" || monthlyUnsupported) return;
    if (!monthlyRow) return;

    const awaiting =
      monthlyRow.admin_status === "pending" &&
      (monthlyRow.seller_status === "accepted" || monthlyRow.seller_status === "disputed");

    if (!awaiting) return;

    const t = setInterval(() => {
      fetchMonthlyRow().catch(() => {});
    }, 15000);

    return () => clearInterval(t);
  }, [userId, role, monthlyUnsupported, monthlyRow, fetchMonthlyRow]);

  // Soumission mensuelle (vendeuse) : on utilise la RPC si elle fonctionne,
  // mais on a un fallback direct en UPDATE pour éviter le cas "admin_status=rejected"
  // qui faisait un UPDATE 0 ligne sans erreur visible.
  const directUpdateMonthlyRow = useCallback(
    async ({ mode, corrected, comment }) => {
      const nowIso = new Date().toISOString();

      const patch = {
        // Quand la vendeuse (re)valide ou corrige, on remet le dossier "à traiter" côté admin.
        admin_status: "pending",
        seller_confirmed_at: nowIso,
      };

      if (mode === "accept") {
        patch.seller_status = "accepted";
        patch.seller_correction_hours = null;
        patch.seller_comment = null;
      } else if (mode === "correct") {
        patch.seller_status = "disputed";
        patch.seller_correction_hours = corrected;
        patch.seller_comment = comment || null;
      } else {
        throw new Error("Mode mensuel invalide");
      }

      // Si on a un id, c’est le plus précis. Sinon, on cible seller_id + month_start.
      let q = supabase.from("monthly_hours_attestations").update(patch);

      if (monthlyRow?.id != null) q = q.eq("id", monthlyRow.id);
      else q = q.eq("seller_id", userId).eq("month_start", monthStartPrev);

      const { data, error } = await q.select("*").maybeSingle();
      if (error) throw error;

      setMonthlyRow(data || null);
      return data || null;
    },
    [userId, monthStartPrev, monthlyRow]
  );

  const sellerAcceptMonthly = useCallback(async () => {
    if (!userId || monthlyUnsupported) return;
    setMonthlyErr("");
    setMonthlyFlash("");

    // 1) tente la RPC (si elle gère déjà tout)
    const { data, error } = await supabase.rpc("seller_monthly_hours_submit", {
      p_month_start: monthStartPrev,
      p_mode: "accept",
      p_corrected: null,
      p_comment: null,
    });

    if (!error && data?.seller_status === "accepted") {
      setMonthlyRow(data || null);
      setMonthlyFlash("✅ Validation envoyée à l’admin.");
      fetchMonthlyRow().catch(() => {});
      setTimeout(() => setMonthlyFlash(""), 5000);
      return;
    }

    // 2) fallback: UPDATE direct (utile si admin_status était 'rejected')
    try {
      await directUpdateMonthlyRow({ mode: "accept", corrected: null, comment: null });
      setMonthlyFlash("✅ Validation envoyée à l’admin.");
      fetchMonthlyRow().catch(() => {});
      setTimeout(() => setMonthlyFlash(""), 5000);
    } catch (e) {
      setMonthlyErr(error?.message || e?.message || "Échec de validation");
    }
  }, [userId, monthStartPrev, monthlyUnsupported, directUpdateMonthlyRow, fetchMonthlyRow]);

  const sellerCorrectMonthly = useCallback(async () => {
    if (!userId || monthlyUnsupported) return;
    setMonthlyErr("");
    setMonthlyFlash("");

    const val = Number(String(corrHours || "").replace(",", "."));
    if (!Number.isFinite(val) || val <= 0) {
      setMonthlyErr("Indique un total d'heures valide (ex: 151.5).");
      return;
    }

    const comment = (corrNote || "").trim() || null;

    // 1) tente la RPC
    const { data, error } = await supabase.rpc("seller_monthly_hours_submit", {
      p_month_start: monthStartPrev,
      p_mode: "correct",
      p_corrected: val,
      p_comment: comment,
    });

    if (!error && data?.seller_status === "disputed") {
      setMonthlyRow(data || null);
      setMonthlyFlash("✅ Correction envoyée à l’admin.");
      fetchMonthlyRow().catch(() => {});
      setTimeout(() => setMonthlyFlash(""), 5000);
      return;
    }

    // 2) fallback: UPDATE direct (utile si admin_status était 'rejected')
    try {
      await directUpdateMonthlyRow({ mode: "correct", corrected: val, comment });
      setMonthlyFlash("✅ Correction envoyée à l’admin.");
      fetchMonthlyRow().catch(() => {});
      setTimeout(() => setMonthlyFlash(""), 5000);
    } catch (e) {
      setMonthlyErr(error?.message || e?.message || "Échec d'envoi de correction");
    }
  }, [userId, monthStartPrev, corrHours, corrNote, monthlyUnsupported, directUpdateMonthlyRow, fetchMonthlyRow]);

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
  const showLoading = !authChecked || !plannerChecked || !apiRoleChecked;
  const showNeedAuth = !userId && authChecked;

  if (showLoading) {
    return <div className="p-4">Chargement...</div>;
  }

  if (showNeedAuth) {
    return (
      <div className="p-4 space-y-3">
        <div>Connexion requise...</div>
        <button className="btn" onClick={() => (window.location.href = "/login?stay=1&next=/app")}>
          Aller à /login
        </button>
<button className="btn" onClick={hardLogout}>
          Se déconnecter
        </button>
      </div>
    );
  }

  // Kiosk: éviter le "flash" de la page vendeuse avant la redirection
  if (role === "supervisor") {
    return (
      <div className="p-4 max-w-2xl mx-auto">
        <div className="card">
          <div className="hdr">Ouverture de l’écran superviseur…</div>
          <div className="text-sm text-gray-600 mt-2">Redirection en cours.</div>
        </div>
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
          <button className="btn" onClick={() => r.push("/leaves")}>
            Congés
          </button>
          <button className="btn" onClick={hardLogout}>
            Se déconnecter
          </button>
        </div>
      </div>



{sessionExpired && (
  <div className="card border-red-300 bg-red-50">
    <div className="hdr text-red-700">Session expirée</div>
    <div className="text-sm text-red-700">
      {sessionExpiredMsg || "Votre session a expiré. Reconnectez-vous pour continuer."}
    </div>
    <div className="mt-3 flex items-center gap-2">
      <button className="btn" onClick={() => window.location.replace("/login?stay=1&next=/app")}>
        Se reconnecter
      </button>
      <button className="btn" onClick={() => setSessionExpired(false)}>
        Fermer
      </button>
    </div>
  </div>
)}

      {(role !== "admin" && (checkinsStats.monthDelay > 0 || checkinsStats.monthExtra > 0)) && (
        <div className={`rounded-xl border p-3 ${
          checkinsStats.monthDelay > 0 ? "border-red-200 bg-red-50" : "border-green-200 bg-green-50"
        }`}>
          <div className={`text-sm font-semibold ${
            checkinsStats.monthDelay > 0 ? "text-red-800" : "text-green-800"
          }`}>
            {checkinsStats.monthDelay > 0
              ? `Vous avez ${checkinsStats.monthDelay} min de retard ce mois-ci.`
              : `Vous avez ${checkinsStats.monthExtra} min d'avance ce mois-ci.`}
            {checkinsStats.monthDelay > 0 && checkinsStats.monthExtra > 0 ? ` (Avance: ${checkinsStats.monthExtra} min)` : ""}
          </div>
        </div>
      )}

      {role !== "admin" && myCheckinSlots.length > 0 && !absentToday && (
        <div className="card">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="hdr">⏱️ Pointage du jour</div>
              <div className="text-xs text-gray-500">{frDate(todayIso)} • {clockNow.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
            </div>
            <button className="btn" onClick={loadCheckinsStatus} disabled={checkinsLoading}>
              {checkinsLoading ? "Actualisation..." : "Rafraîchir"}
            </button>
          </div>

          {checkinsUnsupported ? (
            <div
              className="text-sm mt-3 border rounded-xl p-2"
              style={{ backgroundColor: "#fff7ed", borderColor: "#fdba74" }}
            >
              Pointage indisponible sur cet environnement (API /api/checkins/* manquante).
            </div>
          ) : (
            <>
              {checkinsErr && (
                <div
                  className="text-sm mt-3 border rounded-xl p-2"
                  style={{ backgroundColor: "#fee2e2", borderColor: "#fca5a5" }}
                >
                  ⚠️ {checkinsErr}
                </div>
              )}

              {checkinsMsg && (
                <div
                  className="text-sm mt-3 border rounded-xl p-2"
                  style={{ backgroundColor: "#dcfce7", borderColor: "#86efac" }}
                >
                  {checkinsMsg}
                </div>
              )}

              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {myCheckinSlots.map((slot) => {
                  const rec = checkinsByBoundary?.[slot.primary] || checkinsByBoundary?.[slot.alt] || null;
                  const localAt =
                    checkinLocalAtByBoundary?.[slot.primary] ||
                    checkinLocalAtByBoundary?.[slot.alt] ||
                    null;
                  const at =
                    rec?.checked_at ||
                    rec?.checked_in_at ||
                    rec?.checkin_at ||
                    rec?.confirmed_at ||
                    rec?.created_at ||
                    rec?.at ||
                    localAt ||
                    null;
                  const done =
                    !!at ||
                    rec?.checked === true ||
                    rec?.ok === true ||
                    rec?.status === "done" ||
                    rec?.status === "confirmed";

                                    const phaseInfo = getCheckinPhase(slot.alt || slot.primary);
                  const phase = phaseInfo.phase;
                  const fmtHMFromMinutes = (min) => {
                    const m = ((min % (24 * 60)) + (24 * 60)) % (24 * 60);
                    const hh = String(Math.floor(m / 60)).padStart(2, "0");
                    const mm = String(m % 60).padStart(2, "0");
                    return `${hh}:${mm}`;
                  };

return (
                    <div key={slot.primary} className="border rounded-2xl p-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">{slot.label}</div>
                        <div className="text-xs text-gray-500">
                          {done ? `✅ Pointé à ${fmtTimeHM(at)}` : "Pas encore pointé"}
                        </div>
                        {done && ((Number(rec?.late_minutes || 0) || 0) > 0 || (Number(rec?.early_minutes || 0) || 0) > 0) && (
                          <div
                            className="text-xs mt-1"
                            style={{
                              color: (Number(rec?.late_minutes || 0) || 0) > 0 ? "#b91c1c" : "#065f46",
                            }}
                          >
                            {(Number(rec?.late_minutes || 0) || 0) > 0
                              ? `⏰ Retard: +${Number(rec?.late_minutes || 0) || 0} min`
                              : `✅ Travail en plus: +${Number(rec?.early_minutes || 0) || 0} min`}
                          </div>
                        )}

                      </div>

                      {!done && phase === "open" ? (
  <div className="flex items-center gap-2">
    <input
      value={checkinCode}
      onChange={(e) => setCheckinCode(sanitize6Digits(e.target.value))}
      inputMode="numeric"
      pattern="[0-9]*"
      placeholder="Code (6 chiffres)"
      className="border rounded-xl px-3 py-2 text-sm"
      style={{
        width: 150,
        textAlign: "center",
        letterSpacing: "0.12em",
        borderColor: isValidCheckinCode ? "#d1d5db" : "#fca5a5",
        background: "#fff",
      }}
    />
    <button
      className="btn"
      onClick={() => confirmCheckin(slot)}
      disabled={!!checkinBusy?.[slot.primary] || !isValidCheckinCode}
      style={{
        backgroundColor:
          !!checkinBusy?.[slot.primary] || !isValidCheckinCode ? "#9ca3af" : "#16a34a",
        color: "#fff",
        borderColor: "transparent",
        cursor:
          !!checkinBusy?.[slot.primary] || !isValidCheckinCode ? "not-allowed" : "pointer",
      }}
    >
      {checkinBusy?.[slot.primary] ? "..." : "Je pointe"}
    </button>
  </div>

) : done ? (
                        <span className="text-xs px-2 py-1 rounded-full" style={{ background: "#f3f4f6" }}>
                          OK
                        </span>
                      
                      ) : (
                        <span className="text-xs px-2 py-1 rounded-full" style={{ background: phase === "before" ? "#e0e7ff" : "#fee2e2", color: phase === "before" ? "#1e3a8a" : "#991b1b" }}>
                          {phase === "before" ? `À partir de ${fmtHMFromMinutes(phaseInfo.start)}` : "Fermé"}
                        </span>

                      )}
                    </div>
                  );
                })}
              </div>

              <div className="text-xs text-gray-600 mt-2">
                Ce mois-ci (pointage):
                {` retard ${checkinsStats.monthDelay} min`}{checkinsStats.monthExtra > 0 ? ` • travail en plus ${checkinsStats.monthExtra} min` : ""}
              </div>

              {(checkinsStats.monthDelay > 0 || checkinsStats.monthExtra > 0) && (
                <div
                  className="mt-3 text-sm px-3 py-2 rounded-lg"
                  style={{
                    background: checkinsStats.monthDelay > 0 ? "#fee2e2" : "#dcfce7",
                    color: checkinsStats.monthDelay > 0 ? "#991b1b" : "#166534",
                    border: `1px solid ${checkinsStats.monthDelay > 0 ? "#fecaca" : "#bbf7d0"}`,
                    fontWeight: 700,
                  }}
                >
                  {checkinsStats.monthDelay > 0
                    ? `Vous avez ${checkinsStats.monthDelay} min de retard ce mois-ci (pointage).`
                    : `Vous avez ${checkinsStats.monthExtra} min de travail en plus ce mois-ci (pointage).`}
                </div>
              )}


              {hasPendingCheckinOpen && checkinCode.length > 0 && !isValidCheckinCode && (
                <div className="text-xs mt-2" style={{ color: "#b91c1c" }}>
                  Saisis le code à 6 chiffres pour activer « Je pointe ».
                </div>
              )}

              <div className="text-xs text-gray-500 mt-2">
                Le pointage sert à enregistrer l’heure d’arrivée. Si tu as un souci, dis-le à l’administrateur.
              </div>
            </>
          )}
        </div>
      )}



      {role !== "admin" &&
        !monthDeltaUnsupported &&
        (monthDeltaLoading ||
          monthDeltaErr ||
          monthDelta.extraMinutes > 0 ||
          monthDelta.delayMinutes > 0) && (
          <div className="card">
            <div className="hdr mb-2">Retard / relais - mois en cours</div>

            {monthDeltaLoading && <div className="text-sm text-gray-600">Chargement...</div>}

            {monthDeltaErr && (
              <div
                className="text-sm mb-2 border rounded-xl p-2"
                style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}
              >
                {monthDeltaErr}
              </div>
            )}

            {!monthDeltaLoading && !monthDeltaErr && (
              <div className="space-y-2">
                {monthDelta.delayMinutes > 0 && (
                  <div
                    className="text-sm border rounded-xl p-2"
                    style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}
                  >
                    ⏱️ Vous avez <b>{fmtMinutesHM(monthDelta.delayMinutes)}</b> de retard ce mois-ci.
                  </div>
                )}

                {monthDelta.extraMinutes > 0 && (
                  <div
                    className="text-sm border rounded-xl p-2"
                    style={{ backgroundColor: "#dcfce7", borderColor: "#86efac" }}
                  >
                    ➕ Vous avez <b>{fmtMinutesHM(monthDelta.extraMinutes)}</b> de travail en plus ce mois-ci.
                  </div>
                )}
              </div>
            )}
          </div>
        )}


      {role !== "admin" && !monthlyUnsupported && (monthlyLoading || monthlyRow) && (

        <div className="card">
          <div className="hdr mb-2">Validation des heures - {capFirst(monthLabel)}</div>

          {monthlyFlash && (
            <div
              className="text-sm mb-2 border rounded-xl p-2"
              style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}
            >
              {monthlyFlash}
            </div>
          )}

          {monthlyErr && (
            <div
              className="text-sm mb-2 border rounded-xl p-2"
              style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}
            >
              {monthlyErr}
            </div>
          )}

          {monthlyRow?.admin_status === "pending" &&
          monthlyRow?.seller_status === "pending" &&
          monthlyRow?.admin_comment ? (
            <div
              className="text-sm mb-2 border rounded-xl p-2"
              style={{ backgroundColor: "#fff7ed", borderColor: "#fdba74" }}
            >
              <b>Message admin :</b> {monthlyRow.admin_comment}
            </div>
          ) : null}


          {monthlyLoading && <div className="text-sm text-gray-600">Chargement...</div>}

          {!monthlyLoading && monthlyRow && (
            <>
              <div className="text-sm">
                Total calculé sur le planning :{" "}
                <span className="font-semibold">{Number(monthlyRow.computed_hours || 0).toFixed(2)} h</span>
              </div>

              <div className="mt-2">
                {prevDeltaLoading ? (
                  <div className="text-xs text-gray-600">Calcul des retards/relais du mois...</div>
                ) : prevDeltaUnsupported ? (
                  <div className="text-xs text-gray-500">Retards/relais non disponibles pour ce mois.</div>
                ) : prevDeltaErr ? (
                  <div className="text-xs text-red-600">{prevDeltaErr}</div>
                ) : (
                  (() => {
                    const computed = Number(monthlyRow?.computed_hours || 0);
                    const extraH = (Number(prevDelta?.extraMinutes || 0) || 0) / 60;
                    const delayH = (Number(prevDelta?.delayMinutes || 0) || 0) / 60;
                    const netH = computed + ((Number(prevDelta?.netMinutes || 0) || 0) / 60);

                    return (
                      <div className="space-y-1">
                        <div className="text-xs text-gray-700">
                          Retards / relais sur le mois :{" "}
                          <span className="font-semibold" style={{ color: "#16a34a" }}>
                            +{extraH.toFixed(2)} h
                          </span>{" "}
                          •{" "}
                          <span className="font-semibold" style={{ color: "#dc2626" }}>
                            -{delayH.toFixed(2)} h
                          </span>
                        </div>
                        <div className="text-sm">
                          Total net estimé : <span className="font-semibold">{netH.toFixed(2)} h</span>
                        </div>
                        <div className="text-xs text-gray-500">
                          Total net = planning + retards/relais. C’est ce total qui correspond à l’affichage admin.
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>


              {(() => {
                const computed = Number(monthlyRow?.computed_hours || 0);
                const corrected =
                  monthlyRow?.seller_correction_hours != null
                    ? Number(monthlyRow.seller_correction_hours)
                    : null;
                const final =
                  monthlyRow?.final_hours != null
                    ? Number(monthlyRow.final_hours)
                    : computed;

                // ✅ Décision admin = approuvé
                if (monthlyRow?.admin_status === "approved") {
                  const what = monthlyRow?.seller_status === "disputed" ? "correction" : "validation";
                  return (
                    <div
                      className="text-sm mt-3 border rounded-xl p-2"
                      style={{ backgroundColor: "#dcfce7", borderColor: "#86efac" }}
                    >
                      ✅ Votre {what} a été validée. Total heures = <b>{final.toFixed(2)} h</b>.
                    </div>
                  );
                }

                // ⏳ Correction envoyée (vendeuse), en attente admin
                if (monthlyRow?.seller_status === "disputed") {
                  return (
                    <div
                      className="text-sm mt-3 border rounded-xl p-2"
                      style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}
                    >
                      ✅ Votre correction{" "}
                      {corrected != null ? (
                        <>
                          (<b>{corrected.toFixed(2)} h</b>)
                        </>
                      ) : null}{" "}
                      est envoyée et elle est en attente de confirmation par l’administrateur.
                    </div>
                  );
                }

                // ⏳ Validation envoyée (vendeuse), en attente admin
                if (monthlyRow?.seller_status === "accepted") {
                  return (
                    <div
                      className="text-sm mt-3 border rounded-xl p-2"
                      style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}
                    >
                      ✅ Votre validation est envoyée et elle est en attente de confirmation par l’administrateur.
                    </div>
                  );
                }

                // ⚠️ Cas "rejected" (ancien état) : on affiche un message
                if (monthlyRow?.admin_status === "rejected") {
                  return (
                    <div
                      className="text-sm mt-3 border rounded-xl p-2"
                      style={{ backgroundColor: "#fff7ed", borderColor: "#fdba74" }}
                    >
                      ⚠️ L’administrateur a refusé. Merci de corriger à nouveau.
                    </div>
                  );
                }

                return null;
              })()}

              {monthlyRow.seller_status === "pending" && (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <button
                      className="btn"
                      onClick={sellerAcceptMonthly}
                      style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}
                    >
                      Valider
                    </button>
                    <div className="text-xs text-gray-500">
                      Si tu as échangé des créneaux sans que le planning ait été mis à jour, tu peux corriger ton total.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      className="input"
                      value={corrHours}
                      onChange={(e) => setCorrHours(e.target.value)}
                      placeholder="Heures corrigées (ex: 151.5)"
                      inputMode="decimal"
                    />
                    <input
                      className="input"
                      value={corrNote}
                      onChange={(e) => setCorrNote(e.target.value)}
                      placeholder="Commentaire (optionnel)"
                    />
                    <button
                      className="btn"
                      onClick={sellerCorrectMonthly}
                      style={{ backgroundColor: "#111827", color: "#fff", borderColor: "transparent" }}
                    >
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
                <div
                  key={code}
                  className="rounded-2xl p-3"
                  style={{ backgroundColor: bg, color: fg, border: `1px solid ${border}` }}
                >
                  <div className="text-sm">{SHIFT_LABELS[code] || code}</div>
                  <div className="mt-1 text-sm">{shownName}</div>

                  {isPlanner && editPlanning && (
                    <div className="mt-3">
                      <select
                        className="input"
                        value={assigned || ""}
                        onChange={(e) => saveShift(todayIso, code, e.target.value || null)}
                      >
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
        <div
          className="border rounded-2xl p-3 flex flex-col gap-2"
          style={{
            backgroundColor: absentToday.status === "approved" ? "#fee2e2" : "#fff7ed",
            borderColor: "#fca5a5",
          }}
        >
          <div className="font-medium">Absente aujourd’hui - {frDate(absentToday.date)}</div>
          <div className="text-sm">
            {absentToday.status === "approved"
              ? "Absence approuvée par l’administrateur."
              : "Demande d’absence en attente d’approbation."}
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

      
      {role !== "admin" &&
        (openReplsLoading || openReplsErr || (Array.isArray(openRepls) && openRepls.length > 0)) && (
          <div className="card">
            <div className="hdr mb-2">Remplacements disponibles</div>

            {openReplsLoading && <div className="text-sm text-gray-600">Chargement...</div>}

            {openReplsMsg && (
              <div
                className="text-sm mb-2 border rounded-xl p-2"
                style={{ backgroundColor: "#dcfce7", borderColor: "#86efac" }}
              >
                {openReplsMsg}
              </div>
            )}

            {openReplsErr && (
              <div
                className="text-sm mb-2 border rounded-xl p-2"
                style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}
              >
                {openReplsErr}
              </div>
            )}

            {!openReplsLoading && Array.isArray(openRepls) && openRepls.length > 0 ? (
              <div className="space-y-2">
                {openRepls.map((it) => {
                  const k = `${it.absence_id}|${it.shift_code}`;
                  const busy = !!acceptReplBusy?.[k];
                  return (
                    <div key={k} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border rounded-2xl p-3">
                      <div className="text-sm">
                        <div className="font-medium">
                          {frDate(it.date)} · {labelForShift(it.shift_code)}
                        </div>
                        <div style={{ opacity: 0.85 }}>
                          Absence de <b>{it.absent_name || "—"}</b>
                        </div>
                      </div>
                      <button className="btn" onClick={() => acceptReplacement(it)} disabled={busy}>
                        {busy ? "..." : "Je remplace"}
                      </button>
                    </div>
                  );
                })}

                <div className="text-xs text-gray-500">
                  Si vous êtes déjà planifiée ce jour-là, l’app refusera le remplacement.
                </div>
              </div>
            ) : null}
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
              <div
                key={iso}
                className="border rounded-2xl p-3 space-y-3"
                style={{ borderWidth: isToday ? 2 : 1, borderColor: isToday ? "#2563eb" : "#e5e7eb" }}
              >
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
                    <div
                      key={code}
                      className="rounded-2xl p-3"
                      style={{ backgroundColor: bg, color: fg, border: `1px solid ${border}` }}
                    >
                      <div className="text-sm font-medium">{SHIFT_LABELS[code] || code}</div>
                      <div className="mt-1 text-sm">{shownName}</div>

                      {isPlanner && editPlanning && (
                        <div className="mt-3">
                          <select
                            className="input"
                            value={assigned}
                            onChange={(e) => saveShift(iso, code, e.target.value || null)}
                          >
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
        <div className="hdr mb-2">Vos absences ce mois</div>
        {myMonthAbs.length === 0 ? (
          <div className="text-sm text-gray-600">
            Vous n'avez aucune absence approuvée passée (ou aujourd'hui) ce mois-ci.
          </div>
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
    </div>
  );
}
