// pages/admin/monthly-hours.js
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { supabase } from "@/lib/supabaseClient";
import { isAdminEmail } from "@/lib/admin";
import { BUILD_TAG } from "@/lib/version";
import { fmtISODate } from "@/lib/date";

function firstDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function monthInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function labelMonthFR(d) {
  try {
    return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  } catch {
    return String(d);
  }
}
function fmtErr(e) {
  if (!e) return "Erreur inconnue";
  if (typeof e === "string") return e;
  const msg = e?.message || String(e);
  const code = e?.code || e?.status;
  return code ? `${msg} (code ${code})` : msg;
}
function withTimeout(promise, ms, label = "Timeout") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export default function AdminMonthlyHoursPage() {
  const r = useRouter();

  // Auth "béton" sans useAuth
  const [authChecked, setAuthChecked] = useState(false);
  const [session, setSession] = useState(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data, error } = await withTimeout(supabase.auth.getSession(), 12000, "Timeout getSession (12s)");
        if (!alive) return;
        if (error) throw error;
        setSession(data?.session ?? null);
      } catch (e) {
        console.warn("[monthly-hours] getSession error:", e);
        if (!alive) return;
        setSession(null);
      } finally {
        if (alive) setAuthChecked(true);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      if (!alive) return;
      setSession(s ?? null);
      setAuthChecked(true);
    });

    return () => {
      alive = false;
      try {
        sub?.subscription?.unsubscribe?.();
      } catch {}
    };
  }, []);

  const email = session?.user?.email || "";
  const isAdmin = !!session && isAdminEmail(email);

  // UI state
  const [selectedMonth, setSelectedMonth] = useState(() => firstDayOfMonth(new Date()));
  const monthStart = useMemo(() => fmtISODate(firstDayOfMonth(selectedMonth)), [selectedMonth]);

  const [onlyPending, setOnlyPending] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [tableUsed, setTableUsed] = useState("");
  const [rows, setRows] = useState([]);
  const [sellers, setSellers] = useState([]);

  const inflight = useRef(false);

  const sellersById = useMemo(() => new Map((sellers || []).map((s) => [s.user_id, s])), [sellers]);
  const nameFromId = useCallback((id) => sellersById.get(id)?.full_name || "", [sellersById]);

  // Redirects
  useEffect(() => {
    if (!authChecked) return;

    if (!session) {
      // pas connecté => /login (hard)
      const ts = Date.now();
      window.location.replace(`/login?stay=1&next=/admin/monthly-hours&ts=${ts}`);
      return;
    }

    if (!isAdmin) {
      // connecté mais pas admin => /app
      r.replace("/app");
    }
  }, [authChecked, session, isAdmin, r]);

  const loadSellers = useCallback(async () => {
    try {
      const { data, error } = await withTimeout(supabase.rpc("list_sellers"), 15000, "Timeout list_sellers (15s)");
      if (error) throw error;
      const list = Array.isArray(data) ? data : [];
      list.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "fr", { sensitivity: "base" }));
      setSellers(list);
    } catch (e) {
      // pas bloquant
      console.warn("[monthly-hours] list_sellers failed:", e);
      setSellers([]);
    }
  }, []);

  // Essaie plusieurs tables possibles, sans jamais rester bloqué
  const loadRows = useCallback(async () => {
    if (!session || !isAdmin) return;
    if (inflight.current) return;

    inflight.current = true;
    setLoading(true);
    setErr("");
    setRows([]);
    setTableUsed("");

    try {
      await loadSellers();

      const tableCandidates = [
        "monthly_hours_attestations",
        "monthly_hours",
        "monthly_hours_rows",
      ];

      let lastError = null;

      for (const t of tableCandidates) {
        try {
          let q = supabase
            .from(t)
            .select("*")
            .eq("month_start", monthStart)
            .order("updated_at", { ascending: false });

          if (onlyPending) {
            // si la colonne n’existe pas, ça va throw et on passe à la table suivante
            q = q.eq("admin_status", "pending");
          }

          const { data, error } = await withTimeout(q, 20000, `Timeout select ${t} (20s)`);
          if (error) throw error;

          setTableUsed(t);
          setRows(Array.isArray(data) ? data : []);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }

      if (lastError && !tableUsed) {
        throw lastError;
      }
    } catch (e) {
      console.error("[monthly-hours] load error:", e);
      setErr(fmtErr(e));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [session, isAdmin, monthStart, onlyPending, loadSellers, tableUsed]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    loadRows();
  }, [session, isAdmin, loadRows]);

  // Admin action (si colonnes existent)
  const adminDecide = useCallback(async (row, decision) => {
    if (!tableUsed) return;
    try {
      const computed = Number(row?.computed_hours ?? 0);
      const corrected = row?.seller_correction_hours != null ? Number(row.seller_correction_hours) : null;

      const final =
        row?.seller_status === "disputed" && corrected != null ? corrected : computed;

      const payload = { admin_status: decision, final_hours: final };

      const { error } = await withTimeout(
        supabase.from(tableUsed).update(payload).eq("id", row.id),
        15000,
        "Timeout update (15s)"
      );
      if (error) throw error;

      await loadRows();
    } catch (e) {
      alert(fmtErr(e));
    }
  }, [tableUsed, loadRows]);

  // UI
  if (!authChecked) return <div className="p-4">Chargement…</div>;

  // si redirect en cours
  if (!session) return <div className="p-4">Redirection vers /login…</div>;
  if (!isAdmin) return <div className="p-4">Redirection…</div>;

  return (
    <>
      <Head>
        <title>Admin • Heures mensuelles</title>
        <meta name="robots" content="noindex" />
      </Head>

      <div style={{ padding: "8px", background: "#111", color: "#fff", fontWeight: 700 }}>
        {BUILD_TAG}
      </div>

      <div className="p-4 max-w-6xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="hdr">Heures mensuelles (admin)</div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/admin" legacyBehavior>
              <a className="btn">⬅ Retour</a>
            </Link>
            <button className="btn" onClick={() => (window.location.href = "/logout")}>
              /logout
            </button>
            <button className="btn" onClick={() => (window.location.href = "/purge")}>
              /purge
            </button>
          </div>
        </div>

        <div className="card space-y-3">
          <div className="grid sm:grid-cols-3 gap-3 items-end">
            <div>
              <div className="text-sm mb-1">Mois</div>
              <input
                type="month"
                className="input"
                value={monthInputValue(selectedMonth)}
                onChange={(e) => {
                  const [y, m] = e.target.value.split("-").map(Number);
                  setSelectedMonth(new Date(y, m - 1, 1));
                }}
              />
              <div className="text-xs text-gray-600 mt-1">Mois: {labelMonthFR(selectedMonth)}</div>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm flex items-center gap-2">
                <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
                Seulement “à traiter”
              </label>
            </div>

            <div className="flex gap-2 justify-start sm:justify-end">
              <button className="btn" onClick={loadRows} disabled={loading}>
                {loading ? "Chargement…" : "Rafraîchir"}
              </button>
            </div>
          </div>

          <div className="text-xs text-gray-500">
            Admin: <b>{email || "—"}</b> • table: <b>{tableUsed || "—"}</b> • month_start: <b>{monthStart}</b>
          </div>

          {err ? (
            <div
              className="text-sm border rounded-xl p-2"
              style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}
            >
              {err}
            </div>
          ) : null}

          {loading ? <div className="text-sm text-gray-600">Chargement…</div> : null}
        </div>

        {!loading && !err && rows.length === 0 ? (
          <div className="card text-sm text-gray-600">Aucune ligne pour ce mois (ou filtre trop strict).</div>
        ) : null}

        {!loading && rows.length > 0 ? (
          <div className="space-y-2">
            {rows.map((row) => {
              const name = nameFromId(row.seller_id) || row.seller_id || "—";
              const computed = row?.computed_hours != null ? Number(row.computed_hours) : null;
              const corrected = row?.seller_correction_hours != null ? Number(row.seller_correction_hours) : null;

              return (
                <div key={row.id || JSON.stringify(row)} className="border rounded-2xl p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div>
                      <div className="font-medium">{name}</div>
                      <div className="text-xs text-gray-600">
                        seller_status: <b>{row.seller_status ?? "—"}</b> • admin_status: <b>{row.admin_status ?? "—"}</b>
                      </div>
                    </div>

                    {row?.admin_status === "pending" && row?.id ? (
                      <div className="flex gap-2">
                        <button
                          className="btn"
                          onClick={() => adminDecide(row, "approved")}
                          style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}
                        >
                          Approuver
                        </button>
                        <button
                          className="btn"
                          onClick={() => adminDecide(row, "rejected")}
                          style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}
                        >
                          Refuser
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="text-sm text-gray-800">
                    Calculé: <b>{computed != null ? computed.toFixed(2) : "—"} h</b>
                    {corrected != null ? (
                      <>
                        {" "}
                        • Correction: <b>{corrected.toFixed(2)} h</b>
                      </>
                    ) : null}
                    {row?.final_hours != null ? (
                      <>
                        {" "}
                        • Retenu: <b>{Number(row.final_hours).toFixed(2)} h</b>
                      </>
                    ) : null}
                  </div>

                  {row?.seller_comment ? <div className="text-xs text-gray-600">📝 {row.seller_comment}</div> : null}

                  <details>
                    <summary className="text-xs text-gray-500 cursor-pointer">Détails</summary>
                    <pre className="text-xs mt-2" style={{ whiteSpace: "pre-wrap" }}>
                      {JSON.stringify(row, null, 2)}
                    </pre>
                  </details>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </>
  );
}
