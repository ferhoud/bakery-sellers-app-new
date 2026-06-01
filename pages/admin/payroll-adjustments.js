/* eslint-disable react/no-unescaped-entities */

import Head from "next/head";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

function monthInputValue(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function numInputValue(value) {
  if (value === null || value === undefined) return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 100) / 100);
}

function parseNum(value) {
  if (value === "" || value == null) return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function fmtHours(value) {
  const n = Number(value || 0);
  return `${n.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} h`;
}

function fmtEuro(value) {
  const n = Number(value || 0);
  return `${n.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

function statusLabel(status) {
  const s = String(status || "");
  if (s === "validated") return "Validé";
  if (s === "paid") return "Payé";
  return "À vérifier";
}

function statusColor(status) {
  const s = String(status || "");
  if (s === "paid") return "#16a34a";
  if (s === "validated") return "#2563eb";
  return "#f59e0b";
}

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data?.session?.access_token || "";
}

export default function PayrollAdjustmentsPage() {
  const [month, setMonth] = useState(() => monthInputValue());
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [debugCounts, setDebugCounts] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [loadingRows, setLoadingRows] = useState(false);
  const [savingBySeller, setSavingBySeller] = useState({});
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [lastApiStatus, setLastApiStatus] = useState("");

  const loadPreview = useCallback(async () => {
    setErr("");
    setMsg("");
    setLoadingRows(true);
    setLastApiStatus("Appel API en cours...");

    try {
      const token = await getAccessToken();

      if (!token) {
        setLastApiStatus("Session absente");
        if (typeof window !== "undefined") {
          window.location.replace("/login?stay=1&next=/admin/payroll-adjustments");
        }
        return;
      }

      const qs = new URLSearchParams({ month });
      const resp = await fetch(`/api/admin/payroll-adjustments/preview?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      const j = await resp.json().catch(() => ({}));
      setLastApiStatus(`API ${resp.status} · ${new Date().toLocaleTimeString("fr-FR")}`);

      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }

      const nextRows = Array.isArray(j?.rows) ? j.rows : [];
      setRows(nextRows);
      setSummary(j?.summary || null);
      setDebugCounts(j?.debug_counts || null);

      const nextDrafts = {};
      nextRows.forEach((row) => {
        nextDrafts[row.seller_id] = {
          payslip_hours: row.payslip_hours_entered ? numInputValue(row.payslip_hours) : "",
          hourly_rate: numInputValue(row.hourly_rate),
          paid_leave_days_override:
            row.paid_leave_days_override == null ? "" : numInputValue(row.paid_leave_days_override),
          paid_leave_hours_per_day: numInputValue(row.paid_leave_hours_per_day),
          status: row.status || "to_check",
          note: row.note || "",
        };
      });

      setDrafts(nextDrafts);
    } catch (e) {
      setRows([]);
      setSummary(null);
      setDebugCounts(null);
      setDrafts({});
      setErr(e?.message || "Impossible de charger les compléments de paie.");
    } finally {
      setLoadingRows(false);
    }
  }, [month]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  const updateDraft = (sellerId, key, value) => {
    setDrafts((prev) => ({
      ...(prev || {}),
      [sellerId]: {
        ...(prev?.[sellerId] || {}),
        [key]: value,
      },
    }));
  };

  const localCalc = (row) => {
    const d = drafts?.[row.seller_id] || {};
    const payslipHours = parseNum(d.payslip_hours);
    const hasPayslipHours = payslipHours !== null;
    const hourlyRate = parseNum(d.hourly_rate) ?? 0;

    const leaveDays =
      d.paid_leave_days_override === "" || d.paid_leave_days_override == null
        ? Number(row.auto_paid_leave_days || 0)
        : parseNum(d.paid_leave_days_override) ?? 0;

    const leaveHoursPerDay = parseNum(d.paid_leave_hours_per_day) ?? 7;
    const paidLeaveHours = Math.round(leaveDays * leaveHoursPerDay * 100) / 100;
    const totalDue = Math.round((Number(row.app_worked_hours || 0) + paidLeaveHours) * 100) / 100;

    if (!hasPayslipHours) {
      return {
        hasPayslipHours: false,
        payslipHours: null,
        hourlyRate,
        leaveDays,
        paidLeaveHours,
        totalDue,
        diff: null,
        complementHours: null,
        amount: null,
      };
    }

    const diff = Math.round((totalDue - payslipHours) * 100) / 100;
    const complementHours = Math.max(0, diff);
    const amount = Math.round(complementHours * hourlyRate * 100) / 100;

    return {
      hasPayslipHours: true,
      payslipHours,
      hourlyRate,
      leaveDays,
      paidLeaveHours,
      totalDue,
      diff,
      complementHours,
      amount,
    };
  };

  const computedSummary = rows.reduce(
    (acc, row) => {
      const calc = localCalc(row);
      acc.totalApp += Number(row.app_worked_hours || 0);
      acc.totalLeave += calc.paidLeaveHours;
      acc.totalDue += calc.totalDue;

      if (calc.hasPayslipHours) {
        acc.enteredCount += 1;
        acc.totalPayslip += calc.payslipHours || 0;
        acc.totalComplementHours += calc.complementHours || 0;
        acc.totalComplementAmount += calc.amount || 0;
      }

      return acc;
    },
    {
      enteredCount: 0,
      totalApp: 0,
      totalLeave: 0,
      totalDue: 0,
      totalPayslip: 0,
      totalComplementHours: 0,
      totalComplementAmount: 0,
    }
  );

  const saveRow = useCallback(
    async (row, overrideStatus = null) => {
      const sellerId = String(row?.seller_id || "");
      if (!sellerId) return;

      setErr("");
      setMsg("");
      setSavingBySeller((prev) => ({ ...(prev || {}), [sellerId]: true }));

      try {
        const token = await getAccessToken();
        if (!token) {
          throw new Error("Session admin introuvable. Reconnecte-toi.");
        }

        const d = drafts?.[sellerId] || {};

        const resp = await fetch("/api/admin/payroll-adjustments/save", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            month,
            seller_id: sellerId,
            payslip_hours: d.payslip_hours,
            hourly_rate: d.hourly_rate,
            paid_leave_days_override: d.paid_leave_days_override === "" ? null : d.paid_leave_days_override,
            paid_leave_hours_per_day: d.paid_leave_hours_per_day,
            status: overrideStatus || d.status || "to_check",
            note: d.note || "",
          }),
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j?.ok === false) {
          throw new Error(j?.error || `Erreur API (${resp.status})`);
        }

        setMsg(`${row.full_name} enregistré.`);
        await loadPreview();
      } catch (e) {
        setErr(e?.message || "Enregistrement impossible.");
      } finally {
        setSavingBySeller((prev) => ({ ...(prev || {}), [sellerId]: false }));
      }
    },
    [drafts, loadPreview, month]
  );

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-5">
      <Head>
        <title>Compléments paie</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="hdr">Compléments paie</div>
          <div className="text-sm text-gray-600">
            Compare les heures calculées par l’application avec les heures déjà payées sur la fiche de paie.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin" className="btn">
            Retour admin
          </Link>
          <Link href="/admin/payroll-email" className="btn">
            Mail comptable
          </Link>
          <Link href="/admin/payslips" className="btn">
            Fiches de paie
          </Link>
        </div>
      </div>

      <div className="card space-y-3">
        <div className="grid md:grid-cols-[220px_1fr] gap-3 items-end">
          <div>
            <div className="text-sm mb-1">Mois</div>
            <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <button type="button" className="btn" onClick={loadPreview} disabled={loadingRows}>
              {loadingRows ? "Chargement..." : "Rafraîchir"}
            </button>

            <span className="text-xs text-gray-500">{lastApiStatus}</span>
          </div>
        </div>

        {rows.length > 0 ? (
          <div className="grid md:grid-cols-4 gap-2">
            <div className="border rounded-2xl p-3">
              <div className="text-xs text-gray-500">Vendeuses</div>
              <div className="text-lg font-semibold">{rows.length}</div>
            </div>
            <div className="border rounded-2xl p-3">
              <div className="text-xs text-gray-500">Fiches renseignées</div>
              <div className="text-lg font-semibold">
                {computedSummary.enteredCount} / {rows.length}
              </div>
            </div>
            <div className="border rounded-2xl p-3">
              <div className="text-xs text-gray-500">À compléter validé</div>
              <div className="text-lg font-semibold">{fmtHours(computedSummary.totalComplementHours)}</div>
            </div>
            <div className="border rounded-2xl p-3">
              <div className="text-xs text-gray-500">Total à payer estimé</div>
              <div className="text-lg font-semibold">{fmtEuro(computedSummary.totalComplementAmount)}</div>
            </div>
          </div>
        ) : summary ? (
          <div className="text-sm text-gray-600">
            API chargée, mais aucune ligne exploitable affichée. Total API : {summary.sellers_count || 0}
          </div>
        ) : null}

        {rows.length > 0 && computedSummary.enteredCount < rows.length ? (
          <div className="text-sm text-amber-700">
            Les totaux en haut prennent seulement les vendeuses dont la colonne “H. fiche” est renseignée. Les autres restent à saisir.
          </div>
        ) : null}

        {msg ? <div className="text-sm text-green-700">{msg}</div> : null}
        {err ? <div className="text-sm text-red-600">{err}</div> : null}

        {debugCounts ? (
          <details className="text-xs text-gray-500">
            <summary>Diagnostic API</summary>
            <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(debugCounts, null, 2)}</pre>
          </details>
        ) : null}
      </div>

      <div className="card overflow-x-auto">
        {loadingRows ? (
          <div className="text-sm text-gray-600">Chargement...</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse trouvée pour ce mois.</div>
        ) : (
          <table className="min-w-[1180px] w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="py-2 pr-2">Vendeuse</th>
                <th className="py-2 px-2">Heures app</th>
                <th className="py-2 px-2">Congés</th>
                <th className="py-2 px-2">H. congés</th>
                <th className="py-2 px-2">Total dû</th>
                <th className="py-2 px-2">H. fiche</th>
                <th className="py-2 px-2">Différence</th>
                <th className="py-2 px-2">Taux</th>
                <th className="py-2 px-2">À payer</th>
                <th className="py-2 px-2">Statut</th>
                <th className="py-2 pl-2">Actions</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => {
                const d = drafts?.[row.seller_id] || {};
                const calc = localCalc(row);
                const busy = !!savingBySeller?.[row.seller_id];

                return (
                  <tr key={row.seller_id} className="border-b align-top">
                    <td className="py-3 pr-2">
                      <div className="font-medium">{row.full_name}</div>
                      <div className="text-xs text-gray-500">
                        Planning {fmtHours(row.planning_hours)}
                        {row.extra_net_minutes ? ` · Ajust. ${row.extra_net_minutes} min` : ""}
                        {row.checkin_net_minutes ? ` · Pointage ${row.checkin_net_minutes} min` : ""}
                      </div>
                    </td>

                    <td className="py-3 px-2">{fmtHours(row.app_worked_hours)}</td>

                    <td className="py-3 px-2">
                      <input
                        className="input"
                        style={{ width: 84 }}
                        value={d.paid_leave_days_override}
                        placeholder={numInputValue(row.auto_paid_leave_days)}
                        onChange={(e) => updateDraft(row.seller_id, "paid_leave_days_override", e.target.value)}
                      />
                      <div className="text-xs text-gray-500">auto : {numInputValue(row.auto_paid_leave_days)} j</div>
                    </td>

                    <td className="py-3 px-2">
                      <div>{fmtHours(calc.paidLeaveHours)}</div>
                      <div className="text-xs text-gray-500 flex items-center gap-1">
                        <input
                          className="input"
                          style={{ width: 70 }}
                          value={d.paid_leave_hours_per_day}
                          onChange={(e) => updateDraft(row.seller_id, "paid_leave_hours_per_day", e.target.value)}
                        />
                        h/j
                      </div>
                    </td>

                    <td className="py-3 px-2 font-medium">{fmtHours(calc.totalDue)}</td>

                    <td className="py-3 px-2">
                      <input
                        className="input"
                        style={{ width: 90 }}
                        value={d.payslip_hours}
                        placeholder="À saisir"
                        onChange={(e) => updateDraft(row.seller_id, "payslip_hours", e.target.value)}
                      />
                    </td>

                    <td className="py-3 px-2">
                      {calc.hasPayslipHours ? (
                        <span style={{ color: calc.diff >= 0 ? "#16a34a" : "#dc2626", fontWeight: 700 }}>
                          {fmtHours(calc.diff)}
                        </span>
                      ) : (
                        <span className="text-gray-400">À saisir</span>
                      )}
                    </td>

                    <td className="py-3 px-2">
                      <input
                        className="input"
                        style={{ width: 78 }}
                        value={d.hourly_rate}
                        onChange={(e) => updateDraft(row.seller_id, "hourly_rate", e.target.value)}
                      />
                    </td>

                    <td className="py-3 px-2 font-semibold">
                      {calc.hasPayslipHours ? fmtEuro(calc.amount) : <span className="text-gray-400">À saisir</span>}
                    </td>

                    <td className="py-3 px-2">
                      <select
                        className="input"
                        value={d.status || "to_check"}
                        onChange={(e) => updateDraft(row.seller_id, "status", e.target.value)}
                        style={{ borderColor: statusColor(d.status) }}
                      >
                        <option value="to_check">À vérifier</option>
                        <option value="validated">Validé</option>
                        <option value="paid">Payé</option>
                      </select>
                      <div className="text-xs mt-1" style={{ color: statusColor(d.status) }}>
                        {statusLabel(d.status)}
                      </div>
                    </td>

                    <td className="py-3 pl-2">
                      <div className="flex flex-col gap-2">
                        <button className="btn" type="button" disabled={busy} onClick={() => saveRow(row)}>
                          {busy ? "..." : "Enregistrer"}
                        </button>

                        <button
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() => saveRow(row, "validated")}
                          style={{ backgroundColor: "#2563eb", color: "#fff", borderColor: "transparent" }}
                        >
                          Valider
                        </button>

                        <button
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() => saveRow(row, "paid")}
                          style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}
                        >
                          Marquer payé
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card text-sm text-gray-600 space-y-1">
        <div className="font-medium text-gray-900">Formule utilisée</div>
        <div>Heures dues = heures app + heures congés payés.</div>
        <div>Heures à compléter = heures dues - heures déjà payées sur la fiche.</div>
        <div>Montant à payer = heures à compléter × taux horaire.</div>
      </div>
    </div>
  );
}
