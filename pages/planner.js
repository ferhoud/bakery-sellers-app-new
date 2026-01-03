/* eslint-disable react/no-unescaped-entities */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/useAuth";
import WeekNav from "@/components/WeekNav";
import { startOfWeek, addDays, fmtISODate, SHIFT_LABELS as BASE_LABELS } from "@/lib/date";

const SHIFT_LABELS = { ...BASE_LABELS, SUNDAY_EXTRA: "9h-13h30" };

const isSunday = (d) => d.getDay() === 0;
const weekdayFR = (d) => d.toLocaleDateString("fr-FR", { weekday: "long" });
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function isNamePlaceholder(name) {
  const n = String(name || "").trim();
  return !n || n === "-" || n === "—";
}

export default function PlannerPage() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  const [isPlanner, setIsPlanner] = useState(false);
  const [plannerChecked, setPlannerChecked] = useState(false);

  // Vérifier l'accès planificatrice (table planner_access)
  useEffect(() => {
    const run = async () => {
      if (!session?.user?.id) return;
      try {
        const { data, error } = await supabase
          .from("planner_access")
          .select("user_id")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (!error && data) setIsPlanner(true);
      } finally {
        setPlannerChecked(true);
      }
    };
    run();
  }, [session?.user?.id]);

  // Garde d'accès
  useEffect(() => {
    if (loading) return;
    if (!session) { r.replace("/login"); return; }
    if (!plannerChecked) return;

    const role = profile?.role || "seller";
    const allowed = role === "admin" || isPlanner;
    if (!allowed) r.replace("/app");
  }, [loading, session, plannerChecked, profile?.role, isPlanner, r]);

  // Semaine
  const [monday, setMonday] = useState(startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(monday, i)), [monday]);

  // Noms vendeuses (pour les listes + affichage)
  const [names, setNames] = useState({}); // user_id -> full_name
  const sellers = useMemo(() => {
    return Object.entries(names)
      .map(([user_id, full_name]) => ({ user_id, full_name: full_name || "" }))
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "fr"));
  }, [names]);

  const loadSellerNames = useCallback(async () => {
    try {
      // Recommandé : RPC dédiée (plus propre vis-à-vis RLS)
      const { data: rpcData, error: rpcErr } = await supabase.rpc("list_active_seller_names");
      let rows = null;

      if (!rpcErr && Array.isArray(rpcData)) {
        rows = rpcData;
      } else {
        // Fallback direct (si RLS l'autorise)
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
      console.warn("loadSellerNames failed:", e?.message || e);
    }
  }, []);

  useEffect(() => {
    if (!session?.user?.id) return;
    loadSellerNames();
  }, [session?.user?.id, loadSellerNames]);

  // Planning semaine
  const [assign, setAssign] = useState({});       // key -> seller_id
  const [assignNames, setAssignNames] = useState({}); // key -> full_name (si la vue le renvoie)

  const loadWeek = useCallback(async () => {
    const from = fmtISODate(days[0]);
    const to = fmtISODate(days[6]);

    // 1) Essayer la vue (pratique)
    const { data: vw, error: e1 } = await supabase
      .from("view_week_assignments")
      .select("date, shift_code, seller_id, full_name")
      .gte("date", from)
      .lte("date", to);

    if (!e1 && Array.isArray(vw)) {
      const next = {};
      const nextNames = {};
      vw.forEach((row) => {
        const k = `${row.date}|${row.shift_code}`;
        next[k] = row.seller_id || null;
        nextNames[k] = row.full_name || "";
      });
      setAssign(next);
      setAssignNames(nextNames);
      return;
    }

    // 2) Fallback : lire shifts directement
    const { data: sh, error: e2 } = await supabase
      .from("shifts")
      .select("date, shift_code, seller_id")
      .gte("date", from)
      .lte("date", to);

    if (e2) {
      console.error("loadWeek error:", e2);
      return;
    }

    const next = {};
    (sh || []).forEach((row) => {
      next[`${row.date}|${row.shift_code}`] = row.seller_id || null;
    });
    setAssign(next);
    setAssignNames({});
  }, [days]);

  useEffect(() => {
    if (!session?.user?.id) return;
    loadWeek();
  }, [session?.user?.id, monday, loadWeek]);

  const saveShift = useCallback(async (iso, code, seller_id) => {
    const key = `${iso}|${code}`;
    setAssign((prev) => ({ ...prev, [key]: seller_id || null })); // Optimistic UI

    const { error } = await supabase.rpc("planner_upsert_shift", {
      p_date: iso,
      p_code: code,
      p_seller: seller_id || null,
    });

    if (error) {
      console.error("planner_upsert_shift error:", error);
      alert(error.message || "Échec de sauvegarde du planning");
      await loadWeek(); // rollback
    }
  }, [loadWeek]);

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
    alert("Planning copié vers la semaine prochaine.");
  }, [days, assign, monday]);

  if (loading || !session || !plannerChecked) return <div className="p-4">Chargement…</div>;

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Planning (accès planificatrice)</div>
        <div className="flex gap-2">
          <button className="btn" onClick={copyWeekToNext}>Copier semaine → suivante</button>
          <button className="btn" onClick={() => supabase.auth.signOut().then(() => r.replace("/login"))}>Se déconnecter</button>
        </div>
      </div>

      <div className="card">
        <WeekNav
          monday={monday}
          onPrev={() => setMonday(addDays(monday, -7))}
          onToday={() => setMonday(startOfWeek(new Date()))}
          onNext={() => setMonday(addDays(monday, 7))}
        />

        <div className="grid grid-cols-1 md:grid-cols-7 gap-3 mt-4">
          {days.map((d) => {
            const iso = fmtISODate(d);
            const sunday = isSunday(d);

            return (
              <div key={iso} className="border rounded-2xl p-3 space-y-3">
                <div className="text-xs uppercase text-gray-500">{capFirst(weekdayFR(d))}</div>
                <div className="font-semibold">{iso}</div>

                {["MORNING", "MIDDAY", ...(sunday ? ["SUNDAY_EXTRA"] : []), "EVENING"].map((code) => {
                  const key = `${iso}|${code}`;
                  const label = SHIFT_LABELS[code] || code;
                  const currentSeller = assign[key] || "";

                  const viewName = assignNames[key];
                  const resolvedName =
                    !isNamePlaceholder(viewName)
                      ? viewName
                      : (currentSeller ? (names[currentSeller] || "") : "");

                  return (
                    <div key={code} className="rounded-2xl p-3 border">
                      <div className="text-sm mb-2">{label}</div>

                      <select
                        className="input"
                        value={currentSeller}
                        onChange={(e) => saveShift(iso, code, e.target.value || null)}
                      >
                        <option value="">— (aucune)</option>
                        {sellers.map((s) => (
                          <option key={s.user_id} value={s.user_id}>
                            {s.full_name || s.user_id.slice(0, 8)}
                          </option>
                        ))}
                      </select>

                      <div className="text-xs text-gray-500 mt-2">
                        {currentSeller ? `Actuel: ${resolvedName || "Vendeuse"} (${currentSeller.slice(0, 8)})` : "Non affecté"}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="text-sm text-gray-600">
        Cette page sert uniquement à gérer le planning. Les heures, absences et congés ne sont pas affichés ici.
      </div>
    </div>
  );
}
