/* eslint-disable react/no-unescaped-entities */

import Head from "next/head";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

function fmtMonth(iso) {
  try {
    const d = new Date(String(iso || "").slice(0, 10) + "T12:00:00");
    if (Number.isNaN(d.getTime())) return String(iso || "").slice(0, 7) || "—";
    return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  } catch {
    return String(iso || "").slice(0, 7) || "—";
  }
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fr-FR");
  } catch {
    return String(iso);
  }
}

function fmtNum(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(2);
}

function leaveBalanceLine(balance) {
  const b = balance || null;
  if (!b) return "Compteurs congés non détectés sur ce bulletin.";
  return `Congés du bulletin : solde N-1 ${fmtNum(b.cp_remaining_n1)} j · solde N ${fmtNum(b.cp_remaining_n)} j`;
}

export default function MyPayslipsPage() {
  const r = useRouter();
  const { session: hookSession, profile: hookProfile } = useAuth();

  const [sbSession, setSbSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

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
      } catch {}
    };
  }, []);

  const session = sbSession ?? hookSession ?? null;
  const userId = session?.user?.id || null;
  const userEmail = session?.user?.email || null;

  const [profileFallback, setProfileFallback] = useState(null);
  useEffect(() => {
    let alive = true;

    (async () => {
      if (!userId) {
        if (alive) setProfileFallback(null);
        return;
      }
      if (hookProfile?.user_id === userId) return;

      try {
        const { data } = await supabase
          .from("profiles")
          .select("user_id, full_name, role")
          .eq("user_id", userId)
          .maybeSingle();
        if (!alive) return;
        setProfileFallback(data || null);
      } catch {}
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
    (userEmail ? userEmail.split("@")[0] : "—");

  useEffect(() => {
    if (!authChecked) return;

    if (!userId && typeof window !== "undefined") {
      window.location.replace("/login?stay=1&next=/payslips");
      return;
    }

    if (role === "supervisor" && typeof window !== "undefined") {
      window.location.replace("/supervisor?stay=1");
    }
  }, [authChecked, userId, role]);

  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);

  const payslipsByYear = useMemo(() => {
    const map = new Map();

    for (const row of rows || []) {
      const year = String(row?.payroll_month || "").slice(0, 4) || "Sans année";
      if (!map.has(year)) map.set(year, []);
      map.get(year).push(row);
    }

    return Array.from(map.entries())
      .map(([year, items]) => ({
        year,
        items: (items || []).sort((a, b) =>
          String(b?.payroll_month || "").localeCompare(String(a?.payroll_month || ""))
        ),
      }))
      .sort((a, b) => String(b.year).localeCompare(String(a.year)));
  }, [rows]);
  const [err, setErr] = useState("");
  const [openBusy, setOpenBusy] = useState({});

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }, []);

  const loadMyPayslips = useCallback(async () => {
    if (!userId) return;

    setErr("");
    setLoadingRows(true);

    try {
      const token = await authToken();
      const resp = await fetch("/api/payslips/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }

      setRows(Array.isArray(j?.rows) ? j.rows : []);
    } catch (e) {
      setRows([]);
      setErr(e?.message || "Impossible de charger vos fiches de paie.");
    } finally {
      setLoadingRows(false);
    }
  }, [userId, authToken]);

  useEffect(() => {
    loadMyPayslips();
  }, [loadMyPayslips]);

  const openPdf = useCallback(
    async (item) => {
      const id = String(item?.id || "");
      if (!id) return;

      setErr("");
      setOpenBusy((prev) => ({ ...(prev || {}), [id]: true }));

      try {
        const token = await authToken();
        const resp = await fetch("/api/payslips/open", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ payslip_id: id }),
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j?.ok === false) {
          throw new Error(j?.error || `Erreur API (${resp.status})`);
        }

        const url = String(j?.url || "").trim();
        if (!url) throw new Error("Lien PDF introuvable.");

        const popup = window.open(url, "_blank", "noopener,noreferrer");
        if (!popup) {
          window.location.href = url;
        }
      } catch (e) {
        setErr(e?.message || "Impossible d'ouvrir cette fiche de paie.");
      } finally {
        setOpenBusy((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [authToken]
  );

  if (!authChecked) {
    return <div className="p-4">Chargement...</div>;
  }

  if (!userId) {
    return (
      <div className="p-4 max-w-3xl mx-auto">
        <div className="card">
          <div className="hdr">Connexion requise</div>
          <div className="text-sm text-gray-600 mt-2">Redirection vers la connexion…</div>
        </div>
      </div>
    );
  }

  if (role === "supervisor") {
    return (
      <div className="p-4 max-w-3xl mx-auto">
        <div className="card">
          <div className="hdr">Ouverture de l’écran superviseur…</div>
          <div className="text-sm text-gray-600 mt-2">Redirection en cours.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-5">
      <Head>
        <title>Mes fiches de paie</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="hdr">Mes fiches de paie</div>
          <div className="text-sm text-gray-600">
            Bonjour {displayName}. Les bulletins ci-dessous sont uniquement les tiens.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" onClick={() => r.push("/app")}>
            Retour accueil
          </button>
          <button className="btn" onClick={() => r.push("/leaves")}>
            Congés
          </button>
          <button className="btn" onClick={loadMyPayslips} disabled={loadingRows}>
            {loadingRows ? "Chargement..." : "Rafraîchir"}
          </button>
        </div>
      </div>

      {err ? (
        <div
          className="card"
          style={{ borderColor: "#fecaca", background: "#fef2f2" }}
        >
          <div className="text-sm" style={{ color: "#b91c1c" }}>
            {err}
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="hdr mb-3">Bulletins disponibles</div>

        {loadingRows ? (
          <div className="text-sm text-gray-600">Chargement des fiches de paie...</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-gray-600">
            Aucune fiche de paie disponible pour le moment.
          </div>
        ) : (
          <div className="space-y-5">
            {payslipsByYear.map((group) => (
              <div key={group.year} className="space-y-3">
                <div
                  className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium"
                  style={{ backgroundColor: "#e0f2fe", color: "#075985" }}
                >
                  {group.year}
                </div>

                <div className="space-y-3">
                  {group.items.map((row) => {
                    const id = String(row?.id || "");
                    return (
                      <div
                        key={id}
                        className="border rounded-2xl p-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
                      >
                        <div className="text-sm">
                          <div className="font-medium capitalize">Bulletin de {fmtMonth(row.payroll_month)}</div>
                          <div className="text-gray-600">
                            Ajouté le {fmtDateTime(row.created_at)}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {leaveBalanceLine(row.extracted_leave_balance)}
                          </div>
                        </div>

                        <button
                          className="btn"
                          type="button"
                          onClick={() => openPdf(row)}
                          disabled={!!openBusy?.[id]}
                          style={{
                            backgroundColor: "#0f766e",
                            color: "#fff",
                            borderColor: "transparent",
                          }}
                        >
                          {openBusy?.[id] ? "Ouverture..." : "Voir la fiche PDF"}
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
