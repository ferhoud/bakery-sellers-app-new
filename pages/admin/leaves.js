// pages/admin/leaves.js
/* Admin > Congés (soldes bulletin)
   - Affiche une carte par vendeuse (solde N / N-1)
   - Permet à l'admin de corriger les compteurs (comme sur la fiche de paie)
   - Bonus: affiche les congés "approved" à venir pour info

   API utilisée:
   - GET/POST /api/admin/leave-balances  (service role côté serveur, sécurisé via Bearer token)
*/

import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";
import { BUILD_TAG } from "@/lib/version";

function parisTodayISO() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    return `${y}-${m}-${d}`;
  } catch {
    // fallback (locale)
    try {
      return new Date().toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }
}

function safeNum(x) {
  if (x === null || x === undefined || x === "") return 0;
  const s = String(x).replace(",", ".").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function fmtFR(iso) {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR");
  } catch {
    return iso;
  }
}

function workingDaysSundayExcluded(startIso, endIso) {
  // jours "ouvrables" simplifiés : lundi..samedi, dimanche exclu
  // inclusif: start..end
  try {
    const start = new Date(startIso + "T00:00:00");
    const end = new Date(endIso + "T00:00:00");
    if (!(start instanceof Date) || !(end instanceof Date)) return 0;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
    if (end < start) return 0;

    let c = 0;
    const d = new Date(start.getTime());
    while (d <= end) {
      const day = d.getDay(); // 0=dim
      if (day !== 0) c += 1;
      d.setDate(d.getDate() + 1);
    }
    return c;
  } catch {
    return 0;
  }
}

