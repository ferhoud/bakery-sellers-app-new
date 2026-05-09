import Head from "next/head";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";
import {
  SHIFT_TYPE_CODES,
  DEFAULT_SHIFT_TYPE_MAP,
  fetchShiftTypeVersionsClient,
  formatShiftDisplayLabel,
  hhmm,
  resolveEffectiveShiftMap,
  sortShiftTypeRows,
} from "@/lib/shift-type-config";

const CODE_TITLE = {
  MORNING: "Matin",
  MIDDAY: "Midi",
  EVENING: "Soir",
  SUNDAY_EXTRA: "Dimanche extra",
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function AdminShiftTypesPage() {
  const r = useRouter();
  const { session, profile, loading } = useAuth();

  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [drafts, setDrafts] = useState(() => {
    const base = {};
    SHIFT_TYPE_CODES.forEach((code) => {
      const d = DEFAULT_SHIFT_TYPE_MAP[code];
      base[code] = {
        start_time: hhmm(d.start_time),
        end_time: hhmm(d.end_time),
        active: d.active !== false,
      };
    });
    return base;
  });
  const [savingCode, setSavingCode] = useState("");
  const [deletingId, setDeletingId] = useState("");

  useEffect(() => {
    if (loading) return;
    if (!session) {
      r.replace("/login");
      return;
    }
    if (isAdminEmail(session.user?.email)) return;
    if (profile?.role !== "admin") r.replace("/app");
  }, [loading, session, profile, r]);

  const loadRows = useCallback(async () => {
    setLoadingRows(true);
    setLoadErr("");
    try {
      const { data, error } = await fetchShiftTypeVersionsClient(supabase);
      if (error) throw error;
      setRows(sortShiftTypeRows(data || []));
    } catch (e) {
      setRows([]);
      setLoadErr(e?.message || "Impossible de charger les plages horaires.");
    } finally {
      setLoadingRows(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && session) loadRows();
  }, [loading, session, loadRows]);

  const previewMap = useMemo(() => resolveEffectiveShiftMap(rows, effectiveFrom), [rows, effectiveFrom]);

  useEffect(() => {
    const next = {};
    SHIFT_TYPE_CODES.forEach((code) => {
      const cfg = previewMap[code] || DEFAULT_SHIFT_TYPE_MAP[code];
      next[code] = {
        start_time: hhmm(cfg.start_time),
        end_time: hhmm(cfg.end_time),
        active: cfg.active !== false,
      };
    });
    setDrafts(next);
  }, [effectiveFrom, previewMap]);

  const grouped = useMemo(() => {
    const out = {};
    SHIFT_TYPE_CODES.forEach((code) => {
      out[code] = rows.filter((r) => r.shift_code === code);
    });
    return out;
  }, [rows]);

  const saveCode = useCallback(async (code) => {
    if (!effectiveFrom) return;
    const draft = drafts[code];
    if (!draft?.start_time || !draft?.end_time) {
      alert("Indique l'heure de début et l'heure de fin.");
      return;
    }
    setSavingCode(code);
    try {
      const payload = {
        shift_code: code,
        start_time: draft.start_time,
        end_time: draft.end_time,
        effective_from: effectiveFrom,
        active: draft.active !== false,
        created_by: session?.user?.id || null,
      };

      const { error } = await supabase
        .from("shift_type_versions")
        .upsert(payload, { onConflict: "shift_code,effective_from" });
      if (error) throw error;
      await loadRows();
    } catch (e) {
      alert(e?.message || "Impossible d'enregistrer cette plage horaire.");
    } finally {
      setSavingCode("");
    }
  }, [drafts, effectiveFrom, loadRows, session]);

  const deleteRow = useCallback(async (id) => {
    if (!id) return;
    if (!window.confirm("Supprimer cette version de plage horaire ?")) return;
    setDeletingId(String(id));
    try {
      const { error } = await supabase.from("shift_type_versions").delete().eq("id", id);
      if (error) throw error;
      await loadRows();
    } catch (e) {
      alert(e?.message || "Impossible de supprimer cette version.");
    } finally {
      setDeletingId("");
    }
  }, [loadRows]);

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <Head>
        <title>Admin - Plages horaires</title>
      </Head>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="hdr">🕒 Plages horaires</div>
          <div className="text-sm text-gray-600 mt-1">
            V1 sécurisée: les codes restent fixes (Matin, Midi, Soir, Dimanche extra), mais l’admin peut changer les horaires avec une date d’effet.
          </div>
        </div>
        <Link href="/admin" legacyBehavior>
          <a className="btn">← Retour admin</a>
        </Link>
      </div>

      <div className="card space-y-3">
        <div className="font-semibold">Date d’effet du prochain changement</div>
        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3 items-center">
          <input className="input" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          <div className="text-sm text-gray-600">
            Tous les réglages enregistrés ci-dessous s’appliqueront à partir du <span className="font-medium">{effectiveFrom || "…"}</span>, sans modifier les heures du passé.
          </div>
        </div>
      </div>

      {loadErr ? <div className="card border-red-300 bg-red-50 text-red-700 text-sm">⚠️ {loadErr}</div> : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {SHIFT_TYPE_CODES.map((code) => {
          const cfg = previewMap[code] || DEFAULT_SHIFT_TYPE_MAP[code];
          const draft = drafts[code] || { start_time: hhmm(cfg.start_time), end_time: hhmm(cfg.end_time), active: cfg.active !== false };
          const busy = savingCode === code;
          return (
            <div key={code} className="card space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div className="font-semibold">{CODE_TITLE[code]}</div>
                  <div className="text-sm text-gray-600">Actuellement le {effectiveFrom}: {formatShiftDisplayLabel(code, cfg)}</div>
                </div>
                <span className="text-xs px-3 py-1 rounded-full" style={{ background: cfg.active !== false ? "#dcfce7" : "#fee2e2", color: cfg.active !== false ? "#166534" : "#991b1b" }}>
                  {cfg.active !== false ? "Active" : "Inactive"}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-sm mb-1">Début</div>
                  <input
                    className="input"
                    type="time"
                    step="60"
                    value={draft.start_time}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [code]: { ...prev[code], start_time: e.target.value } }))}
                  />
                </div>
                <div>
                  <div className="text-sm mb-1">Fin</div>
                  <input
                    className="input"
                    type="time"
                    step="60"
                    value={draft.end_time}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [code]: { ...prev[code], end_time: e.target.value } }))}
                  />
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.active !== false}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [code]: { ...prev[code], active: e.target.checked } }))}
                />
                Plage active à partir de cette date
              </label>

              <div>
                <button className="btn" disabled={busy} onClick={() => saveCode(code)}>
                  {busy ? "Enregistrement…" : "Enregistrer cette version"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card space-y-4">
        <div className="font-semibold">Historique des versions</div>
        <div className="text-sm text-gray-600">
          Tu peux garder plusieurs versions d’une même plage. L’app utilisera toujours la dernière version dont la date d’effet est antérieure ou égale au jour concerné.
        </div>

        {loadingRows ? (
          <div className="text-sm text-gray-600">Chargement…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune version enregistrée.</div>
        ) : (
          <div className="space-y-4">
            {SHIFT_TYPE_CODES.map((code) => (
              <div key={code} className="border rounded-2xl p-3" style={{ borderColor: "#e5e7eb" }}>
                <div className="font-medium mb-2">{CODE_TITLE[code]}</div>
                <div className="space-y-2">
                  {(grouped[code] || []).map((row) => {
                    const deleting = deletingId === String(row.id);
                    return (
                      <div key={row.id} className="flex items-center justify-between gap-3 flex-wrap border rounded-xl p-3" style={{ borderColor: "#e5e7eb" }}>
                        <div className="text-sm">
                          <div className="font-medium">À partir du {row.effective_from}</div>
                          <div className="text-gray-600">{formatShiftDisplayLabel(code, row)} · {row.active !== false ? "active" : "inactive"}</div>
                        </div>
                        <button className="btn" disabled={deleting} onClick={() => deleteRow(row.id)}>
                          {deleting ? "Suppression…" : "Supprimer"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
