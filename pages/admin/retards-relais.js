import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";
import { fmtISODate } from "@/lib/date";

const SELLER_COLOR_OVERRIDES = {
  antonia: "#e57373",
  olivia: "#64b5f6",
  colleen: "#81c784",
  ibtissam: "#ba68c8",
  charlene: "#f59e0b",
};

const normalize = (s) => String(s || "").trim().toLowerCase();
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
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function autoColorFromName(name) {
  const hue = hashStr(normalize(name)) % 360;
  return hslToHex(hue, 65, 50);
}
function colorForName(name) {
  if (!name || name === "-") return "#9e9e9e";
  return SELLER_COLOR_OVERRIDES[normalize(name)] || autoColorFromName(name);
}
function Chip({ name }) {
  if (!name) return <span className="text-sm text-gray-500">-</span>;
  return (
    <span
      style={{
        backgroundColor: colorForName(name),
        color: "#fff",
        borderRadius: 9999,
        padding: "2px 10px",
        fontSize: "0.8rem",
      }}
    >
      {name}
    </span>
  );
}
function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}
function hhmmss(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  return /^\d{1,2}:\d{2}$/.test(s) ? `${s}:00` : s;
}
function fmtDelta(mins) {
  const m = Number(mins || 0) || 0;
  if (m <= 0) return "0 min";
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${m} min`;
  return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`;
}
function extraWorkKindLabel(kind) {
  if (kind === "coverage") return "Couverture";
  if (kind === "relay") return "Relai";
  return "Travail en plus";
}
function relayRowKey(row) {
  return `${row?.work_date || ""}|${row?.late_seller_id || ""}|${row?.shift_code || "EVENING"}`;
}
function uniqueIds(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}
function SellerPicker({ sellers, value, onChange, placeholder = "Choisir une vendeuse" }) {
  return (
    <div className="space-y-2">
      <select
        className="input"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          minHeight: 42,
          background: "#fff",
          color: "#111827",
          border: "1px solid #d1d5db",
          borderRadius: 12,
          padding: "10px 12px",
          WebkitAppearance: "menulist",
          appearance: "menulist",
        }}
      >
        <option value="">- {placeholder} -</option>
        {(sellers || []).map((s) => (
          <option key={s.user_id} value={s.user_id}>
            {s.full_name}
          </option>
        ))}
      </select>
      {(sellers || []).length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {sellers.map((s) => {
            const active = value === s.user_id;
            return (
              <button
                key={s.user_id}
                type="button"
                onClick={() => onChange(s.user_id)}
                style={{
                  borderRadius: 9999,
                  border: active ? "2px solid #111827" : "1px solid #d1d5db",
                  background: active ? colorForName(s.full_name) : "#fff",
                  color: active ? "#fff" : "#111827",
                  padding: "6px 12px",
                  fontSize: "0.9rem",
                  cursor: "pointer",
                }}
              >
                {s.full_name}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="text-sm text-amber-700">Aucune vendeuse concernée pour cette date.</div>
      )}
    </div>
  );
}

export default function AdminRetardsRelaisPage({ initialSellers = [], initialDate = "", initialLateDate = "", initialExtraDate = "", initialExtraWorkRows = [], initialRecentExtraWorkRows = [] }) {
  const r = useRouter();
  const { session, profile, loading } = useAuth();

  const [lateDate, setLateDate] = useState(initialLateDate || initialDate || fmtISODate(new Date()));
  const [extraDate, setExtraDate] = useState(initialExtraDate || initialDate || fmtISODate(new Date()));

  const sellers = useMemo(() => (Array.isArray(initialSellers) ? initialSellers : []), [initialSellers]);
  const sellersById = useMemo(() => new Map((sellers || []).map((s) => [s.user_id, s])), [sellers]);
  const nameFromId = useCallback((id) => sellersById.get(id)?.full_name || "", [sellersById]);

  const [lateDayShiftRows, setLateDayShiftRows] = useState([]);
  const [extraDayShiftRows, setExtraDayShiftRows] = useState([]);
  const [lateDayLoading, setLateDayLoading] = useState(false);
  const [extraDayLoading, setExtraDayLoading] = useState(false);
  const [extraAllowOffPlanningSeller, setExtraAllowOffPlanningSeller] = useState(false);

  const [pendingRows, setPendingRows] = useState([]);
  const [resolvedRows, setResolvedRows] = useState([]);
  const [extraWorkRows, setExtraWorkRows] = useState(Array.isArray(initialExtraWorkRows) ? initialExtraWorkRows : []);
  const [coveringByKey, setCoveringByKey] = useState({});
  const [resolvingKey, setResolvingKey] = useState("");
  const [extraWorkSaving, setExtraWorkSaving] = useState(false);
  const [extraWorkDeletingId, setExtraWorkDeletingId] = useState("");
  const [recentExtraWorkRows, setRecentExtraWorkRows] = useState(Array.isArray(initialRecentExtraWorkRows) ? initialRecentExtraWorkRows : []);
  const [manualLateSaving, setManualLateSaving] = useState(false);

  const [manualLate, setManualLate] = useState({
    late_seller_id: "",
    planned_start_time: "13:30",
    actual_arrival_time: "",
    coverage_status: "not_covered",
    covering_seller_id: "",
    notes: "",
  });

  const [extraWorkForm, setExtraWorkForm] = useState({
    seller_id: "",
    start_time: "12:30",
    end_time: "13:30",
    kind: "manual_extra",
    reason: "Couverture absence matin",
    notes: "",
  });

  useEffect(() => {
    if (!r.isReady) return;
    const qDate = typeof r.query?.date === "string" ? r.query.date : "";
    const qLateDate = typeof r.query?.lateDate === "string" ? r.query.lateDate : "";
    const qExtraDate = typeof r.query?.extraDate === "string" ? r.query.extraDate : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(qLateDate)) setLateDate(qLateDate);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(qDate)) setLateDate(qDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(qExtraDate)) setExtraDate(qExtraDate);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(qDate)) setExtraDate(qDate);
  }, [r.isReady, r.query]);

  useEffect(() => {
    setExtraWorkRows(Array.isArray(initialExtraWorkRows) ? initialExtraWorkRows : []);
  }, [initialExtraWorkRows]);

  useEffect(() => {
    setRecentExtraWorkRows(Array.isArray(initialRecentExtraWorkRows) ? initialRecentExtraWorkRows : []);
  }, [initialRecentExtraWorkRows]);

  const refreshExtraWorkView = useCallback(
    async (nextExtraDate = extraDate, nextLateDate = lateDate) => {
      const query = {
        ...(nextLateDate ? { lateDate: nextLateDate } : {}),
        ...(nextExtraDate ? { extraDate: nextExtraDate } : {}),
      };
      await r.replace({ pathname: "/admin/retards-relais", query }, undefined, { shallow: false, scroll: false });
    },
    [r, extraDate, lateDate]
  );

  useEffect(() => {
    if (loading) return;
    if (!session) {
      r.replace("/login");
      return;
    }
    if (isAdminEmail(session.user?.email)) return;
    if (profile?.role !== "admin") r.replace("/app");
  }, [loading, profile, r, session]);

  const mapRowsToSellers = useCallback(
    (rows) =>
      uniqueIds(rows.map((row) => row?.seller_id))
        .map((id) => sellersById.get(id))
        .filter(Boolean),
    [sellersById]
  );

  const lateWorkedSellers = useMemo(() => mapRowsToSellers(lateDayShiftRows), [lateDayShiftRows, mapRowsToSellers]);
  const extraWorkedSellers = useMemo(() => mapRowsToSellers(extraDayShiftRows), [extraDayShiftRows, mapRowsToSellers]);
  const extraSellerOptions = useMemo(() => {
    return extraAllowOffPlanningSeller ? sellers : extraWorkedSellers;
  }, [extraAllowOffPlanningSeller, sellers, extraWorkedSellers]);
  const lateSellerOptions = useMemo(() => {
    const evening = mapRowsToSellers(lateDayShiftRows.filter((row) => row.shift_code === "EVENING"));
    return evening.length ? evening : lateWorkedSellers;
  }, [lateDayShiftRows, lateWorkedSellers, mapRowsToSellers]);
  const coveringSellerOptions = useMemo(() => {
    const cover = mapRowsToSellers(lateDayShiftRows.filter((row) => row.shift_code === "MORNING" || row.shift_code === "MIDDAY"));
    return cover.length ? cover : lateWorkedSellers;
  }, [lateDayShiftRows, lateWorkedSellers, mapRowsToSellers]);

  const loadShiftRowsForDate = useCallback(async (dateIso, setter, setLoading) => {
    if (!dateIso) {
      setter([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/late-relays/day-sellers?date=${encodeURIComponent(dateIso)}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Erreur API (${res.status})`);
      setter(Array.isArray(json?.rows) ? json.rows : []);
    } catch (e) {
      console.warn("loadShiftRowsForDate error", dateIso, e?.message || e);
      setter([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadShiftRowsForDate(lateDate, setLateDayShiftRows, setLateDayLoading);
  }, [lateDate, loadShiftRowsForDate]);

  useEffect(() => {
    loadShiftRowsForDate(extraDate, setExtraDayShiftRows, setExtraDayLoading);
  }, [extraDate, loadShiftRowsForDate]);

  useEffect(() => {
    if (!manualLate.late_seller_id || !lateSellerOptions.some((s) => s.user_id === manualLate.late_seller_id)) {
      setManualLate((prev) => ({ ...prev, late_seller_id: lateSellerOptions[0]?.user_id || "" }));
    }
  }, [lateSellerOptions]);

  useEffect(() => {
    if (manualLate.coverage_status !== "covered") return;
    if (!manualLate.covering_seller_id || !coveringSellerOptions.some((s) => s.user_id === manualLate.covering_seller_id)) {
      setManualLate((prev) => ({ ...prev, covering_seller_id: coveringSellerOptions[0]?.user_id || "" }));
    }
  }, [coveringSellerOptions, manualLate.coverage_status]);

  useEffect(() => {
    if (!extraWorkForm.seller_id || !extraSellerOptions.some((s) => s.user_id === extraWorkForm.seller_id)) {
      setExtraWorkForm((prev) => ({ ...prev, seller_id: extraSellerOptions[0]?.user_id || "" }));
    }
  }, [extraSellerOptions, extraWorkForm.seller_id]);

  const loadPendingRows = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("admin_list_unresolved_late_relays", {
        p_from: lateDate,
        p_to: lateDate,
      });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      setPendingRows(rows);
      setCoveringByKey((prev) => {
        const next = { ...prev };
        rows.forEach((row) => {
          const key = relayRowKey(row);
          if (!next[key] && row.suggested_covering_seller_id) next[key] = row.suggested_covering_seller_id;
        });
        return next;
      });
    } catch (e) {
      console.warn("loadPendingRows error", e?.message || e);
      setPendingRows([]);
    }
  }, [lateDate]);

  const loadResolvedRows = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("late_arrival_resolutions")
        .select(
          "id, work_date, late_seller_id, shift_code, planned_start_time, actual_arrival_time, late_minutes, coverage_status, covering_seller_id, coverage_minutes, notes, created_at"
        )
        .eq("work_date", lateDate)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setResolvedRows(data || []);
    } catch (e) {
      console.warn("loadResolvedRows error", e?.message || e);
      setResolvedRows([]);
    }
  }, [lateDate]);

  const loadExtraWorkRows = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("extra_work_entries")
        .select("id, work_date, seller_id, start_time, end_time, minutes, kind, reason, notes, linked_resolution_id, created_at")
        .eq("work_date", extraDate)
        .order("start_time", { ascending: true });
      if (error) throw error;
      setExtraWorkRows(data || []);
    } catch (e) {
      console.warn("loadExtraWorkRows error", e?.message || e);
      setExtraWorkRows([]);
    }
  }, [extraDate]);

  useEffect(() => {
    if (!loading && session) {
      loadPendingRows();
      loadResolvedRows();
    }
  }, [loading, session, loadPendingRows, loadResolvedRows]);

  useEffect(() => {
    if (!loading && session) loadExtraWorkRows();
  }, [loading, session, loadExtraWorkRows]);

  const resolveDetected = useCallback(
    async (row, mode) => {
      const key = relayRowKey(row);
      const coveringSellerId = coveringByKey[key] || "";
      if (mode === "covered" && !coveringSellerId) {
        alert("Choisis la vendeuse qui a couvert.");
        return;
      }
      setResolvingKey(key);
      try {
        const { error } = await supabase.rpc("admin_resolve_late_arrival_coverage", {
          p_work_date: row.work_date,
          p_late_seller_id: row.late_seller_id,
          p_shift_code: row.shift_code || "EVENING",
          p_planned_start_time: row.planned_start_time || "13:30:00",
          p_actual_arrival_time: row.actual_arrival_time,
          p_late_minutes: row.late_minutes,
          p_coverage_status: mode,
          p_covering_seller_id: mode === "covered" ? coveringSellerId : null,
          p_coverage_start_time: mode === "covered" ? row.planned_start_time || "13:30:00" : null,
          p_coverage_end_time: mode === "covered" ? row.actual_arrival_time : null,
          p_reason: mode === "covered" ? "Couverture validée" : mode === "dismissed" ? "Ignoré par l'admin" : "Pas de couverture",
          p_notes:
            mode === "covered"
              ? "Couverture validée depuis la page retards / relais"
              : mode === "dismissed"
              ? "Ignoré par l'admin"
              : "Aucune couverture déclarée",
          p_created_by: session?.user?.id || null,
        });
        if (error) throw error;
        await Promise.all([loadPendingRows(), loadResolvedRows()]);
        await refreshExtraWorkView(extraDate, lateDate);
      } catch (e) {
        alert(e?.message || "Impossible d'enregistrer la décision.");
      } finally {
        setResolvingKey("");
      }
    },
    [coveringByKey, extraDate, lateDate, refreshExtraWorkView, loadPendingRows, loadResolvedRows, session]
  );

  const saveManualLate = useCallback(async () => {
    if (manualLateSaving) return;
    const lateSellerId = manualLate.late_seller_id || "";
    const planned = manualLate.planned_start_time || "13:30";
    const actual = manualLate.actual_arrival_time || "";
    const status = manualLate.coverage_status || "not_covered";
    const coveringSellerId = manualLate.covering_seller_id || "";
    const lateMin = (() => {
      const p = parseHHMM(planned);
      const a = parseHHMM(actual);
      if (p == null || a == null) return 0;
      return Math.max(0, a - p);
    })();

    if (!lateDate || !lateSellerId || !actual || lateMin <= 0) {
      alert("Remplis correctement la date, la vendeuse en retard et l'heure réelle d'arrivée.");
      return;
    }
    if (status === "covered" && !coveringSellerId) {
      alert("Choisis la vendeuse qui a couvert.");
      return;
    }

    setManualLateSaving(true);
    try {
      const { error } = await supabase.rpc("admin_resolve_late_arrival_coverage", {
        p_work_date: lateDate,
        p_late_seller_id: lateSellerId,
        p_shift_code: "EVENING",
        p_planned_start_time: hhmmss(planned),
        p_actual_arrival_time: hhmmss(actual),
        p_late_minutes: lateMin,
        p_coverage_status: status,
        p_covering_seller_id: status === "covered" ? coveringSellerId : null,
        p_coverage_start_time: status === "covered" ? hhmmss(planned) : null,
        p_coverage_end_time: status === "covered" ? hhmmss(actual) : null,
        p_reason: "Saisie manuelle admin",
        p_notes: manualLate.notes || "Saisie manuelle admin",
        p_created_by: session?.user?.id || null,
      });
      if (error) throw error;
      setManualLate((prev) => ({ ...prev, actual_arrival_time: "", notes: "" }));
      await Promise.all([loadPendingRows(), loadResolvedRows()]);
        await refreshExtraWorkView(extraDate, lateDate);
    } catch (e) {
      alert(e?.message || "Impossible d'enregistrer le retard / relai.");
    } finally {
      setManualLateSaving(false);
    }
  }, [extraDate, lateDate, refreshExtraWorkView, loadPendingRows, loadResolvedRows, manualLate, manualLateSaving, session]);

  const saveExtraWork = useCallback(async () => {
    if (extraWorkSaving) return;
    const sellerId = extraWorkForm.seller_id || "";
    const startTime = extraWorkForm.start_time || "";
    const endTime = extraWorkForm.end_time || "";
    const startMin = parseHHMM(startTime);
    const endMin = parseHHMM(endTime);
    if (!extraDate || !sellerId || startMin == null || endMin == null || endMin <= startMin) {
      alert("Remplis correctement la date, la vendeuse et la plage horaire.");
      return;
    }

    setExtraWorkSaving(true);
    try {
      const { error } = await supabase.rpc("admin_create_extra_work_entry", {
        p_work_date: extraDate,
        p_seller_id: sellerId,
        p_start_time: hhmmss(startTime),
        p_end_time: hhmmss(endTime),
        p_kind: extraWorkForm.kind || "manual_extra",
        p_reason: extraWorkForm.reason || "Travail en plus",
        p_notes: extraWorkForm.notes || "",
        p_source: "ADMIN_PAGE",
        p_created_by: session?.user?.id || null,
      });
      if (error) throw error;
      setExtraWorkForm((prev) => ({ ...prev, notes: "" }));
      await refreshExtraWorkView(extraDate, lateDate);
    } catch (e) {
      alert(e?.message || "Impossible d'enregistrer le travail en plus.");
    } finally {
      setExtraWorkSaving(false);
    }
  }, [extraDate, extraWorkForm, extraWorkSaving, lateDate, refreshExtraWorkView, session]);

  const deleteExtraWork = useCallback(
    async (id) => {
      if (!id || extraWorkDeletingId) return;
      setExtraWorkDeletingId(id);
      try {
        const { error } = await supabase.rpc("admin_delete_extra_work_entry", { p_id: id });
        if (error) throw error;
        await refreshExtraWorkView(extraDate, lateDate);
      } catch (e) {
        alert(e?.message || "Impossible de supprimer l'entrée.");
      } finally {
        setExtraWorkDeletingId("");
      }
    },
    [extraWorkDeletingId, loadExtraWorkRows]
  );

  return (
    <>
      <Head>
        <title>Admin - Retards / relais</title>
      </Head>

      <div className="p-3 max-w-6xl mx-auto space-y-5">
        <div className="card">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-xl font-semibold">⏱️ Retards / relais et travail en plus</div>
              <div className="text-sm text-gray-600 mt-1">
                Page dédiée avec deux traitements séparés. Chaque bloc a sa propre date et ne montre que les vendeuses concernées ce jour-là.
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Link href="/admin" legacyBehavior>
                <a className="btn">← Retour admin</a>
              </Link>
            </div>
          </div>

          <div className="mt-4 text-sm text-gray-600">
            Vendeuses connues: <span className="font-medium">{sellers.length}</span>
          </div>
          {sellers.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {sellers.map((s) => (
                <Chip key={s.user_id} name={s.full_name} />
              ))}
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <div className="card space-y-4">
            <div className="hdr">Retard / relai</div>
            <div className="text-sm text-gray-600">
              Ce bloc sert aux retards du shift <span className="font-medium">13h30</span>. La date est indépendante du bloc travail en plus.
            </div>

            <div className="border rounded-2xl p-4" style={{ borderColor: "#e5e7eb" }}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
                <div>
                  <div className="text-sm mb-1">Date retard / relai</div>
                  <input className="input" type="date" value={lateDate} onChange={async (e) => { const v = e.target.value; setLateDate(v); await refreshExtraWorkView(extraDate, v); }} />
                </div>
                <div className="text-sm text-gray-600">
                  {lateDayLoading ? "Chargement des vendeuses du jour…" : `Vendeuses concernées ce jour: ${lateWorkedSellers.length}`}
                </div>
              </div>
              {lateWorkedSellers.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {lateWorkedSellers.map((s) => (
                    <Chip key={s.user_id} name={s.full_name} />
                  ))}
                </div>
              ) : (
                <div className="mt-3 text-sm text-amber-700">Aucune vendeuse planifiée trouvée pour cette date.</div>
              )}
            </div>

            <div className="border rounded-2xl p-4" style={{ borderColor: "#e5e7eb" }}>
              <div className="font-semibold mb-2">Retards détectés à traiter</div>
              {pendingRows.length === 0 ? (
                <div className="text-sm text-gray-600">Aucun retard après-midi à traiter pour cette date.</div>
              ) : (
                <div className="space-y-3">
                  {pendingRows.map((row) => {
                    const key = relayRowKey(row);
                    const lateName = nameFromId(row.late_seller_id);
                    const selectedCover = coveringByKey[key] || row.suggested_covering_seller_id || "";
                    const disabled = resolvingKey === key;
                    return (
                      <div key={key} className="border rounded-2xl p-3" style={{ borderColor: "#e5e7eb" }}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip name={lateName} />
                          <span className="text-sm text-gray-700">
                            retard de <span className="font-medium text-red-700">{fmtDelta(row.late_minutes)}</span>
                          </span>
                          <span className="text-sm text-gray-500">· prévue 13h30 · arrivée {String(row.actual_arrival_time || "").slice(0, 5)}</span>
                        </div>

                        <div className="mt-3">
                          <div className="text-sm mb-1">Qui a couvert entre 13h30 et l'arrivée réelle ?</div>
                          <SellerPicker
                            sellers={coveringSellerOptions}
                            value={selectedCover}
                            onChange={(v) => setCoveringByKey((prev) => ({ ...prev, [key]: v }))}
                            placeholder="Choisir la vendeuse qui a couvert"
                          />
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" className="btn" disabled={disabled} onClick={() => resolveDetected(row, "covered")}>
                            ✅ Couverture validée
                          </button>
                          <button type="button" className="btn" disabled={disabled} onClick={() => resolveDetected(row, "not_covered")}>
                            ❌ Pas de couverture
                          </button>
                          <button type="button" className="btn" disabled={disabled} onClick={() => resolveDetected(row, "dismissed")}>
                            Ignorer
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border rounded-2xl p-4" style={{ borderColor: "#e5e7eb" }}>
              <div className="font-semibold mb-2">Saisie manuelle d'un retard / relai</div>
              <div className="text-sm text-gray-600 mb-3">À utiliser si la vendeuse a oublié de se pointer et que tu veux corriger après.</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-sm mb-1">Vendeuse en retard</div>
                  <SellerPicker
                    sellers={lateSellerOptions}
                    value={manualLate.late_seller_id}
                    onChange={(v) => setManualLate((prev) => ({ ...prev, late_seller_id: v }))}
                    placeholder="Choisir la vendeuse en retard"
                  />
                </div>
                <div>
                  <div className="text-sm mb-1">Heure prévue</div>
                  <input className="input" type="time" step="60" value={manualLate.planned_start_time} onChange={(e) => setManualLate((prev) => ({ ...prev, planned_start_time: e.target.value }))} />
                </div>
                <div>
                  <div className="text-sm mb-1">Heure réelle d'arrivée</div>
                  <input className="input" type="time" step="60" value={manualLate.actual_arrival_time} onChange={(e) => setManualLate((prev) => ({ ...prev, actual_arrival_time: e.target.value }))} />
                </div>
                <div>
                  <div className="text-sm mb-1">Couverture ?</div>
                  <select className="select" value={manualLate.coverage_status} onChange={(e) => setManualLate((prev) => ({ ...prev, coverage_status: e.target.value }))}>
                    <option value="not_covered">Pas de couverture</option>
                    <option value="covered">Oui, une vendeuse a couvert</option>
                    <option value="dismissed">Ignorer</option>
                  </select>
                </div>
                {manualLate.coverage_status === "covered" ? (
                  <div className="md:col-span-2">
                    <div className="text-sm mb-1">Vendeuse qui a couvert</div>
                    <SellerPicker
                      sellers={coveringSellerOptions}
                      value={manualLate.covering_seller_id}
                      onChange={(v) => setManualLate((prev) => ({ ...prev, covering_seller_id: v }))}
                      placeholder="Choisir la vendeuse qui a couvert"
                    />
                  </div>
                ) : null}
                <div className="md:col-span-2">
                  <div className="text-sm mb-1">Note</div>
                  <input className="input" value={manualLate.notes} onChange={(e) => setManualLate((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Ex: vendeuse oubli de pointage" />
                </div>
              </div>
              <div className="mt-3">
                <button type="button" className="btn" disabled={manualLateSaving} onClick={saveManualLate}>
                  {manualLateSaving ? "Enregistrement…" : "Enregistrer le retard / relai"}
                </button>
              </div>
            </div>

            <div className="border rounded-2xl p-4" style={{ borderColor: "#e5e7eb" }}>
              <div className="font-semibold mb-2">Décisions enregistrées pour cette date</div>
              {resolvedRows.length === 0 ? (
                <div className="text-sm text-gray-600">Aucune décision enregistrée pour cette date.</div>
              ) : (
                <div className="space-y-2">
                  {resolvedRows.map((row) => (
                    <div key={row.id} className="border rounded-xl p-3" style={{ borderColor: "#e5e7eb" }}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip name={nameFromId(row.late_seller_id)} />
                        <span className="text-sm text-gray-700">retard {fmtDelta(row.late_minutes)}</span>
                        <span className="text-sm text-gray-500">· arrivée {String(row.actual_arrival_time || "").slice(0, 5)}</span>
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        Statut:{" "}
                        <span className="font-medium">
                          {row.coverage_status === "covered" ? "Couverture validée" : row.coverage_status === "dismissed" ? "Ignoré" : "Pas de couverture"}
                        </span>
                        {row.covering_seller_id ? (
                          <>
                            {" "}· Couverture: <Chip name={nameFromId(row.covering_seller_id)} />
                            {row.coverage_minutes ? <span> · +{fmtDelta(row.coverage_minutes)}</span> : null}
                          </>
                        ) : null}
                      </div>
                      {row.notes ? <div className="text-sm text-gray-500 mt-1">{row.notes}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card space-y-4">
            <div className="hdr">Travail en plus</div>
            <div className="text-sm text-gray-600">
              Ce bloc sert uniquement au travail en plus manuel: arrivée plus tôt, couverture exceptionnelle, temps supplémentaire validé par l'admin. Tu peux aussi activer un mode renfort exceptionnel pour choisir une vendeuse hors planning.
            </div>

            <div className="border rounded-2xl p-4" style={{ borderColor: "#e5e7eb" }}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
                <div>
                  <div className="text-sm mb-1">Date travail en plus</div>
                  <input className="input" type="date" value={extraDate} onChange={async (e) => { const v = e.target.value; setExtraDate(v); await refreshExtraWorkView(v, lateDate); }} />
                </div>
                <div className="text-sm text-gray-600">
                  {extraDayLoading
                    ? "Chargement des vendeuses du jour…"
                    : extraAllowOffPlanningSeller
                    ? `Mode renfort exceptionnel activé · ${sellers.length} vendeuse(s) disponible(s)`
                    : `Vendeuses concernées ce jour: ${extraWorkedSellers.length}`}
                </div>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={extraAllowOffPlanningSeller}
                  onChange={(e) => setExtraAllowOffPlanningSeller(e.target.checked)}
                />
                Renfort exceptionnel / vendeuse hors planning
              </label>
              <div className="text-xs text-gray-500">
                Décoche pour limiter la liste aux vendeuses planifiées ce jour-là. Coche pour choisir n'importe quelle vendeuse active.
              </div>
              {extraAllowOffPlanningSeller ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {sellers.map((s) => (
                    <Chip key={s.user_id} name={s.full_name} />
                  ))}
                </div>
              ) : extraWorkedSellers.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {extraWorkedSellers.map((s) => (
                    <Chip key={s.user_id} name={s.full_name} />
                  ))}
                </div>
              ) : (
                <div className="mt-3 text-sm text-amber-700">Aucune vendeuse planifiée trouvée pour cette date. Active le mode renfort exceptionnel pour choisir une vendeuse hors planning.</div>
              )}
            </div>

            <div className="border rounded-2xl p-4" style={{ borderColor: "#e5e7eb" }}>
              <div className="font-semibold mb-2">Ajouter un travail en plus</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-sm mb-1">Vendeuse</div>
                  <SellerPicker
                    sellers={extraSellerOptions}
                    value={extraWorkForm.seller_id}
                    onChange={(v) => setExtraWorkForm((prev) => ({ ...prev, seller_id: v }))}
                    placeholder={extraAllowOffPlanningSeller ? "Choisir une vendeuse (même hors planning)" : "Choisir la vendeuse"}
                  />
                </div>
                <div>
                  <div className="text-sm mb-1">Type</div>
                  <select className="select" value={extraWorkForm.kind} onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, kind: e.target.value }))}>
                    <option value="manual_extra">Travail en plus</option>
                    <option value="coverage">Couverture</option>
                    <option value="relay">Relai</option>
                  </select>
                </div>
                <div>
                  <div className="text-sm mb-1">Début</div>
                  <input className="input" type="time" step="60" value={extraWorkForm.start_time} onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, start_time: e.target.value }))} />
                </div>
                <div>
                  <div className="text-sm mb-1">Fin</div>
                  <input className="input" type="time" step="60" value={extraWorkForm.end_time} onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, end_time: e.target.value }))} />
                </div>
                <div className="md:col-span-2">
                  <div className="text-sm mb-1">Motif</div>
                  <input className="input" value={extraWorkForm.reason} onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, reason: e.target.value }))} />
                </div>
                <div className="md:col-span-2">
                  <div className="text-sm mb-1">Note</div>
                  <input className="input" value={extraWorkForm.notes} onChange={(e) => setExtraWorkForm((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Ex: venue à 12h34 au lieu de 13h30" />
                </div>
              </div>
              <div className="mt-3">
                <button type="button" className="btn" disabled={extraWorkSaving} onClick={saveExtraWork}>
                  {extraWorkSaving ? "Enregistrement…" : "Enregistrer le travail en plus"}
                </button>
              </div>
            </div>

            <div className="border rounded-2xl p-4" style={{ borderColor: "#e5e7eb" }}>
              <div className="font-semibold mb-2">Entrées de travail en plus pour cette date</div>
              {extraWorkRows.length === 0 ? (
                <div className="text-sm text-gray-600">Aucune entrée de travail en plus pour cette date.</div>
              ) : (
                <div className="space-y-2">
                  {extraWorkRows.map((row) => (
                    <div key={row.id} className="border rounded-xl p-3 flex flex-col gap-2" style={{ borderColor: "#e5e7eb" }}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip name={nameFromId(row.seller_id)} />
                          <span className="text-sm text-gray-700">{extraWorkKindLabel(row.kind)}</span>
                          <span className="text-sm text-gray-500">· {String(row.start_time || "").slice(0, 5)} → {String(row.end_time || "").slice(0, 5)} · +{fmtDelta(row.minutes)}</span>
                        </div>
                        {row.linked_resolution_id ? (
                          <span className="text-xs text-gray-500">lié à un retard / relai</span>
                        ) : (
                          <button type="button" className="btn" disabled={extraWorkDeletingId === row.id} onClick={() => deleteExtraWork(row.id)}>
                            Supprimer
                          </button>
                        )}
                      </div>
                      <div className="text-sm text-gray-600">{row.reason || "Travail en plus"}</div>
                      {row.notes ? <div className="text-sm text-gray-500">{row.notes}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export async function getServerSideProps(ctx) {
  const qDate = typeof ctx?.query?.date === "string" ? ctx.query.date : "";
  const qLateDate = typeof ctx?.query?.lateDate === "string" ? ctx.query.lateDate : "";
  const qExtraDate = typeof ctx?.query?.extraDate === "string" ? ctx.query.extraDate : "";
  const fallbackDate = new Date().toISOString().slice(0, 10);
  const initialDate = /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : fallbackDate;
  const initialLateDate = /^\d{4}-\d{2}-\d{2}$/.test(qLateDate) ? qLateDate : initialDate;
  const initialExtraDate = /^\d{4}-\d{2}-\d{2}$/.test(qExtraDate) ? qExtraDate : initialDate;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || process.env.SERVICE_ROLE_KEY || "";

  let initialSellers = [];
  let initialExtraWorkRows = [];
  let initialRecentExtraWorkRows = [];

  if (url && serviceKey) {
    try {
      const admin = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      let rows = [];
      try {
        const { data, error } = await admin.rpc("list_sellers");
        if (!error && Array.isArray(data) && data.length) rows = data;
      } catch {}

      if (!rows.length) {
        try {
          const { data, error } = await admin
            .from("profiles")
            .select("user_id, full_name, role, active")
            .eq("role", "seller")
            .order("full_name", { ascending: true });
          if (!error && Array.isArray(data) && data.length) rows = data;
        } catch {}
      }

      if (!rows.length) {
        try {
          const { data, error } = await admin
            .from("sellers")
            .select("id, full_name, is_active")
            .eq("is_active", true)
            .order("full_name", { ascending: true });
          if (!error && Array.isArray(data) && data.length) rows = data;
        } catch {}
      }

      initialSellers = (rows || [])
        .map((r) => ({
          user_id: r?.user_id || r?.id || r?.seller_id || "",
          full_name: r?.full_name || r?.name || r?.seller_name || "",
        }))
        .filter((r) => r.user_id && r.full_name)
        .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name), "fr", { sensitivity: "base" }));

      try {
        const { data: extraRows, error: extraErr } = await admin
          .from("extra_work_entries")
          .select("id, work_date, seller_id, start_time, end_time, minutes, kind, reason, notes, linked_resolution_id, created_at")
          .eq("work_date", initialExtraDate)
          .order("start_time", { ascending: true });
        if (!extraErr && Array.isArray(extraRows)) initialExtraWorkRows = extraRows;
      } catch {}

      try {
        const { data: recentRows, error: recentErr } = await admin
          .from("extra_work_entries")
          .select("id, work_date, seller_id, start_time, end_time, minutes, kind, reason, notes, linked_resolution_id, created_at")
          .order("created_at", { ascending: false })
          .limit(12);
        if (!recentErr && Array.isArray(recentRows)) initialRecentExtraWorkRows = recentRows;
      } catch {}
    } catch {}
  }

  return {
    props: {
      initialDate,
      initialLateDate,
      initialExtraDate,
      initialSellers,
      initialExtraWorkRows,
      initialRecentExtraWorkRows,
    },
  };
}
