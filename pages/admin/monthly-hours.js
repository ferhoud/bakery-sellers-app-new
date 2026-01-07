// pages/admin/monthly-hours.js
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { supabase } from "@/lib/supabaseClient";
import { isAdminEmail } from "@/lib/admin";
import { BUILD_TAG } from "@/lib/version";
import { fmtISODate } from "@/lib/date";

/* ---------- utils ---------- */
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
    return monthInputValue(d);
  }
}
function withTimeout(promise, ms, label = "Timeout") {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(label)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}
function fmtErr(e) {
  if (!e) return "Erreur inconnue";
  if (typeof e === "string") return e;
  const msg = e?.message || e?.error_description || e?.hint || "Erreur";
  const code = e?.code ? ` (code ${e.code})` : "";
  return `${msg}${code}`;
}
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
async function execQuery(q) {
  const res = await q;
  return res;
}

export default function AdminMonthlyHours() {
  const r = useRouter();

  const [authChecked, setAuthChecked] = useState(false);
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const [monthStart, setMonthStart] = useState(() => {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return fmtISODate(prev);
  });

  const monthDate = useMemo(() => new Date(monthStart + "T00:00:00"), [monthStart]);
  const monthLabel = useMemo(() => labelMonthFR(monthDate), [monthDate]);

  const [phase, setPhase] = useState("init");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [tableUsed, setTableUsed] = useState("");
  const [onlyPending, setOnlyPending] = useState(true);
  const [sellers, setSellers] = useState([]);
  const [debug, setDebug] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Auth / admin check
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        setSession(data?.session ?? null);
        setIsAdmin(isAdminEmail(data?.session?.user?.email || ""));
      } finally {
        if (alive) setAuthChecked(true);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s ?? null);
      setIsAdmin(isAdminEmail(s?.user?.email || ""));
      setAuthChecked(true);
    });

    return () => {
      alive = false;
      try {
        sub?.subscription?.unsubscribe?.();
      } catch (_) {}
    };
  }, []);

  // Redirects
  useEffect(() => {
    if (!authChecked) return;
    if (!session) {
      r.replace("/login?stay=1&next=/admin/monthly-hours");
      return;
    }
    if (session && !isAdmin) {
      r.replace("/app");
    }
  }, [authChecked, session, isAdmin, r]);

  const loadSellers = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("list_active_seller_names");
      if (error) throw error;
      setSellers(Array.isArray(data) ? data : []);
    } catch (_) {
      setSellers([]);
    }
  }, []);

  const isActionableForAdmin = useCallback((row) => {
    const s = row?.seller_status ?? null;
    return s === "accepted" || s === "disputed";
  }, []);

  const loadRows = useCallback(async () => {
    if (!session || !isAdmin) return;

    setLoading(true);
    setPhase("loading…");

    try {
      const tableCandidates = ["monthly_hours_attestations", "monthly_hours", "monthly_hours_rows"];

      let lastError = null;
      let found = false;

      for (const t of tableCandidates) {
        try {
          let q = supabase.from(t).select("*").eq("month_start", monthStart);
          if (onlyPending) q = q.eq("admin_status", "pending");

          const res = await withTimeout(execQuery(q), 20000, `Timeout select ${t} (20s)`);
          if (res?.error) throw res.error;

          setTableUsed(t);

          let data = res?.data || [];
          if (onlyPending) data = data.filter(isActionableForAdmin);

          setRows(data);
          found = true;
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }

      if (!found) throw lastError || new Error("Aucune table trouvée");

      setPhase(`ok (${tableUsed || "?"})`);
    } catch (e) {
      setRows([]);
      setPhase(`error: ${fmtErr(e)}`);
    } finally {
      setLoading(false);
    }
  }, [session, isAdmin, monthStart, onlyPending, tableUsed, isActionableForAdmin]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    loadSellers().catch(() => {});
  }, [session, isAdmin, loadSellers]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    loadRows();
  }, [session, isAdmin, loadRows]);

  const adminApprove = useCallback(
    async (row) => {
      if (!tableUsed) return;
      try {
        setPhase("update approved…");
        const computed = Number(row?.computed_hours ?? 0);
        const corrected = row?.seller_correction_hours != null ? Number(row.seller_correction_hours) : null;
        const final = row?.seller_status === "disputed" && corrected != null ? corrected : computed;

        const nowIso = new Date().toISOString();
        const payload = {};
        if ("admin_status" in row) payload.admin_status = "approved";
        if ("final_hours" in row) payload.final_hours = final;
        if ("admin_decision_at" in row) payload.admin_decision_at = nowIso;

        const res = await withTimeout(
          execQuery(supabase.from(tableUsed).update(payload).eq("id", row.id)),
          15000,
          "Timeout update (15s)"
        );
        if (res?.error) throw res.error;

        await loadRows();
      } catch (e) {
        alert(fmtErr(e));
        setPhase("error");
      }
    },
    [tableUsed, loadRows]
  );

  const adminRequestCorrection = useCallback(
    async (row) => {
      try {
        setPhase("request correction…");

        const { error: rpcErr } = await supabase.rpc("admin_request_monthly_correction", {
          p_row_id: row.id,
          p_comment: "Refusé: merci de corriger puis renvoyer.",
        });

        if (rpcErr) throw rpcErr;

        await loadRows();
      } catch (e) {
        alert(fmtErr(e));
        setPhase("error");
      }
    },
    [loadRows]
  );

  // UI
  if (!authChecked) return <div className="p-4">Chargement…</div>;
  if (!session) return <div className="p-4">Redirection vers /login…</div>;
  if (!isAdmin) return <div className="p-4">Redirection…</div>;

  return (
    <>
      <Head>
        <title>Admin • Heures mensuelles</title>
        <meta name="robots" content="noindex" />
      </Head>

      <div style={{ padding: "8px", background: "#111", color: "#fff", fontWeight: 700 }}>{BUILD_TAG}</div>

      <div className="p-4 max-w-6xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="hdr">Heures mensuelles (admin)</div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/admin" legacyBehavior>
              <a className="btn">← Admin</a>
            </Link>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              Seulement à traiter
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
              Debug
            </label>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm text-gray-600">Mois</div>
            <input
              type="month"
              className="input"
              value={monthInputValue(monthDate)}
              onChange={(e) => {
                const [y, m] = String(e.target.value || "").split("-").map((x) => Number(x));
                const d = new Date(y, (m || 1) - 1, 1);
                setMonthStart(fmtISODate(firstDayOfMonth(d)));
              }}
            />
            <div className="text-sm text-gray-600">
              {monthLabel} • table: <b>{tableUsed || "—"}</b> • phase: <b>{phase}</b>
            </div>

            <button className="btn" onClick={loadRows} disabled={loading}>
              Rafraîchir
            </button>
          </div>
        </div>

        {rows?.length === 0 ? (
          <div className="card">
            <div className="text-sm text-gray-600">
              Aucune ligne {onlyPending ? "(à traiter)" : ""} pour <b>{monthLabel}</b>.
            </div>
          </div>
        ) : null}

        {rows?.length ? (
          <div className="space-y-3">
            {rows.map((row) => {
              const sellerId = row?.seller_id || row?.seller || row?.user_id || null;
              const sellerName =
                sellers.find((s) => s?.user_id === sellerId)?.full_name ||
                row?.seller_name ||
                row?.full_name ||
                (sellerId ? String(sellerId).slice(0, 8) : "—");

              const computed = safeNum(row?.computed_hours);
              const corrected = safeNum(row?.seller_correction_hours);
              const final = safeNum(row?.final_hours);

              const actionable = isActionableForAdmin(row);

              return (
                <div key={row.id} className="card">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <div className="font-medium">{sellerName}</div>
                      <div className="text-xs text-gray-600">
                        seller_status: <b>{row.seller_status ?? "—"}</b> • admin_status:{" "}
                        <b>{row.admin_status ?? "—"}</b>
                      </div>
                    </div>

                    {row?.admin_status === "pending" && row?.id && actionable ? (
                      <div className="flex gap-2">
                        <button
                          className="btn"
                          onClick={() => adminApprove(row)}
                          style={{ backgroundColor: "#16a34a", color: "#fff", borderColor: "transparent" }}
                        >
                          Approuver
                        </button>
                        <button
                          className="btn"
                          onClick={() => adminRequestCorrection(row)}
                          style={{ backgroundColor: "#dc2626", color: "#fff", borderColor: "transparent" }}
                        >
                          Refuser (demander correction)
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
                    {final != null ? (
                      <>
                        {" "}
                        • Retenu: <b>{final.toFixed(2)} h</b>
                      </>
                    ) : null}
                  </div>

                  {row?.admin_comment ? <div className="text-xs text-gray-600">📌 {row.admin_comment}</div> : null}
                  {row?.seller_comment ? <div className="text-xs text-gray-600">📝 {row.seller_comment}</div> : null}

                  {debug ? (
                    <details>
                      <summary className="text-xs text-gray-500 cursor-pointer">Détails</summary>
                      <pre className="text-xs mt-2" style={{ whiteSpace: "pre-wrap" }}>
                        {JSON.stringify(row, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </>
  );
}
