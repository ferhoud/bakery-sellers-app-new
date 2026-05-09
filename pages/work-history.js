import Head from "next/head";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "@/lib/date";

const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9h-13h30" };
const SHIFT_HOURS = { MORNING: 7, MIDDAY: 7, EVENING: 7, SUNDAY_EXTRA: 4.5 };
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
  const hue = hashStr(normalize(name)) % 360;
  return hslToHex(hue, 65, 50);
}
function colorForSeller(sellerId, name) {
  const ovr = SELLER_COLOR_OVERRIDES[normalize(name)];
  if (ovr) return ovr;
  return autoColorFromName(name || String(sellerId || "seller"));
}
function monthInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function firstDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function lastDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function fmtHours(h) {
  return Number(h || 0).toFixed(2);
}

export default function WorkHistoryPage() {
  const r = useRouter();
  const { session: hookSession, profile: hookProfile } = useAuth();

  const [sbSession, setSbSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [profileFallback, setProfileFallback] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(() => firstDayOfMonth(new Date()));
  const [currentWeekMondayIso, setCurrentWeekMondayIso] = useState("");
  const [assign, setAssign] = useState({});
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadErr, setLoadErr] = useState("");

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
  const todayIso = useMemo(() => fmtISODate(new Date()), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!userId) {
        if (alive) setProfileFallback(null);
        return;
      }
      if (hookProfile?.user_id === userId) return;
      try {
        const { data } = await supabase.from("profiles").select("user_id, full_name, role").eq("user_id", userId).maybeSingle();
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
    (userEmail ? userEmail.split("@")[0] : "Ma vendeuse");

  useEffect(() => {
    if (!authChecked) return;
    if (!userId) {
      if (typeof window !== "undefined") window.location.replace("/login?stay=1&next=/work-history");
      return;
    }
    if (role === "admin") {
      r.replace("/admin");
      return;
    }
    if (role === "supervisor") {
      r.replace("/supervisor");
    }
  }, [authChecked, userId, role, r]);

  const monthFrom = useMemo(() => fmtISODate(firstDayOfMonth(selectedMonth)), [selectedMonth]);
  const monthTo = useMemo(() => fmtISODate(lastDayOfMonth(selectedMonth)), [selectedMonth]);
  const monthLabel = useMemo(
    () => selectedMonth.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }),
    [selectedMonth]
  );

  const firstGridMonday = useMemo(() => startOfWeek(firstDayOfMonth(selectedMonth)), [selectedMonth]);
  const lastGridDay = useMemo(() => {
    const last = lastDayOfMonth(selectedMonth);
    return addDays(startOfWeek(last), 6);
  }, [selectedMonth]);

  const weekMondays = useMemo(() => {
    const arr = [];
    let cur = new Date(firstGridMonday);
    while (fmtISODate(cur) <= fmtISODate(lastGridDay)) {
      arr.push(new Date(cur));
      cur = addDays(cur, 7);
    }
    return arr;
  }, [firstGridMonday, lastGridDay]);

  useEffect(() => {
    const current = fmtISODate(startOfWeek(new Date()));
    const choices = weekMondays.map((d) => fmtISODate(d));
    if (choices.length === 0) {
      setCurrentWeekMondayIso("");
      return;
    }
    if (choices.includes(current) && current >= fmtISODate(firstGridMonday) && current <= fmtISODate(lastGridDay)) {
      setCurrentWeekMondayIso(current);
      return;
    }
    setCurrentWeekMondayIso(choices[0]);
  }, [weekMondays, firstGridMonday, lastGridDay]);

  const currentWeekIndex = useMemo(
    () => Math.max(0, weekMondays.findIndex((d) => fmtISODate(d) === currentWeekMondayIso)),
    [weekMondays, currentWeekMondayIso]
  );

  const currentWeekMonday = useMemo(
    () => weekMondays[currentWeekIndex] || weekMondays[0] || firstGridMonday,
    [weekMondays, currentWeekIndex, firstGridMonday]
  );
  const currentWeekDays = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(currentWeekMonday, i)), [currentWeekMonday]);

  const loadMonthPlanning = useCallback(async () => {
    if (!userId) return;
    setLoadErr("");
    setLoadingRows(true);
    try {
      const { data: vw, error: e1 } = await supabase
        .from("view_week_assignments")
        .select("date, shift_code, seller_id, full_name")
        .gte("date", fmtISODate(firstGridMonday))
        .lte("date", fmtISODate(lastGridDay));

      let rows = [];
      if (!e1 && Array.isArray(vw)) {
        rows = vw;
      } else {
        const { data: sh, error: e2 } = await supabase
          .from("shifts")
          .select("date, shift_code, seller_id")
          .gte("date", fmtISODate(firstGridMonday))
          .lte("date", fmtISODate(lastGridDay));
        if (e2) throw e2;
        rows = sh || [];
      }

      const next = {};
      (rows || []).forEach((row) => {
        next[`${row.date}|${row.shift_code}`] = {
          seller_id: row.seller_id || null,
          full_name: row.full_name || null,
        };
      });
      setAssign(next);
    } catch (e) {
      setLoadErr(e?.message || "Impossible de charger l'historique du planning.");
      setAssign({});
    } finally {
      setLoadingRows(false);
    }
  }, [userId, firstGridMonday, lastGridDay]);

  useEffect(() => {
    loadMonthPlanning();
  }, [loadMonthPlanning]);

  const totalHours = useMemo(() => {
    let total = 0;
    Object.entries(assign || {}).forEach(([key, rec]) => {
      const [iso, code] = key.split("|");
      if (!iso || !code) return;
      if (iso < monthFrom || iso > monthTo) return;
      if (iso > todayIso) return;
      if ((rec?.seller_id || "") !== userId) return;
      total += Number(SHIFT_HOURS[code] || 0) || 0;
    });
    return total;
  }, [assign, monthFrom, monthTo, todayIso, userId]);

  const sellerColor = useMemo(() => colorForSeller(userId, displayName), [userId, displayName]);

  if (!authChecked) return <div className="p-4">Chargement...</div>;
  if (!userId) return <div className="p-4">Connexion requise…</div>;
  if (role === "admin" || role === "supervisor") return <div className="p-4">Redirection…</div>;

  return (
    <div className="p-4 max-w-[1800px] mx-auto space-y-6">
      <Head>
        <title>Historique du travail</title>
      </Head>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="hdr">Historique du travail</div>
          <div className="text-sm text-gray-600 mt-1">Vue mensuelle de vos créneaux selon le planning publié.</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn" onClick={() => r.push("/app")}>← Retour</button>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="hdr">{capFirst(monthLabel)}</div>
            <div className="text-sm text-gray-600 mt-1">Total du mois choisi en comptant seulement les jours déjà réellement travaillés.</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              className="input"
              type="month"
              value={monthInputValue(selectedMonth)}
              onChange={(e) => {
                const [y, m] = String(e.target.value || "").split("-");
                if (!y || !m) return;
                setSelectedMonth(new Date(Number(y), Number(m) - 1, 1));
              }}
            />
            <button className="btn" onClick={() => setSelectedMonth(firstDayOfMonth(new Date()))}>Mois en cours</button>
          </div>
        </div>

        <div className="mt-4 rounded-2xl p-4 border" style={{ borderColor: "#e5e7eb", backgroundColor: "#f8fafc" }}>
          <div className="text-sm text-gray-600">Total du mois choisi</div>
          <div className="text-2xl font-semibold mt-1">{fmtHours(totalHours)} h</div>
          <div className="mt-1 text-xs text-gray-500">Les jours futurs et les jours hors du mois choisi ne sont pas comptés dans ce total.</div>
          <div className="mt-2 text-sm flex items-center gap-2 flex-wrap">
            <span>Couleur utilisée :</span>
            <span style={{ backgroundColor: sellerColor, color: "#fff", borderRadius: 9999, padding: "2px 10px", fontSize: "0.8rem" }}>
              {displayName}
            </span>
          </div>
        </div>
      </div>

      {loadErr && <div className="card border-red-300 bg-red-50 text-red-700 text-sm">⚠️ {loadErr}</div>}

      <div className="card">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <div className="hdr">Semaine affichée</div>
            <div className="text-sm text-gray-600 mt-1">Le titre reste sur {capFirst(monthLabel)}. La semaine complète reste visible pour garder les repères.</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn"
              disabled={currentWeekIndex <= 0}
              onClick={() => {
                if (currentWeekIndex <= 0) return;
                setCurrentWeekMondayIso(fmtISODate(weekMondays[currentWeekIndex - 1]));
              }}
            >
              ← Semaine précédente
            </button>
            <div className="text-sm text-gray-600">
              {weekMondays.length ? `${currentWeekIndex + 1} / ${weekMondays.length}` : "0 / 0"}
            </div>
            <button
              className="btn"
              disabled={currentWeekIndex >= weekMondays.length - 1}
              onClick={() => {
                if (currentWeekIndex >= weekMondays.length - 1) return;
                setCurrentWeekMondayIso(fmtISODate(weekMondays[currentWeekIndex + 1]));
              }}
            >
              Semaine suivante →
            </button>
          </div>
        </div>

        <div className="text-sm text-gray-500 mb-3">
          Les jours du mois choisi restent normaux. Les jours d'un autre mois sont grisés pour garder la semaine complète sans confusion.
        </div>

        <div style={{ overflowX: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(210px, 1fr))",
              gap: 12,
              minWidth: "1554px",
              alignItems: "stretch",
            }}
          >
            {currentWeekDays.map((d) => {
              const iso = fmtISODate(d);
              const sunday = isSunday(d);
              const inSelectedMonth = iso >= monthFrom && iso <= monthTo;
              const dayBg = inSelectedMonth ? "#fff" : "#f8fafc";
              const dayBorder = inSelectedMonth ? "#e5e7eb" : "#dbe4ee";
              return (
                <div key={iso} className="border rounded-2xl p-3 space-y-3" style={{ borderColor: dayBorder, backgroundColor: dayBg, opacity: inSelectedMonth ? 1 : 0.72 }}>
                  <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                  <div className="font-semibold">{iso}</div>
                  {!inSelectedMonth ? <div className="text-xs text-gray-500">Hors {capFirst(monthLabel)}</div> : null}

                  {["MORNING", "MIDDAY", ...(sunday ? ["SUNDAY_EXTRA"] : []), "EVENING"].map((code) => {
                    const key = `${iso}|${code}`;
                    const rec = assign?.[key];
                    const mine = inSelectedMonth && (rec?.seller_id || "") === userId;
                    const bg = mine ? sellerColor : inSelectedMonth ? "#f3f4f6" : "#eef2f7";
                    const fg = mine ? "#fff" : "#6b7280";
                    const border = mine ? "transparent" : "#e5e7eb";
                    return (
                      <div
                        key={code}
                        className="rounded-2xl p-3"
                        style={{ backgroundColor: bg, color: fg, border: `1px solid ${border}` }}
                      >
                        <div className="text-sm font-medium">{SHIFT_LABELS[code] || code}</div>
                        <div className="mt-1 text-sm">{mine ? displayName : "—"}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {loadingRows && <div className="text-sm text-gray-600">Chargement de l'historique…</div>}
    </div>
  );
}
