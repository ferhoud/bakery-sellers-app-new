// pages/admin/monthly-hours.js
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";
import { BUILD_TAG } from "@/lib/version";
import { fmtISODate } from "../../lib/date";

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
function withTimeout(promise, ms, label = "timeout") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export default function AdminMonthlyHoursPage() {
  const r = useRouter();
  const { session: hookSession, profile, loading: hookLoading } = useAuth();

  // ✅ session “source de vérité” (anti blocage)
  const [sbSession, setSbSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        setSbSession(data?.session || null);
      } finally {
        if (alive) setAuthChecked(true);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSbSession(sess || null);
      setAuthChecked(true);
    });

    return () => {
      alive = false;
      try {
        sub?.subscription?.unsubscribe?.();
      } catch {}
    };
  }, []);

  const session = sbSession || hookSession;
  const email = session?.user?.email || "";
  const isAdmin = !!session && (isAdminEmail(email) || profile?.role === "admin");

  // UI state
  const [selectedMonth, setSelectedMonth] = useState(() => firstDayOfMonth(new Date()));
  const monthStart = useMemo(() => fmtISODate(firstDayOfMonth(selectedMonth)), [selectedMonth]);

  const [rows, setRows] = useState([]);
  const [sellers, setSellers] = useState([]);
  const sellersById = useMemo(() => new Map((sellers || []).map((s) => [s.user_id, s])), [sellers]);
  const nameFromId = useCallback((id) => sellersById.get(id)?.full_name || "", [sellersById]);

  const [onlyPending, setOnlyPending] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const inflight = useRef(false);

  // redirects (après hooks)
  useEffect(() => {
    if (!authChecked && hookLoading) return;

    if (!session) {
      r.replace("/login?stay=1&next=/admin/monthly-hours");
      return;
    }
    if (!isAdmin) {
      r.replace("/app");
    }
  }, [authChecked, hookLoading, session, isAdmin, r]);

  const loadSellers = useCallback(async () => {
    let list = [];
    try {
      const { data, error } = await supabase.rpc("list_sellers");
      if (!error && Array.isArray(data)) list = data;
    } catch {}
    // Tri stable
    if (list?.length) {
      list.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", "fr", { sensitivity: "base" }));
    }
    setSellers(list || []);
  }, []);

  const loadRows = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setErr("");
    setLoading(true);

    try {
      await loadSellers();

      const q = supabase
        .from("monthly_hours_attestations")
        .select(
          "id, seller_id, month_start, seller_status, admin_status, computed_hours, seller_correction_hours, seller_comment, final_hours, updated_at, created_at"
        )
        .eq("month_start", monthStart)
        .order("updated_at", { ascending: false });

      const query = onlyPending ? q.eq("admin_status", "pending") : q;

      const { data, error } = await withTimeout(query, 20000, "Timeout Supabase (20s)");
      if (error) throw error;

      setRows(data || []);
    } catch (e) {
      console.error("[admin/monthly-hours] load error:", e);
      setRows([]);
      setErr(fmtErr(e));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [monthStart, onlyPending, loadSellers]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    loadRows();
  }, [session, isAdmin, loadRows]);

  // Realtime: recharge si une vendeuse répond / admin traite
  useEffect(() => {
    if (!session || !isAdmin) return;
    const ch = supabase
      .channel("mh_admin_page_rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "monthly_hours_attestations" }, () => {
        loadRows();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [session, isAdmin, loadRows]);

  async function adminDecide(row, decision) {
    // decision: "approved" | "rejected"
    try {
      const final =
        row?.seller_status === "disputed" && row?.seller_correction_hours != null
          ? Number(row.seller_correction_hours)
          : Number(row?.computed_hours || 0);

      // On met à jour admin_status + final_hours (colonne utilisée côté vendeuse)
      const { error } = await withTimeout(
        supabase
          .from("monthly_hours_attestations")
          .update({ admin_status: decision, final_hours: final })
          .eq("id", row.id),
        15000,
        "Timeout update (15s)"
      );

      if (error) throw error;
      await loadRows();
    } catch (e) {
      console.error("[admin/monthly-hours] decide error:", e);
      alert(fmtErr(e));
    }
  }

  const showLoading = !authChecked || hookLoading || (session && !isAdmin); // pendant redirect
  if (showLoading) return <div className="p-4">Chargement…</div>;

  return (
    <>
      <Head>
        <title>Admin • Heures mensuelles - {BUILD_TAG}</title>
        <meta name="robots" content="noindex" />
      </Head>

      <div style={{ padding: "8px", background: "#111", color: "#fff", fontWeight: 700 }}>{BUILD_TAG}</div>

      <div className="p-4 max-w-6xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="hdr">Heures mensuelles (admin)</div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/admin" legacyBehavior>
              <a className="btn">⬅ Retour</a>
            </Link>
            <button className="btn" onClick={() => (window.location.href = "/logout")}>
              Déconnexion hard
            </button>
          </div>
        </div>

        <div className="card">
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
              <div className="text-xs text-gray-600 mt-1">Mois sélectionné : {labelMonthFR(selectedMonth)}</div>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm flex items-center gap-2">
                <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
                Afficher seulement “à traiter”
              </label>
            </div>

            <div className="flex gap-2 justify-start sm:justify-end">
              <button className="btn" onClick={loadRows} disabled={loading}>
                {loading ? "Chargement…" : "Rafraîchir"}
              </button>
            </div>
          </div>

          {err ? (
            <div className="mt-3 text-sm border rounded-xl p-2" style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
              {err}
            </div>
          ) : null}

          {loading ? <div className="mt-3 text-sm text-gray-600">Chargement…</div> : null}

          {!loading && !err && rows.length === 0 ? (
            <div className="mt-3 text-sm text-gray-600">Aucune ligne pour ce mois (avec ce filtre).</div>
          ) : null}
        </div>

        {!loading && rows.length > 0 ? (
          <div className="space-y-2">
            {rows.map((row) => {
              const name = nameFromId(row.seller_id) || "—";
              const sellerTag =
                row.seller_status === "accepted" ? "validé" : row.seller_status === "disputed" ? "corrigé" : "en attente";
              const adminTag =
                row.admin_status === "approved" ? "approuvé ✅" : row.admin_status === "rejected" ? "refusé ❌" : "à traiter";

              const computed = Number(row.computed_hours || 0);
              const corrected = row.seller_correction_hours != null ? Number(row.seller_correction_hours) : null;

              return (
                <div key={row.id} className="border rounded-2xl p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div>
                      <div className="font-medium">{name}</div>
                      <div className="text-xs text-gray-600">
                        Vendeuse: {sellerTag} · Admin: <span className="font-medium">{adminTag}</span>
                      </div>
                    </div>

                    {row.admin_status === "pending" ? (
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
                    Calculé: <span className="font-semibold">{computed.toFixed(2)} h</span>
                    {corrected != null ? (
                      <>
                        {" "}
                        · Correction: <span className="font-semibold">{corrected.toFixed(2)} h</span>
                      </>
                    ) : null}
                    {row.final_hours != null ? (
                      <>
                        {" "}
                        · Retenu: <span className="font-semibold">{Number(row.final_hours).toFixed(2)} h</span>
                      </>
                    ) : null}
                  </div>

                  {row.seller_comment ? <div className="text-xs text-gray-600">📝 {row.seller_comment}</div> : null}

                  <div className="text-xs text-gray-500">
                    MAJ: {row.updated_at ? String(row.updated_at).replace("T", " ").slice(0, 16) : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </>
  );
}