export default function AdminLeavesPage() {
  const r = useRouter();
  const { session, profile, loading } = useAuth();

  const isAdmin = useMemo(() => {
    const email = String(session?.user?.email || "").trim().toLowerCase();
    return isAdminEmail(email) || String(profile?.role || "").toLowerCase() === "admin";
  }, [session?.user?.email, profile?.role]);

  // Sécurité / redirections
  useEffect(() => {
    if (loading) return;
    if (!session) {
      r.replace("/login");
      return;
    }
    if (!isAdmin) r.replace("/app");
  }, [session, loading, isAdmin, r]);

  const todayIso = useMemo(() => parisTodayISO(), []);
  const [rows, setRows] = useState([]); // [{seller_id, full_name, active, balance}]
  const [upcomingApproved, setUpcomingApproved] = useState({}); // seller_id -> [{start_date,end_date,days}]
  const [busy, setBusy] = useState(false);
  const [saveBusyId, setSaveBusyId] = useState("");
  const [msg, setMsg] = useState("");

  // Édits locaux
  const [edit, setEdit] = useState({}); // seller_id -> fields

  const loadAll = useCallback(async () => {
    setBusy(true);
    setMsg("");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) {
        setRows([]);
        setUpcomingApproved({});
        return;
      }

      const resp = await fetch("/api/admin/leave-balances", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.ok) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }

      const list = Array.isArray(j?.rows) ? j.rows : [];
      setRows(list);

      // Initialise les champs d'édition à partir des balances existantes
      const nextEdit = {};
      for (const it of list) {
        const b = it?.balance || null;
        nextEdit[it.seller_id] = {
          as_of: (b?.as_of || todayIso).slice(0, 10),
          cp_acquired_n: b?.cp_acquired_n ?? 0,
          cp_taken_n: b?.cp_taken_n ?? 0,
          cp_remaining_n: b?.cp_remaining_n ?? 0,
          cp_acquired_n1: b?.cp_acquired_n1 ?? 0,
          cp_taken_n1: b?.cp_taken_n1 ?? 0,
          cp_remaining_n1: b?.cp_remaining_n1 ?? 0,
        };
      }
      setEdit(nextEdit);

      // Bonus: congés approuvés à venir (pour info) via client (admin a déjà les droits dans ton app)
      const { data: leaves, error } = await supabase
        .from("leaves")
        .select("seller_id,start_date,end_date,status")
        .eq("status", "approved")
        .gte("end_date", todayIso)
        .order("start_date", { ascending: true });

      if (!error) {
        const map = {};
        for (const l of leaves || []) {
          if (!map[l.seller_id]) map[l.seller_id] = [];
          map[l.seller_id].push({
            start_date: l.start_date,
            end_date: l.end_date,
            days: workingDaysSundayExcluded(l.start_date, l.end_date),
          });
        }
        setUpcomingApproved(map);
      } else {
        // Ne casse pas la page si RLS différente sur un env
        setUpcomingApproved({});
      }
    } catch (e) {
      console.error(e);
      setMsg(e?.message || "Erreur de chargement");
      setRows([]);
      setUpcomingApproved({});
    } finally {
      setBusy(false);
    }
  }, [todayIso]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    loadAll();
  }, [session, isAdmin, loadAll]);

  const setField = useCallback((sellerId, key, value) => {
    setEdit((prev) => ({
      ...prev,
      [sellerId]: {
        ...(prev[sellerId] || {}),
        [key]: value,
      },
    }));
  }, []);

  const autoComputeRemaining = useCallback((sellerId) => {
    setEdit((prev) => {
      const cur = prev[sellerId] || {};
      const aN = safeNum(cur.cp_acquired_n);
      const tN = safeNum(cur.cp_taken_n);
      const aN1 = safeNum(cur.cp_acquired_n1);
      const tN1 = safeNum(cur.cp_taken_n1);

      return {
        ...prev,
        [sellerId]: {
          ...cur,
          cp_remaining_n: Number((aN - tN).toFixed(2)),
          cp_remaining_n1: Number((aN1 - tN1).toFixed(2)),
        },
      };
    });
  }, []);

  const saveOne = useCallback(async (sellerId) => {
    setSaveBusyId(sellerId);
    setMsg("");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("Session expirée");

      const cur = edit[sellerId] || {};
      const payload = {
        seller_id: sellerId,
        as_of: String(cur.as_of || todayIso).slice(0, 10),

        cp_acquired_n: safeNum(cur.cp_acquired_n),
        cp_taken_n: safeNum(cur.cp_taken_n),
        cp_remaining_n: safeNum(cur.cp_remaining_n),

        cp_acquired_n1: safeNum(cur.cp_acquired_n1),
        cp_taken_n1: safeNum(cur.cp_taken_n1),
        cp_remaining_n1: safeNum(cur.cp_remaining_n1),
      };

      if (!payload.as_of) throw new Error("Date (as_of) manquante");

      const resp = await fetch("/api/admin/leave-balances", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.ok) throw new Error(j?.error || `Erreur API (${resp.status})`);

      setMsg("✅ Enregistré.");
      // Refresh léger: remonte ce qu'on a vraiment en base
      await loadAll();
    } catch (e) {
      console.error(e);
      setMsg(`❌ ${e?.message || "Erreur d’enregistrement"}`);
    } finally {
      setSaveBusyId("");
    }
  }, [edit, todayIso, loadAll]);

  const [signingOut, setSigningOut] = useState(false);
  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
    } finally {
      setSigningOut(false);
      r.replace("/login");
    }
  }, [r, signingOut]);

  return (
    <>
      <Head>
        <title>Admin • Congés - {BUILD_TAG}</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div
        style={{
          padding: "6px 10px",
          background: "#fff",
          color: "#111827",
          borderBottom: "1px solid #e5e7eb",
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800, fontSize: 13, whiteSpace: "nowrap" }}>{BUILD_TAG}</div>

          <div className="flex items-center gap-2 flex-wrap">
            <Link href="/admin" legacyBehavior>
              <a className="btn">⬅️ Retour</a>
            </Link>

            <button type="button" className="btn" onClick={loadAll} disabled={busy}>
              {busy ? "Rafraîchissement…" : "🔄 Rafraîchir"}
            </button>

            <button
              type="button"
              className="btn"
              onClick={signOut}
              disabled={signingOut}
              style={{ backgroundColor: "#dc2626", borderColor: "transparent", color: "#fff" }}
            >
              {signingOut ? "Déconnexion…" : "Se déconnecter"}
            </button>
          </div>
        </div>
      </div>

      <div className="p-3 max-w-7xl 2xl:max-w-screen-2xl mx-auto space-y-4">
        <div className="card">
          <div className="hdr mb-2">🏖️ Congés (soldes bulletin)</div>
          <div className="text-sm text-gray-700">
            Ici tu corriges les compteurs <b>comme sur la fiche de paie</b>. L’appli déduit ensuite automatiquement les congés
            <b> approuvés</b> (prévisionnel côté vendeuse).
          </div>
          {msg ? (
            <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 12, border: "1px solid #e5e7eb" }}>{msg}</div>
          ) : null}
        </div>

        {rows.length === 0 ? (
          <div className="card">
            <div className="text-sm text-gray-600">{busy ? "Chargement…" : "Aucune vendeuse trouvée."}</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {rows.map((it) => {
              const sellerId = it.seller_id;
              const e = edit[sellerId] || {};
              const total = safeNum(e.cp_remaining_n) + safeNum(e.cp_remaining_n1);
              const upcoming = upcomingApproved[sellerId] || [];

              return (
                <div key={sellerId} className="card">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <div style={{ fontWeight: 900, fontSize: 16 }}>{it.full_name || "-"}</div>
                      <div className="text-sm text-gray-600">
                        Total restant (bulletin): <b>{total.toFixed(2)}</b> jours
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button type="button" className="btn" onClick={() => autoComputeRemaining(sellerId)}>
                        🧮 Auto solde
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => saveOne(sellerId)}
                        disabled={saveBusyId === sellerId}
                        style={{ backgroundColor: "#16a34a", borderColor: "transparent", color: "#fff" }}
                      >
                        {saveBusyId === sellerId ? "Enregistrement…" : "💾 Enregistrer"}
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Année N</div>

                      <label className="text-sm text-gray-600">Date bulletin (as_of)</label>
                      <input
                        className="input"
                        type="date"
                        value={String(e.as_of || todayIso).slice(0, 10)}
                        onChange={(ev) => setField(sellerId, "as_of", ev.target.value)}
                      />

                      <div style={{ height: 8 }} />

                      <label className="text-sm text-gray-600">Acquis (N)</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={String(e.cp_acquired_n ?? 0)}
                        onChange={(ev) => setField(sellerId, "cp_acquired_n", ev.target.value)}
                      />

                      <label className="text-sm text-gray-600">Pris (N)</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={String(e.cp_taken_n ?? 0)}
                        onChange={(ev) => setField(sellerId, "cp_taken_n", ev.target.value)}
                      />

                      <label className="text-sm text-gray-600">Solde (N)</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={String(e.cp_remaining_n ?? 0)}
                        onChange={(ev) => setField(sellerId, "cp_remaining_n", ev.target.value)}
                      />
                    </div>

                    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Année N-1</div>

                      <label className="text-sm text-gray-600">Acquis (N-1)</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={String(e.cp_acquired_n1 ?? 0)}
                        onChange={(ev) => setField(sellerId, "cp_acquired_n1", ev.target.value)}
                      />

                      <label className="text-sm text-gray-600">Pris (N-1)</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={String(e.cp_taken_n1 ?? 0)}
                        onChange={(ev) => setField(sellerId, "cp_taken_n1", ev.target.value)}
                      />

                      <label className="text-sm text-gray-600">Solde (N-1)</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        value={String(e.cp_remaining_n1 ?? 0)}
                        onChange={(ev) => setField(sellerId, "cp_remaining_n1", ev.target.value)}
                      />
                    </div>
                  </div>

                  {upcoming.length ? (
                    <div style={{ marginTop: 12, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                      <div style={{ fontWeight: 900, marginBottom: 6 }}>Congés approuvés à venir (info)</div>
                      <ul className="list-disc pl-6 space-y-1 text-sm">
                        {upcoming.map((u, idx) => (
                          <li key={`${u.start_date}-${u.end_date}-${idx}`}>
                            Du <b>{fmtFR(u.start_date)}</b> au <b>{fmtFR(u.end_date)}</b> · {u.days} jours (dimanche exclu)
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div style={{ marginTop: 12, borderTop: "1px solid #e5e7eb", paddingTop: 10 }} className="text-sm text-gray-600">
                      Aucun congé approuvé à venir.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
