/* eslint-disable react/no-unescaped-entities */

import Head from "next/head";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";

function currentMonthValue(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "—";
  try {
    return new Date(String(value)).toLocaleString("fr-FR");
  } catch (_) {
    return String(value);
  }
}

function humanBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function statusLabel(s) {
  const x = String(s || "").toLowerCase();
  if (x === "detected") return "À valider";
  if (x === "imported") return "Importé / découpé";
  if (x === "ignored") return "Ignoré";
  if (x === "error") return "Erreur";
  return x || "—";
}

function statusColor(s) {
  const x = String(s || "").toLowerCase();
  if (x === "detected") return "#f59e0b";
  if (x === "imported") return "#16a34a";
  if (x === "ignored") return "#6b7280";
  if (x === "error") return "#dc2626";
  return "#6b7280";
}

export default function AdminPayslipsReceivedPage() {
  const { session, profile, loading } = useAuth();

  const isAdmin = useMemo(() => {
    const email = session?.user?.email || "";
    return isAdminEmail(email) || String(profile?.role || "").toLowerCase() === "admin";
  }, [session?.user?.email, profile?.role]);

  const [month, setMonth] = useState(() => currentMonthValue());
  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [busyById, setBusyById] = useState({});
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (loading) return;
    if (!session && typeof window !== "undefined") {
      window.location.replace("/login?stay=1&next=/admin/payslips-received");
      return;
    }
    if (session && !isAdmin && typeof window !== "undefined") {
      window.location.replace("/app");
    }
  }, [loading, session, isAdmin]);

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || session?.access_token || "";
  }, [session?.access_token]);

  const loadRows = useCallback(async () => {
    if (!session || !isAdmin) return;
    setErr("");
    setLoadingRows(true);
    try {
      const token = await authToken();
      const qs = new URLSearchParams({ month });
      const resp = await fetch(`/api/admin/payslips/received/list?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) throw new Error(j?.error || `Erreur API (${resp.status})`);
      setRows(Array.isArray(j?.rows) ? j.rows : []);
    } catch (e) {
      setRows([]);
      setErr(e?.message || "Impossible de charger les fiches reçues.");
    } finally {
      setLoadingRows(false);
    }
  }, [session, isAdmin, authToken, month]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const scanNow = useCallback(async () => {
    setErr("");
    setMsg("");
    setScanBusy(true);
    try {
      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/received/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ month, max_messages: 40 }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) throw new Error(j?.error || `Erreur API (${resp.status})`);

      const found = Number(j?.found_candidates || 0) || 0;
      const saved = Number(j?.saved_candidates || 0) || 0;
      setMsg(found > 0 ? `Scan terminé : ${found} PDF candidat(s), ${saved} enregistré(s).` : "Scan terminé : aucun nouveau PDF candidat.");
      await loadRows();
    } catch (e) {
      setErr(e?.message || "Scan impossible.");
    } finally {
      setScanBusy(false);
    }
  }, [authToken, month, loadRows]);

  const importRow = useCallback(async (row) => {
    const id = String(row?.id || "");
    if (!id) return;

    if (typeof window !== "undefined") {
      const ok = window.confirm("Valider ce PDF et lancer l'import + découpage automatique ? Les fiches créées seront ensuite disponibles selon le fonctionnement actuel de la page Fiches de paie.");
      if (!ok) return;
    }

    setErr("");
    setMsg("");
    setBusyById((prev) => ({ ...(prev || {}), [id]: true }));

    try {
      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/received/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) throw new Error(j?.error || `Erreur API (${resp.status})`);

      setMsg(
        `Import terminé : ${Number(j?.analysis_count || 0) || 0} fiche(s) analysée(s), ${Number(j?.created_count || 0) || 0} PDF créé(s), ${Number(j?.skipped_count || 0) || 0} déjà présent(s).`
      );
      await loadRows();
    } catch (e) {
      setErr(e?.message || "Import impossible.");
    } finally {
      setBusyById((prev) => ({ ...(prev || {}), [id]: false }));
    }
  }, [authToken, loadRows]);

  const updateStatus = useCallback(async (row, status) => {
    const id = String(row?.id || "");
    if (!id) return;

    setErr("");
    setMsg("");
    setBusyById((prev) => ({ ...(prev || {}), [id]: true }));

    try {
      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/received/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, status }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) throw new Error(j?.error || `Erreur API (${resp.status})`);

      setMsg(status === "ignored" ? "PDF ignoré." : "PDF remis à valider.");
      await loadRows();
    } catch (e) {
      setErr(e?.message || "Mise à jour impossible.");
    } finally {
      setBusyById((prev) => ({ ...(prev || {}), [id]: false }));
    }
  }, [authToken, loadRows]);

  const detectedCount = rows.filter((r) => String(r?.status || "") === "detected").length;
  const importedCount = rows.filter((r) => String(r?.status || "") === "imported").length;

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-5">
      <Head>
        <title>Fiches reçues du comptable</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="hdr">Fiches reçues du comptable</div>
          <div className="text-sm text-gray-600">
            Le robot surveille Gmail après l’envoi du mail de paie. Tu valides avant l’import et le découpage.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin" className="btn">Retour admin</Link>
          <Link href="/admin/payslips" className="btn">Fiches de paie</Link>
          <Link href="/admin/payroll-email" className="btn">Mail comptable</Link>
        </div>
      </div>

      <div className="card space-y-3">
        <div className="grid md:grid-cols-[220px_1fr] gap-3 items-end">
          <div>
            <div className="text-sm mb-1">Mois de paie</div>
            <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn"
              onClick={scanNow}
              disabled={scanBusy}
              style={{ backgroundColor: scanBusy ? "#9ca3af" : "#2563eb", color: "#fff", borderColor: "transparent" }}
            >
              {scanBusy ? "Scan..." : "Scanner Gmail maintenant"}
            </button>

            <button type="button" className="btn" onClick={loadRows} disabled={loadingRows}>
              Rafraîchir
            </button>
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-2">
          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">À valider</div>
            <div className="text-xl font-semibold">{detectedCount}</div>
          </div>
          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">Importés / découpés</div>
            <div className="text-xl font-semibold">{importedCount}</div>
          </div>
          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">Total détecté</div>
            <div className="text-xl font-semibold">{rows.length}</div>
          </div>
        </div>

        {msg ? <div className="text-sm text-green-700">{msg}</div> : null}
        {err ? <div className="text-sm text-red-600">{err}</div> : null}
      </div>

      <div className="card space-y-3">
        <div className="hdr">PDF détectés</div>

        {loadingRows ? (
          <div className="text-sm text-gray-600">Chargement...</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-gray-600">Aucun PDF reçu détecté pour ce mois.</div>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => {
              const id = String(row?.id || "");
              const busy = !!busyById?.[id];
              const status = String(row?.status || "");

              return (
                <div key={id} className="border rounded-2xl p-3 space-y-2" style={{ borderColor: "#e5e7eb" }}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{row?.gmail_attachment_name || "PDF Gmail"}</div>
                      <div className="text-sm text-gray-600">
                        {row?.gmail_subject || "(Sans objet)"} · {row?.gmail_from || "Expéditeur inconnu"}
                      </div>
                      <div className="text-xs text-gray-500">
                        Reçu le {formatDateTime(row?.gmail_received_at)} · {humanBytes(row?.file_size)}
                      </div>
                      {row?.last_error ? <div className="text-xs text-red-600 mt-1">{row.last_error}</div> : null}
                    </div>

                    <span
                      className="text-xs px-2 py-1 rounded-full"
                      style={{ backgroundColor: statusColor(status), color: "#fff", fontWeight: 800 }}
                    >
                      {statusLabel(status)}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {status === "detected" || status === "error" ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => importRow(row)}
                        style={{ backgroundColor: busy ? "#9ca3af" : "#16a34a", color: "#fff", borderColor: "transparent" }}
                      >
                        {busy ? "Import..." : "Valider et découper"}
                      </button>
                    ) : null}

                    {status !== "ignored" && status !== "imported" ? (
                      <button type="button" className="btn" disabled={busy} onClick={() => updateStatus(row, "ignored")}>
                        Ignorer
                      </button>
                    ) : null}

                    {status === "ignored" ? (
                      <button type="button" className="btn" disabled={busy} onClick={() => updateStatus(row, "detected")}>
                        Remettre à valider
                      </button>
                    ) : null}

                    {row?.import_batch_id ? (
                      <Link href="/admin/payslips" className="btn">
                        Voir dans Fiches de paie
                      </Link>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
