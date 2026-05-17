/* eslint-disable react/no-unescaped-entities */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { addDays, fmtISODate, startOfWeek } from "@/lib/date";
import { fetchShiftTypeVersionsClient, getShiftLabelForDate } from "@/lib/shift-type-config";

const SHIFT_HOURS = {
  MORNING: 7,
  MIDDAY: 7,
  EVENING: 7,
  SUNDAY_EXTRA: 4.5,
};

const SELLER_COLOR_OVERRIDES = {
  antonia: "#e57373",
  olivia: "#64b5f6",
  colleen: "#81c784",
  ibtissam: "#ba68c8",
  charlene: "#f59e0b",
};

const normalize = (s) => String(s || "").trim().toLowerCase();
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const isSunday = (d) => d.getDay() === 0;
const weekdayFR = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });

function frDate(iso) {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("fr-FR");
  } catch {
    return iso;
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

function firstDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function lastDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function monthInputValue(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function monthStartFromInput(v) {
  const raw = String(v || "");
  const m = raw.match(/^(\d{4})-(\d{2})$/);
  if (!m) return firstDayOfMonth(new Date());
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return new Date(year, month, 1);
}

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function hslToHex(h, s, l) {
  const ss = s / 100;
  const ll = l / 100;
  const a = ss * Math.min(ll, 1 - ll);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
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
  const key = String(name || sellerId || "seller");
  return autoColorFromName(key);
}

function fallbackLabelForShift(code) {
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

function compareWeekIso(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

export default function WorkHistoryPage() {
  const r = useRouter();
  const { session: hookSession, profile: hookProfile } = useAuth();

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
      } catch (_) {}
    })();

    return () => {
      alive = false;
    };
  }, [userId, hookProfile]);

  const role = hookProfile?.role ?? profileFallback?.role ?? null;
  const displayName =
    hookProfile?.full_name ||
    profileFallback?.full_name ||
    session?.user?.user_metadata?.full_name ||
    (userEmail ? userEmail.split("@")[0] : "—");

  useEffect(() => {
    if (!authChecked) return;
    if (!userId && typeof window !== "undefined") {
      window.location.replace("/login?stay=1&next=/work-history");
      return;
    }
    if (role === "supervisor" && typeof window !== "undefined") {
      window.location.replace("/supervisor?stay=1");
    }
  }, [authChecked, userId, role]);

  const [selectedMonth, setSelectedMonth] = useState(() => monthInputValue(new Date()));
  const selectedMonthStart = useMemo(() => monthStartFromInput(selectedMonth), [selectedMonth]);
  const selectedMonthEnd = useMemo(() => lastDayOfMonth(selectedMonthStart), [selectedMonthStart]);
  const selectedMonthStartIso = useMemo(() => fmtISODate(selectedMonthStart), [selectedMonthStart]);
  const selectedMonthEndIso = useMemo(() => fmtISODate(selectedMonthEnd), [selectedMonthEnd]);
  const selectedMonthLabel = useMemo(
    () => capFirst(selectedMonthStart.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })),
    [selectedMonthStart]
  );

  const todayIso = useMemo(() => fmtISODate(new Date()), []);
  const firstVisibleWeek = useMemo(() => startOfWeek(selectedMonthStart), [selectedMonthStart]);
  const lastVisibleWeek = useMemo(() => startOfWeek(selectedMonthEnd), [selectedMonthEnd]);
  const [weekMonday, setWeekMonday] = useState(() => startOfWeek(new Date()));

  useEffect(() => {
    setWeekMonday(firstVisibleWeek);
  }, [firstVisibleWeek]);

  const visibleDays = useMemo(
    () => Array.from({ length: 7 }).map((_, i) => addDays(weekMonday, i)),
    [weekMonday]
  );

  const canPrevWeek = compareWeekIso(fmtISODate(weekMonday), fmtISODate(firstVisibleWeek)) > 0;
  const canNextWeek = compareWeekIso(fmtISODate(weekMonday), fmtISODate(lastVisibleWeek)) < 0;

  const [shiftTypeRows, setShiftTypeRows] = useState([]);
  const loadShiftTypes = useCallback(async () => {
    const { data } = await fetchShiftTypeVersionsClient(supabase);
    setShiftTypeRows(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    loadShiftTypes();
  }, [loadShiftTypes]);

  useEffect(() => {
    const ch = supabase
      .channel("shift_types_rt_work_history")
      .on("postgres_changes", { event: "*", schema: "public", table: "shift_type_versions" }, () => {
        loadShiftTypes().catch(() => {});
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [loadShiftTypes]);

  const getShiftLabel = useCallback(
    (dateIso, code) => getShiftLabelForDate(shiftTypeRows, dateIso, code) || fallbackLabelForShift(code),
    [shiftTypeRows]
  );

  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyErr, setHistoryErr] = useState("");

  // Détails quotidiens affichés directement dans chaque créneau historique
  // - daily_checkins : avance / retard de pointage
  // - extra_work_entries(kind=coverage) : minutes de couverture attribuées par l'admin
  const [dailyCheckinRows, setDailyCheckinRows] = useState([]);
  const [coverageRows, setCoverageRows] = useState([]);
  const [shiftDetailsLoading, setShiftDetailsLoading] = useState(false);
  const [shiftDetailsErr, setShiftDetailsErr] = useState("");

  const loadHistory = useCallback(async () => {
    if (!userId) return;
    setHistoryErr("");
    setHistoryLoading(true);

    try {
      const { data: vw, error: e1 } = await supabase
        .from("view_week_assignments")
        .select("date, shift_code, seller_id")
        .eq("seller_id", userId)
        .gte("date", selectedMonthStartIso)
        .lte("date", selectedMonthEndIso)
        .order("date", { ascending: true });

      if (!e1 && Array.isArray(vw) && vw.length > 0) {
        setHistoryRows(
          vw.map((row) => ({
            date: row.date,
            shift_code: row.shift_code,
            seller_id: row.seller_id,
          }))
        );
        return;
      }

      const { data: sh, error: e2 } = await supabase
        .from("shifts")
        .select("date, shift_code, seller_id")
        .eq("seller_id", userId)
        .gte("date", selectedMonthStartIso)
        .lte("date", selectedMonthEndIso)
        .order("date", { ascending: true });

      if (e2) throw e2;

      setHistoryRows(
        (sh || []).map((row) => ({
          date: row.date,
          shift_code: row.shift_code,
          seller_id: row.seller_id,
        }))
      );
    } catch (e) {
      setHistoryRows([]);
      setHistoryErr(e?.message || "Impossible de charger l’historique du planning.");
    } finally {
      setHistoryLoading(false);
    }
  }, [userId, selectedMonthStartIso, selectedMonthEndIso]);

  const loadShiftDetails = useCallback(async () => {
    if (!userId) return;

    setShiftDetailsErr("");
    setShiftDetailsLoading(true);

    const partialErrors = [];

    try {
      // Les retards / avances du pointage sont lus côté serveur.
      // C'est plus fiable que de dépendre d'une lecture directe de daily_checkins
      // depuis le navigateur, qui peut être limitée par les règles RLS.
      let checkinRows = [];
      let checkinLoaded = false;

      try {
        const { data: authData } = await supabase.auth.getSession();
        const token = authData?.session?.access_token || session?.access_token || null;

        if (token) {
          const resp = await fetch(
            `/api/checkins/month-details?from=${encodeURIComponent(selectedMonthStartIso)}&to=${encodeURIComponent(selectedMonthEndIso)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          const j = await resp.json().catch(() => ({}));

          if (resp.ok && j?.ok !== false) {
            checkinRows = Array.isArray(j?.items) ? j.items : [];
            checkinLoaded = true;
          } else if (resp.status !== 404) {
            partialErrors.push(
              String(j?.error || "Les détails de pointage ne sont pas disponibles.")
            );
          }
        }
      } catch (_) {
        // Fallback ci-dessous.
      }

      // Fallback prudent si l'API n'est pas encore déployée ou absente localement.
      if (!checkinLoaded) {
        const { data: checkins, error: checkinsErr } = await supabase
          .from("daily_checkins")
          .select("day, late_minutes, early_minutes, confirmed_at")
          .eq("seller_id", userId)
          .gte("day", selectedMonthStartIso)
          .lte("day", selectedMonthEndIso)
          .not("confirmed_at", "is", null)
          .order("day", { ascending: true });

        if (checkinsErr) {
          checkinRows = [];
          if (!partialErrors.some((x) => String(x || "").includes("pointage"))) {
            partialErrors.push("Les détails de pointage ne sont pas disponibles.");
          }
        } else {
          checkinRows = Array.isArray(checkins) ? checkins : [];
        }
      }

      setDailyCheckinRows(checkinRows);

      // Les minutes de couverture liées aux retards du soir sont stockées en travail en plus.
      // On garde un fallback prudent si la colonne kind n'est pas accessible dans un ancien schéma.
      let extraRows = [];
      const { data: coverageData, error: coverageErr } = await supabase
        .from("extra_work_entries")
        .select("work_date, minutes, kind, reason")
        .eq("seller_id", userId)
        .gte("work_date", selectedMonthStartIso)
        .lte("work_date", selectedMonthEndIso)
        .order("work_date", { ascending: true });

      if (!coverageErr) {
        extraRows = Array.isArray(coverageData) ? coverageData : [];
      } else {
        const msg = String(coverageErr?.message || "").toLowerCase();
        const code = String(coverageErr?.code || "");
        const missingKind = code === "42703" || msg.includes("kind");

        if (missingKind) {
          const { data: fallbackRows, error: fallbackErr } = await supabase
            .from("extra_work_entries")
            .select("work_date, minutes, reason")
            .eq("seller_id", userId)
            .gte("work_date", selectedMonthStartIso)
            .lte("work_date", selectedMonthEndIso)
            .order("work_date", { ascending: true });

          if (!fallbackErr) {
            extraRows = Array.isArray(fallbackRows)
              ? fallbackRows.map((row) => ({ ...row, kind: null }))
              : [];
          } else {
            partialErrors.push("Les minutes de couverture ne sont pas disponibles.");
          }
        } else {
          partialErrors.push("Les minutes de couverture ne sont pas disponibles.");
        }
      }

      setCoverageRows(extraRows);

      if (partialErrors.length > 0) {
        setShiftDetailsErr(partialErrors.join(" "));
      }
    } catch (e) {
      setDailyCheckinRows([]);
      setCoverageRows([]);
      setShiftDetailsErr(e?.message || "Impossible de charger les détails de pointage et de couverture.");
    } finally {
      setShiftDetailsLoading(false);
    }
  }, [userId, session?.access_token, selectedMonthStartIso, selectedMonthEndIso]);
  useEffect(() => {
    loadHistory();
    loadShiftDetails();
  }, [loadHistory, loadShiftDetails]);

  useEffect(() => {
    if (!userId) return;
    const ch = supabase
      .channel("shifts_rt_work_history")
      .on("postgres_changes", { event: "*", schema: "public", table: "shifts" }, () => {
        loadHistory().catch(() => {});
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, loadHistory]);

  const rowsByDate = useMemo(() => {
    const map = {};
    (historyRows || []).forEach((row) => {
      const d = String(row?.date || "");
      if (!d) return;
      if (!map[d]) map[d] = [];
      map[d].push(row);
    });
    return map;
  }, [historyRows]);

  const checkinInfoByDate = useMemo(() => {
    const map = {};
    (dailyCheckinRows || []).forEach((row) => {
      const day = String(row?.day || "");
      if (!day) return;
      const lateMinutes = Math.max(0, Math.round(Number(row?.late_minutes || 0) || 0));
      const earlyMinutes = Math.max(0, Math.round(Number(row?.early_minutes || 0) || 0));
      if (!lateMinutes && !earlyMinutes) return;
      map[day] = {
        lateMinutes,
        earlyMinutes,
        confirmedAt: row?.confirmed_at || null,
      };
    });
    return map;
  }, [dailyCheckinRows]);

  const coverageMinutesByDate = useMemo(() => {
    const map = {};
    (coverageRows || []).forEach((row) => {
      const day = String(row?.work_date || "");
      if (!day) return;
      const kind = String(row?.kind || "").trim().toLowerCase();
      if (kind !== "coverage") return;
      const minutes = Math.max(0, Math.round(Number(row?.minutes || 0) || 0));
      if (!minutes) return;
      map[day] = (map[day] || 0) + minutes;
    });
    return map;
  }, [coverageRows]);

  const monthRowsAlreadyPassed = useMemo(
    () => (historyRows || []).filter((row) => String(row?.date || "") <= todayIso),
    [historyRows, todayIso]
  );

  const monthHoursAlreadyPassed = useMemo(
    () =>
      monthRowsAlreadyPassed.reduce(
        (sum, row) => sum + (Number(SHIFT_HOURS[row?.shift_code] || 0) || 0),
        0
      ),
    [monthRowsAlreadyPassed]
  );

  const monthRowsTotal = Array.isArray(historyRows) ? historyRows.length : 0;
  const monthPastRowsTotal = monthRowsAlreadyPassed.length;
  const sellerColor = useMemo(() => colorForSeller(userId, displayName), [userId, displayName]);

  // ------------------------------------------------------------
  // Validation des heures, déplacée depuis /app vers /work-history
  // ------------------------------------------------------------
  const monthStartPrev = useMemo(() => {
    const n = new Date();
    const firstThis = new Date(n.getFullYear(), n.getMonth(), 1);
    const prev = new Date(firstThis);
    prev.setMonth(prev.getMonth() - 1);
    return fmtISODate(prev);
  }, []);

  const monthEndPrev = useMemo(() => {
    try {
      const d = new Date(`${monthStartPrev}T00:00:00`);
      return fmtISODate(lastDayOfMonth(d));
    } catch {
      return monthStartPrev;
    }
  }, [monthStartPrev]);

  const monthLabel = useMemo(() => {
    const d = new Date(`${monthStartPrev}T00:00:00`);
    return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }, [monthStartPrev]);

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

  const loadExtraWorkMinutesRange = useCallback(
    async (fromIso, toIso) => {
      if (!userId) return { minutes: 0, unsupported: false, error: null };

      try {
        const { data, error } = await supabase
          .from("extra_work_entries")
          .select("minutes")
          .eq("seller_id", userId)
          .gte("work_date", fromIso)
          .lte("work_date", toIso);

        if (error) {
          const msg = String(error?.message || "");
          const codeE = String(error?.code || "");
          const forbidden =
            msg.toLowerCase().includes("permission") ||
            msg.toLowerCase().includes("rls") ||
            msg.toLowerCase().includes("not allowed");
          const missingTbl = codeE === "42P01" || msg.toLowerCase().includes("does not exist");
          const missingCol = codeE === "42703" || msg.toLowerCase().includes("column");

          if (forbidden || missingTbl || missingCol) {
            return { minutes: 0, unsupported: true, error: null };
          }
          throw error;
        }

        const minutes = Math.round(
          (data || []).reduce((sum, row) => sum + (Number(row?.minutes || 0) || 0), 0)
        );
        return { minutes, unsupported: false, error: null };
      } catch (e) {
        return { minutes: 0, unsupported: false, error: e };
      }
    },
    [userId]
  );

  const loadPrevMonthDelta = useCallback(async () => {
    if (!userId || role === "admin") return;
    setPrevDeltaErr("");
    setPrevDeltaLoading(true);

    try {
      let relayExtra = 0;
      let relayDelay = 0;
      let relayNet = 0;
      let relayUnsupported = false;

      const { data: rpcData, error: rpcErr } = await supabase.rpc("seller_handover_month_summary", {
        p_month_start: monthStartPrev,
      });

      if (!rpcErr && rpcData != null) {
        const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        relayExtra = Number(row?.extra_minutes ?? row?.extraMinutes ?? 0) || 0;
        relayDelay = Number(row?.delay_minutes ?? row?.delayMinutes ?? 0) || 0;
        relayNet = Number(row?.net_minutes ?? row?.netMinutes ?? (relayExtra - relayDelay) ?? 0) || 0;
      } else {
        const msg = String(rpcErr?.message || "");
        const codeE = String(rpcErr?.code || "");
        const missingFn = codeE === "42883" || msg.toLowerCase().includes("does not exist");

        if (missingFn) {
          const { data: rows, error: e2 } = await supabase
            .from("shift_handover_adjustments")
            .select("*")
            .gte("date", monthStartPrev)
            .lte("date", monthEndPrev)
            .or(
              `staying_seller_id.eq.${userId},evening_seller_id.eq.${userId},seller_id.eq.${userId},to_seller_id.eq.${userId},from_seller_id.eq.${userId}`
            );

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
              relayUnsupported = true;
            } else {
              throw e2;
            }
          } else {
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
              if (row?.seller_id && row.seller_id === userId) signed = base;
              if (signed == null) {
                if (row?.staying_seller_id && row.staying_seller_id === userId) signed = Math.abs(base);
                else if (row?.evening_seller_id && row.evening_seller_id === userId) signed = -Math.abs(base);
              }
              if (signed == null) {
                if (row?.to_seller_id && row.to_seller_id === userId) signed = Math.abs(base);
                else if (row?.from_seller_id && row.from_seller_id === userId) signed = -Math.abs(base);
              }
              if (signed == null) return;

              relayNet += signed;
              if (signed >= 0) relayExtra += signed;
              else relayDelay += -signed;
            });
          }
        } else if (rpcErr) {
          throw rpcErr;
        }
      }

      const extraWork = await loadExtraWorkMinutesRange(monthStartPrev, monthEndPrev);
      if (extraWork?.error) throw extraWork.error;

      setPrevDelta({
        extraMinutes: Math.round(relayExtra + (Number(extraWork?.minutes || 0) || 0)),
        delayMinutes: Math.round(relayDelay),
        netMinutes: Math.round(relayNet + (Number(extraWork?.minutes || 0) || 0)),
      });
      setPrevDeltaUnsupported(Boolean(relayUnsupported && extraWork?.unsupported));
    } catch (e) {
      setPrevDeltaErr(e?.message || "Impossible de charger les retards/relais/travail en plus du mois.");
    } finally {
      setPrevDeltaLoading(false);
    }
  }, [userId, role, monthStartPrev, monthEndPrev, loadExtraWorkMinutesRange]);

  const ensureMonthlyRow = useCallback(async () => {
    if (!userId || monthlyUnsupported || role === "admin") return;

    setMonthlyErr("");
    setMonthlyLoading(true);
    try {
      const { data, error } = await supabase.rpc("ensure_monthly_hours_row", {
        p_month_start: monthStartPrev,
      });

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
    } catch (_) {
      return null;
    }
  }, [userId, monthStartPrev, monthlyUnsupported, role]);

  const directUpdateMonthlyRow = useCallback(
    async ({ mode, corrected, comment }) => {
      const nowIso = new Date().toISOString();
      const patch = {
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

    try {
      await directUpdateMonthlyRow({ mode: "correct", corrected: val, comment });
      setMonthlyFlash("✅ Correction envoyée à l’admin.");
      fetchMonthlyRow().catch(() => {});
      setTimeout(() => setMonthlyFlash(""), 5000);
    } catch (e) {
      setMonthlyErr(error?.message || e?.message || "Échec d'envoi de correction");
    }
  }, [userId, monthStartPrev, corrHours, corrNote, monthlyUnsupported, directUpdateMonthlyRow, fetchMonthlyRow]);

  useEffect(() => {
    loadPrevMonthDelta();
    ensureMonthlyRow();
  }, [loadPrevMonthDelta, ensureMonthlyRow]);

  useEffect(() => {
    if (!userId || role === "admin" || monthlyUnsupported || !monthlyRow) return;
    const awaiting =
      monthlyRow.admin_status === "pending" &&
      (monthlyRow.seller_status === "accepted" || monthlyRow.seller_status === "disputed");

    if (!awaiting) return;

    const t = setInterval(() => {
      fetchMonthlyRow().catch(() => {});
    }, 15000);

    return () => clearInterval(t);
  }, [userId, role, monthlyUnsupported, monthlyRow, fetchMonthlyRow]);

  if (!authChecked) {
    return <div className="p-4">Chargement...</div>;
  }

  if (!userId) {
    return (
      <div className="p-4 max-w-3xl mx-auto">
        <div className="card">
          <div className="hdr">Connexion requise</div>
          <div className="text-sm text-gray-600 mt-2">Redirection vers la connexion…</div>
        </div>
      </div>
    );
  }

  if (role === "supervisor") {
    return (
      <div className="p-4 max-w-3xl mx-auto">
        <div className="card">
          <div className="hdr">Ouverture de l’écran superviseur…</div>
          <div className="text-sm text-gray-600 mt-2">Redirection en cours.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="hdr">Historique du planning</div>
          <div className="text-sm text-gray-600">
            Bonjour {displayName}. Ici, tu vois seulement tes propres créneaux.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" onClick={() => r.push("/app")}>
            Retour accueil
          </button>
          <button className="btn" onClick={() => r.push("/leaves")}>
            Congés
          </button>
        </div>
      </div>

      <div className="card">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="hdr">Planning de {selectedMonthLabel}</div>
            <div className="text-xs text-gray-500 mt-1">
              Le total ci-dessous compte uniquement les créneaux déjà passés.
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="text-sm">
              <span className="block text-xs text-gray-500 mb-1">Choisir un mois</span>
              <input
                type="month"
                className="input"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value || monthInputValue(new Date()))}
              />
            </label>
            <button
              className="btn"
              onClick={() => {
                loadHistory();
                loadShiftDetails();
              }}
              disabled={historyLoading || shiftDetailsLoading}
            >
              {historyLoading || shiftDetailsLoading ? "Actualisation..." : "Rafraîchir"}
            </button>
          </div>
        </div>

        {historyErr && (
          <div
            className="text-sm mt-4 border rounded-xl p-3"
            style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}
          >
            ⚠️ {historyErr}
          </div>
        )}

        {shiftDetailsErr && (
          <div
            className="text-sm mt-4 border rounded-xl p-3"
            style={{ backgroundColor: "#fff7ed", borderColor: "#fdba74" }}
          >
            ⚠️ {shiftDetailsErr}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">Heures des créneaux déjà passés</div>
            <div className="text-2xl font-semibold mt-1">{monthHoursAlreadyPassed.toFixed(2)} h</div>
          </div>
          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">Créneaux déjà passés</div>
            <div className="text-2xl font-semibold mt-1">{monthPastRowsTotal}</div>
          </div>
          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">Créneaux visibles sur le mois</div>
            <div className="text-2xl font-semibold mt-1">{monthRowsTotal}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div>
            <div className="hdr">Semaine affichée</div>
            <div className="text-sm text-gray-600">
              Du {frDate(fmtISODate(weekMonday))} au {frDate(fmtISODate(addDays(weekMonday, 6)))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn"
              onClick={() => setWeekMonday(addDays(weekMonday, -7))}
              disabled={!canPrevWeek}
            >
              Semaine précédente
            </button>
            <button className="btn" onClick={() => setWeekMonday(firstVisibleWeek)}>
              Début du mois
            </button>
            <button
              className="btn"
              onClick={() => setWeekMonday(addDays(weekMonday, 7))}
              disabled={!canNextWeek}
            >
              Semaine suivante
            </button>
          </div>
        </div>

        {historyLoading ? (
          <div className="text-sm text-gray-600">Chargement du planning...</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
            {visibleDays.map((d) => {
              const iso = fmtISODate(d);
              const inSelectedMonth = iso >= selectedMonthStartIso && iso <= selectedMonthEndIso;
              const rows = rowsByDate?.[iso] || [];
              const sunday = isSunday(d);
              const orderedCodes = ["MORNING", "MIDDAY", ...(sunday ? ["SUNDAY_EXTRA"] : []), "EVENING"];
              const orderedRows = orderedCodes
                .map((code) => rows.find((row) => row.shift_code === code))
                .filter(Boolean);
              const fallbackRows = rows.filter((row) => !orderedCodes.includes(row.shift_code));
              const dayRows = [...orderedRows, ...fallbackRows];
              const dayCheckin = checkinInfoByDate?.[iso] || null;
              const dayCoverageMinutes = Number(coverageMinutesByDate?.[iso] || 0) || 0;

              return (
                <div
                  key={iso}
                  className="border rounded-2xl p-3 min-h-[160px]"
                  style={{
                    opacity: inSelectedMonth ? 1 : 0.5,
                    borderColor: iso === todayIso ? "#2563eb" : "#e5e7eb",
                    borderWidth: iso === todayIso ? 2 : 1,
                    backgroundColor: inSelectedMonth ? "#ffffff" : "#f9fafb",
                  }}
                >
                  <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                  <div className="font-semibold mt-1">{frDate(iso)}</div>

                  <div className="mt-3 space-y-2">
                    {!dayRows.length ? (
                      <div className="text-xs text-gray-500">Aucun créneau.</div>
                    ) : (
                      dayRows.map((row) => (
                        <div
                          key={`${row.date}-${row.shift_code}`}
                          className="rounded-xl p-2 text-xs font-medium"
                          style={{
                            backgroundColor: sellerColor,
                            color: "#fff",
                          }}
                        >
                          <div>{getShiftLabel(row.date, row.shift_code)}</div>

                          {(dayCheckin?.earlyMinutes > 0 || dayCheckin?.lateMinutes > 0 || dayCoverageMinutes > 0) && (
                            <div className="mt-2 space-y-1">
                              {dayCheckin?.earlyMinutes > 0 && (
                                <div
                                  className="rounded-lg px-2 py-1 text-[11px] font-semibold"
                                  style={{ backgroundColor: "#dcfce7", color: "#166534" }}
                                >
                                  +{fmtMinutesHM(dayCheckin.earlyMinutes)} travail en plus
                                </div>
                              )}

                              {dayCheckin?.lateMinutes > 0 && (
                                <div
                                  className="rounded-lg px-2 py-1 text-[11px] font-semibold"
                                  style={{ backgroundColor: "#fee2e2", color: "#991b1b" }}
                                >
                                  -{fmtMinutesHM(dayCheckin.lateMinutes)} retard pointage
                                </div>
                              )}

                              {dayCoverageMinutes > 0 && (
                                <div
                                  className="rounded-lg px-2 py-1 text-[11px] font-semibold"
                                  style={{ backgroundColor: "#dcfce7", color: "#166534" }}
                                >
                                  +{fmtMinutesHM(dayCoverageMinutes)} couverture
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!monthlyUnsupported && role !== "admin" && (
        <div className="card">
          <div className="hdr mb-2">Validation des heures - {capFirst(monthLabel)}</div>
          <div className="text-xs text-gray-500 mb-3">
            Ce bloc concerne le dernier mois terminé. Il a été déplacé ici pour alléger la page d’accueil vendeuse.
          </div>

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
                    const netH = computed + (Number(prevDelta?.netMinutes || 0) || 0) / 60;

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
                          Total net = planning + retards/relais/travail en plus. C’est ce total qui correspond à l’affichage admin.
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
                  monthlyRow?.final_hours != null ? Number(monthlyRow.final_hours) : computed;

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

      {monthlyUnsupported && role !== "admin" && (
        <div className="card">
          <div className="hdr">Validation des heures</div>
          <div className="text-sm text-gray-600 mt-2">
            Cette fonction n’est pas disponible sur cet environnement.
          </div>
        </div>
      )}
    </div>
  );
}
