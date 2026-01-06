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

/* ---------- debug helper ---------- */
async function execQuery(q) {
  const res = await q;
  return res;
}

/* ---------- main ---------- */
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
      // fallback silencieux (non bloquant)
      setSellers([]);
    }
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
          setRows(res?.data || []);
          found = true;
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }

      if (!found) {
        throw lastError || new Error("Aucune table trouvée");
      }

      setPhase(`ok (${tableUsed || "?"})`);
    } catch (e) {
      setRows([]);
      setPhase(`error: ${fmtErr(e)}`);
    } finally {
      setLoading(false);
    }
  }, [session, isAdmin, monthStart, onlyPending, tableUsed]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    loadSellers().catch(() => {});
  }, [session, isAdmin, loadSellers]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    loadRows();
  }, [session, isAdmin, loadRows]);

  const adminDecide = useCallback(
    async (row, decision) => {
      if (!tableUsed) return;
      try {
        setPhase(`update ${decision}…`);
        const computed = Number(row?.computed_hours ?? 0);
        const corrected = row?.seller_correction_hours != null ? Number(row.seller_correction_hours) : null;
        const final = row?.seller_status === "disputed" && corrected != null ? corrected : computed;

        const nowIso = new Date().toISOString();

        // IMPORTANT: on n’envoie que les colonnes qui existent dans la ligne (compat tables candidates)
        const payload = {};
        if ("admin_status" in row) payload.admin_status = decision;
        if ("final_hours" in row) payload.final_hours = final;
        if ("admin_decision_at" in row) payload.admin_decision_at = nowIso;

        // Si l'admin clique "Refuser", on interprète cela comme "Demander une correction".
        // Objectif: la vendeuse doit pouvoir revalider/corriger (sans SQL manuel).
        if (decision === "rejected") {
          // On garde le dossier "à traiter" côté admin (pending) mais on renvoie la balle à la vendeuse.
          if ("admin_status" in row) payload.admin_status = "pending";
          if ("admin_comment" in row) payload.admin_comment = "Refusé: merci de corriger puis renvoyer.";
          if ("seller_status" in row) payload.seller_status = "pending";
          if ("seller_confirmed_at" in row) payload.seller_confirmed_at = null;
          if ("seller_correction_hours" in row) payload.seller_correction_hours = null;
          if ("seller_comment" in row) payload.seller_comment = null;

          // Par défaut on repart sur le calcul planning
          if ("final_hours" in row) payload.final_hours = computed;
        }

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
              Aucune ligne pour <b>{monthLabel}</b>.
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

              return (
                <div key={row.id} className="card">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <div className="font-medium">{sellerName}</div>
                      <div className="text-xs text-gray-600">
                        seller_status: <b>{row.seller_status ?? "—"}</b> • admin_status: <b>{row.admin_status ?? "—"}</b>
                      </div>
                    </div>

                    {row?.admin_status === "pending" &&
                    row?.id &&
                    (row?.seller_status == null || row?.seller_status !== "pending") ? (
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
