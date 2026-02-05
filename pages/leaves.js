/* eslint-disable react/no-unescaped-entities */

import Head from "next/head";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { fmtISODate } from "@/lib/date";

function parseIso(iso) {
  try {
    return new Date(String(iso) + "T00:00:00");
  } catch (_) {
    return new Date();
  }
}

function fmtFr(iso) {
  try {
    return new Date(String(iso) + "T00:00:00").toLocaleDateString("fr-FR");
  } catch (_) {
    return String(iso || "");
  }
}

function daysInclusive(startIso, endIso) {
  const a = parseIso(startIso);
  const b = parseIso(endIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const ms = b.getTime() - a.getTime();
  const days = Math.floor(ms / (24 * 3600 * 1000));
  return Math.max(days + 1, 0);
}

// Jours ouvrables: lundi..samedi (dimanche exclu)
function daysOuvrablesInclusive(startIso, endIso) {
  const a = parseIso(startIso);
  const b = parseIso(endIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  let d = new Date(a.getTime());
  let count = 0;
  while (d.getTime() <= b.getTime()) {
    if (d.getDay() !== 0) count += 1; // 0 = dimanche
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function addDaysIso(iso, n) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + (n || 0));
  return fmtISODate(d);
}

function clampNonNeg(n) {
  const v = Number(n || 0);
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

function numFmt(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "0";
  // Affiche 2 décimales seulement si nécessaire
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(2);
}

function statusLabel(s) {
  const x = String(s || "").toLowerCase();
  if (x === "approved") return "Approuvé";
  if (x === "refused") return "Refusé";
  if (x === "cancelled") return "Annulé";
  return "En attente";
}

function statusBg(s) {
  const x = String(s || "").toLowerCase();
  if (x === "approved") return "#16a34a";
  if (x === "refused") return "#dc2626";
  if (x === "cancelled") return "#6b7280";
  return "#f59e0b";
}

function monthLabelFR(monthIndex) {
  const d = new Date(2026, monthIndex, 1);
  return d.toLocaleDateString("fr-FR", { month: "long" });
}

function computeYearMonthBreakdown(approvedLeaves, year) {
  const months = Array.from({ length: 12 }).map((_, i) => ({
    monthIndex: i,
    label: monthLabelFR(i),
    days: 0,
  }));

  approvedLeaves.forEach((l) => {
    const s = parseIso(l.start_date);
    const e = parseIso(l.end_date);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return;

    // Tranche sur l'année demandée
    const start = new Date(Math.max(s.getTime(), new Date(year, 0, 1).getTime()));
    const end = new Date(Math.min(e.getTime(), new Date(year, 11, 31).getTime()));
    if (start.getTime() > end.getTime()) return;

    // Répartition simple en jours calendaires
    let d = new Date(start.getTime());
    while (d.getTime() <= end.getTime()) {
      months[d.getMonth()].days += 1;
      d.setDate(d.getDate() + 1);
    }
  });

  const total = months.reduce((acc, x) => acc + (x.days || 0), 0);
  return { months, total };
}

export default function LeavesPage() {
  const r = useRouter();
  const { session: hookSession, profile: hookProfile } = useAuth();

  // Session source de vérité (copie du pattern de /app)
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
      } catch (_) {}
    };
  }, []);

  const session = sbSession ?? hookSession ?? null;
  const userId = session?.user?.id || null;
  const userEmail = session?.user?.email || null;

  // Fallback profil direct (pour lire role si besoin)
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
      } catch (_) {
        // ignore
      }
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

  const todayIso = useMemo(() => fmtISODate(new Date()), []);

  // Redirects
  useEffect(() => {
    if (!authChecked) return;

    if (!userId) {
      if (typeof window !== "undefined") {
        window.location.replace("/login?stay=1&next=/leaves");
      }
      return;
    }
  }, [authChecked, userId]);

  const hardLogout = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch (_) {}

    if (typeof window === "undefined") return;

    try {
      const ls = window.localStorage;
      const ss = window.sessionStorage;

      const collectKeys = (st) => {
        const out = [];
        try {
          for (let i = 0; i < st.length; i++) {
            const k = st.key(i);
            if (k) out.push(k);
          }
        } catch (_) {}
        return out;
      };

      const shouldRemove = (k) =>
        k.startsWith("sb-") || k.includes("supabase") || k.includes("auth-token") || k.includes("token") || k.includes("refresh");

      collectKeys(ls).forEach((k) => {
        if (shouldRemove(k)) ls.removeItem(k);
      });
      collectKeys(ss).forEach((k) => {
        if (shouldRemove(k)) ss.removeItem(k);
      });
    } catch (_) {}

    window.location.replace("/login?stay=1&next=/leaves");
  }, []);

  // Garde-fou "token invalide / session expirée"
  const [sessionExpired, setSessionExpired] = useState(false);
  const [sessionExpiredMsg, setSessionExpiredMsg] = useState("");

  const markSessionExpired = useCallback(async (msg) => {
    setSessionExpired(true);
    setSessionExpiredMsg(msg || "Session expirée. Veuillez vous reconnecter.");
    try {
      await supabase.auth.signOut();
    } catch (_) {}
  }, []);

  const isLikelyAuthError = (x) => {
    const s = String(x || "").toLowerCase();
    return (
      s.includes("invalid token") ||
      s.includes("invalid jwt") ||
      s.includes("jwt expired") ||
      s.includes("token expired") ||
      s.includes("session expired") ||
      s.includes("expired") ||
      s.includes("auth")
    );
  };

  const handleAuthResponse = useCallback(
    async (resp, j) => {
      if (!resp) return false;
      const err = j?.error || j?.message || "";
      if (resp.status === 401 || isLikelyAuthError(err)) {
        await markSessionExpired("Session expirée. Veuillez vous reconnecter.");
        return true;
      }
      return false;
    },
    [markSessionExpired]
  );

  // ----------------------------
  // 1) Congés du user (demandes)
  // ----------------------------
  const [leaves, setLeaves] = useState([]);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(false);

  const loadMyLeaves = useCallback(async () => {
    if (!userId) return;
    setLoadErr("");
    setLoading(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token || "";
      const resp = await fetch("/api/leaves/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await resp.json().catch(() => ({}));
      if (await handleAuthResponse(resp, j)) return;
      if (!resp.ok) throw new Error(j?.error || "Impossible de charger vos congés.");
      setLeaves(Array.isArray(j?.leaves) ? j.leaves : []);
    } catch (e) {
      setLeaves([]);
      setLoadErr(e?.message || "Impossible de charger vos congés.");
    } finally {
      setLoading(false);
    }
  }, [userId, handleAuthResponse]);

  useEffect(() => {
    loadMyLeaves();
  }, [loadMyLeaves]);

  // ----------------------------
  // 2) Solde officiel (bulletin) + Admin editor
  // ----------------------------
  const [canManageBalances, setCanManageBalances] = useState(false);
  const [myBalance, setMyBalance] = useState(null);
  const [balanceRows, setBalanceRows] = useState([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceErr, setBalanceErr] = useState("");

  const loadBalances = useCallback(async () => {
    if (!userId) return;
    setBalanceErr("");
    setBalanceLoading(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token || "";
      const resp = await fetch("/api/leaves/balances", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await resp.json().catch(() => ({}));
      if (await handleAuthResponse(resp, j)) return;
      if (!resp.ok) throw new Error(j?.error || "Impossible de charger les soldes.");

      const cm = !!j?.can_manage;
      setCanManageBalances(cm);

      if (cm) {
        setBalanceRows(Array.isArray(j?.rows) ? j.rows : []);
        setMyBalance(null);
      } else {
        setMyBalance(j?.balance || null);
        setBalanceRows([]);
      }
    } catch (e) {
      setCanManageBalances(false);
      setMyBalance(null);
      setBalanceRows([]);
      setBalanceErr(e?.message || "Impossible de charger les soldes.");
    } finally {
      setBalanceLoading(false);
    }
  }, [userId, handleAuthResponse]);

  useEffect(() => {
    loadBalances();
  }, [loadBalances]);

  const officialTotalRemaining = useMemo(() => {
    const b = myBalance;
    if (!b) return null;
    return clampNonNeg(Number(b.cp_remaining_n1 || 0) + Number(b.cp_remaining_n || 0));
  }, [myBalance]);

  const asOf = useMemo(() => (myBalance?.as_of ? String(myBalance.as_of) : null), [myBalance]);

  // Déduction automatique: uniquement congés APPROVED et uniquement pour la période après le bulletin (as_of)
  const approved = useMemo(() => leaves.filter((l) => String(l.status).toLowerCase() === "approved"), [leaves]);

  const approvedUpcomingOuvrables = useMemo(() => {
    if (!asOf) {
      // Si pas de bulletin, on ne déduit rien (sinon ça fait peur aux vendeuses)
      return 0;
    }
    const startCut = addDaysIso(asOf, 1); // après la date du bulletin
    let sum = 0;

    approved.forEach((l) => {
      const s = String(l.start_date || "");
      const e = String(l.end_date || "");
      if (!s || !e) return;

      // On ignore les congés totalement passés
      if (e < todayIso) return;

      const from = s < todayIso ? todayIso : s;
      const from2 = from < startCut ? startCut : from;

      if (e < from2) return;

      sum += daysOuvrablesInclusive(from2, e);
    });

    return sum;
  }, [approved, asOf, todayIso]);

  const forecastRemaining = useMemo(() => {
    if (officialTotalRemaining === null) return null;
    return clampNonNeg(officialTotalRemaining - approvedUpcomingOuvrables);
  }, [officialTotalRemaining, approvedUpcomingOuvrables]);

  // Admin editor state
  const [editSellerId, setEditSellerId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editMsg, setEditMsg] = useState("");

  const startEdit = useCallback((row) => {
    setEditSellerId(row?.seller_id || null);
    setEditMsg("");
    setEditForm({
      seller_id: row?.seller_id || "",
      full_name: row?.full_name || "",
      as_of: row?.as_of || todayIso,
      cp_acquired_n: numFmt(row?.cp_acquired_n || 0),
      cp_taken_n: numFmt(row?.cp_taken_n || 0),
      cp_remaining_n: numFmt(row?.cp_remaining_n || 0),
      cp_acquired_n1: numFmt(row?.cp_acquired_n1 || 0),
      cp_taken_n1: numFmt(row?.cp_taken_n1 || 0),
      cp_remaining_n1: numFmt(row?.cp_remaining_n1 || 0),
    });
  }, [todayIso]);

  const cancelEdit = useCallback(() => {
    setEditSellerId(null);
    setEditForm(null);
    setEditMsg("");
    setEditBusy(false);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editForm?.seller_id) return;
    setEditMsg("");
    setEditBusy(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token || "";

      const payload = {
        seller_id: editForm.seller_id,
        as_of: editForm.as_of,
        cp_acquired_n: editForm.cp_acquired_n,
        cp_taken_n: editForm.cp_taken_n,
        cp_remaining_n: editForm.cp_remaining_n,
        cp_acquired_n1: editForm.cp_acquired_n1,
        cp_taken_n1: editForm.cp_taken_n1,
        cp_remaining_n1: editForm.cp_remaining_n1,
      };

      const resp = await fetch("/api/leaves/balances", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const j = await resp.json().catch(() => ({}));
      if (await handleAuthResponse(resp, j)) return;
      if (!resp.ok) throw new Error(j?.error || "Impossible d'enregistrer.");

      setEditMsg("✅ Enregistré.");
      await loadBalances();
      setEditSellerId(null);
      setEditForm(null);
    } catch (e) {
      setEditMsg(`❌ ${e?.message || "Impossible d'enregistrer."}`);
    } finally {
      setEditBusy(false);
    }
  }, [editForm, handleAuthResponse, loadBalances]);

  // ----------------------------
  // Form demande congé (vendeuse)
  // ----------------------------
  const [startDate, setStartDate] = useState(todayIso);
  const [endDate, setEndDate] = useState(todayIso);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const submit = useCallback(async () => {
    if (!userId) return;
    setMsg("");

    const s = String(startDate || "").trim();
    const e = String(endDate || "").trim();

    if (!s || !e) {
      setMsg("Veuillez choisir une date de début et une date de fin.");
      return;
    }
    if (e < s) {
      setMsg("La date de fin doit être après (ou égale à) la date de début.");
      return;
    }
    if (s < todayIso) {
      setMsg("La demande doit commencer aujourd'hui ou plus tard.");
      return;
    }

    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token || "";

      const resp = await fetch("/api/leaves/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          start_date: s,
          end_date: e,
          reason: reason || null,
        }),
      });
      const j = await resp.json().catch(() => ({}));
      if (await handleAuthResponse(resp, j)) return;
      if (!resp.ok) throw new Error(j?.error || "Impossible d'envoyer la demande.");

      setMsg("✅ Demande envoyée. Elle apparaîtra ici avec le statut « En attente ».");
      setReason("");
      await loadMyLeaves();
    } catch (e2) {
      setMsg(`❌ ${e2?.message || "Impossible d'envoyer la demande."}`);
    } finally {
      setBusy(false);
    }
  }, [userId, startDate, endDate, reason, todayIso, loadMyLeaves, handleAuthResponse]);

  // Résumé année en cours (jours calendaires, comme avant)
  const nowYear = new Date().getFullYear();
  const breakdown = useMemo(() => computeYearMonthBreakdown(approved, nowYear), [approved, nowYear]);

  const isAdminLike = canManageBalances || role === "admin";

  const backTarget = useCallback(() => {
    // Admin: on évite /app (ça déconnecte l'admin)
    if (isAdminLike) return r.back();
    return r.push("/app");
  }, [isAdminLike, r]);

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-6">
      <Head>
        <title>Congés</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div className="flex items-center justify-between">
        <div>
          <div className="hdr">Congés</div>
          <div className="text-sm text-gray-600">
            Connecté(e) : {displayName}{" "}
            {isAdminLike ? <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-gray-900 text-white">Admin</span> : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="btn" onClick={backTarget}>
            Retour
          </button>
          <button className="btn" onClick={hardLogout}>
            Se déconnecter
          </button>
        </div>
      </div>

      {sessionExpired && (
        <div className="card border-red-300 bg-red-50">
          <div className="hdr text-red-700">Session expirée</div>
          <div className="text-sm text-red-700">
            {sessionExpiredMsg || "Votre session a expiré. Reconnectez-vous pour continuer."}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button className="btn" onClick={() => window.location.replace("/login?stay=1&next=/leaves")}>
              Se reconnecter
            </button>
            <button className="btn" onClick={() => setSessionExpired(false)}>
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* Bloc Solde bulletin + prévision (vendeuse) */}
      {!isAdminLike && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="hdr">Solde congés payés</div>
              <div className="text-xs text-gray-500">Basé sur le bulletin + déduction automatique des congés approuvés à venir.</div>
            </div>
            <button className="btn" onClick={loadBalances} disabled={balanceLoading}>
              {balanceLoading ? "Chargement..." : "Rafraîchir"}
            </button>
          </div>

          {balanceErr ? <div className="text-sm text-red-600 mb-2">{balanceErr}</div> : null}

          {!myBalance ? (
            <div className="text-sm text-gray-600">
              Solde bulletin non renseigné pour l'instant. (L'admin peut le mettre à jour depuis l'écran admin.)
            </div>
          ) : (
            <div className="grid md:grid-cols-3 gap-3">
              <div className="border rounded-2xl p-3">
                <div className="text-xs text-gray-500">Bulletin (au)</div>
                <div className="text-sm font-medium">{asOf ? fmtFr(asOf) : "—"}</div>
              </div>

              <div className="border rounded-2xl p-3">
                <div className="text-xs text-gray-500">Total restant (bulletin)</div>
                <div className="text-sm font-medium">{officialTotalRemaining === null ? "—" : `${numFmt(officialTotalRemaining)} j`}</div>
                <div className="text-xs text-gray-500 mt-1">
                  N-1 : {numFmt(myBalance.cp_remaining_n1 || 0)} j · N : {numFmt(myBalance.cp_remaining_n || 0)} j
                </div>
              </div>

              <div className="border rounded-2xl p-3">
                <div className="text-xs text-gray-500">Reste estimé</div>
                <div className="text-sm font-medium">{forecastRemaining === null ? "—" : `${numFmt(forecastRemaining)} j`}</div>
                <div className="text-xs text-gray-500 mt-1">
                  Déduction (approved à venir) : {numFmt(approvedUpcomingOuvrables)} j (jours ouvrables, dimanches exclus)
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Admin: édition des soldes bulletin */}
      {isAdminLike && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="hdr">Admin · Soldes congés (bulletin)</div>
              <div className="text-xs text-gray-500">
                Saisis ici les chiffres du bulletin. L'app déduira automatiquement les congés "approved" pour afficher un reste estimé.
              </div>
            </div>
            <button className="btn" onClick={loadBalances} disabled={balanceLoading}>
              {balanceLoading ? "Chargement..." : "Rafraîchir"}
            </button>
          </div>

          {balanceErr ? <div className="text-sm text-red-600 mb-2">{balanceErr}</div> : null}

          {editForm && editSellerId ? (
            <div className="border rounded-2xl p-3 mb-3">
              <div className="flex items-center justify-between">
                <div className="font-medium text-sm">Modifier: {editForm.full_name || "Vendeuse"}</div>
                <div className="flex items-center gap-2">
                  <button className="btn" onClick={cancelEdit} disabled={editBusy}>
                    Annuler
                  </button>
                  <button className="btn" onClick={saveEdit} disabled={editBusy}>
                    {editBusy ? "Enregistrement..." : "Enregistrer"}
                  </button>
                </div>
              </div>

              <div className="grid md:grid-cols-3 gap-3 mt-3">
                <div>
                  <div className="text-sm mb-1">Date bulletin (as_of)</div>
                  <input
                    type="date"
                    className="input"
                    value={editForm.as_of}
                    onChange={(e) => setEditForm((x) => ({ ...(x || {}), as_of: e.target.value }))}
                  />
                </div>

                <div className="md:col-span-3">
                  <div className="text-xs text-gray-500 mb-2">N-1 (ex: 2024-2025)</div>
                  <div className="grid md:grid-cols-3 gap-3">
                    <div>
                      <div className="text-sm mb-1">Acquis N-1</div>
                      <input
                        className="input"
                        value={editForm.cp_acquired_n1}
                        onChange={(e) => setEditForm((x) => ({ ...(x || {}), cp_acquired_n1: e.target.value }))}
                      />
                    </div>
                    <div>
                      <div className="text-sm mb-1">Pris N-1</div>
                      <input
                        className="input"
                        value={editForm.cp_taken_n1}
                        onChange={(e) => setEditForm((x) => ({ ...(x || {}), cp_taken_n1: e.target.value }))}
                      />
                    </div>
                    <div>
                      <div className="text-sm mb-1">Solde N-1</div>
                      <input
                        className="input"
                        value={editForm.cp_remaining_n1}
                        onChange={(e) => setEditForm((x) => ({ ...(x || {}), cp_remaining_n1: e.target.value }))}
                      />
                    </div>
                  </div>
                </div>

                <div className="md:col-span-3">
                  <div className="text-xs text-gray-500 mb-2">N (période en cours)</div>
                  <div className="grid md:grid-cols-3 gap-3">
                    <div>
                      <div className="text-sm mb-1">Acquis N</div>
                      <input
                        className="input"
                        value={editForm.cp_acquired_n}
                        onChange={(e) => setEditForm((x) => ({ ...(x || {}), cp_acquired_n: e.target.value }))}
                      />
                    </div>
                    <div>
                      <div className="text-sm mb-1">Pris N</div>
                      <input
                        className="input"
                        value={editForm.cp_taken_n}
                        onChange={(e) => setEditForm((x) => ({ ...(x || {}), cp_taken_n: e.target.value }))}
                      />
                    </div>
                    <div>
                      <div className="text-sm mb-1">Solde N</div>
                      <input
                        className="input"
                        value={editForm.cp_remaining_n}
                        onChange={(e) => setEditForm((x) => ({ ...(x || {}), cp_remaining_n: e.target.value }))}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {editMsg ? <div className="text-sm mt-3">{editMsg}</div> : null}
            </div>
          ) : null}

          {balanceRows.length === 0 ? (
            <div className="text-sm text-gray-600">Aucune vendeuse trouvée.</div>
          ) : (
            <div className="space-y-2">
              {balanceRows.map((row) => {
                const total = clampNonNeg(Number(row.cp_remaining_n1 || 0) + Number(row.cp_remaining_n || 0));
                return (
                  <div key={row.seller_id} className="border rounded-2xl p-3 flex items-center justify-between">
                    <div className="text-sm">
                      <div className="font-medium">{row.full_name || "—"}</div>
                      <div className="text-xs text-gray-500">
                        Bulletin: {row.as_of ? fmtFr(row.as_of) : "—"} · Total restant:{" "}
                        <span className="font-medium">{numFmt(total)} j</span>
                      </div>
                    </div>
                    <button className="btn" onClick={() => startEdit(row)}>
                      Modifier
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="text-xs text-gray-500 mt-3">
            Astuce: tu peux saisir les valeurs telles qu'elles apparaissent sur la fiche (avec virgule, ex: 20,00).
          </div>
        </div>
      )}

      {/* Le reste de la page: demandes vendeuse + historique */}
      {!isAdminLike && (
        <>
          <div className="card">
            <div className="hdr mb-2">Demander un congé</div>

            <div className="grid md:grid-cols-3 gap-3 items-end">
              <div>
                <div className="text-sm mb-1">Début</div>
                <input type="date" className="input" value={startDate} min={todayIso} onChange={(e) => setStartDate(e.target.value)} />
              </div>

              <div>
                <div className="text-sm mb-1">Fin</div>
                <input type="date" className="input" value={endDate} min={startDate || todayIso} onChange={(e) => setEndDate(e.target.value)} />
              </div>

              <div className="md:col-span-3">
                <div className="text-sm mb-1">Motif (optionnel)</div>
                <input type="text" className="input" placeholder="ex: vacances" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>

              <div>
                <button className="btn" disabled={busy || sessionExpired} onClick={submit}>
                  {busy ? "Envoi..." : "Envoyer la demande"}
                </button>
              </div>
            </div>

            {msg && <div className="text-sm mt-3">{msg}</div>}
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <div className="hdr">Mes congés</div>
              <button className="btn" onClick={loadMyLeaves} disabled={loading}>
                {loading ? "Chargement..." : "Rafraîchir"}
              </button>
            </div>

            {loadErr && <div className="text-sm text-red-600 mb-2">{loadErr}</div>}

            {leaves.length === 0 ? (
              <div className="text-sm text-gray-600">Aucune demande de congé pour l'instant.</div>
            ) : (
              <ul className="space-y-2">
                {leaves.map((l) => {
                  const days = daysInclusive(l.start_date, l.end_date);
                  return (
                    <li key={l.id} className="flex items-center justify-between border rounded-2xl p-3">
                      <div className="text-sm">
                        <div className="font-medium">
                          Du {fmtFr(l.start_date)} au {fmtFr(l.end_date)}{" "}
                          <span className="text-gray-600">({days} jour{days > 1 ? "s" : ""})</span>
                        </div>
                        {l.reason ? <div className="text-gray-600">Motif : {l.reason}</div> : null}
                      </div>
                      <span className="text-xs px-2 py-1 rounded-full text-white" style={{ backgroundColor: statusBg(l.status) }}>
                        {statusLabel(l.status)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="card">
            <div className="hdr mb-2">Résumé (congés approuvés)</div>
            <div className="text-sm text-gray-700 mb-3">
              Année {nowYear} : <span className="font-medium">{breakdown.total}</span> jour{breakdown.total > 1 ? "s" : ""} approuvé
              {breakdown.total > 1 ? "s" : ""}.
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {breakdown.months.map((m) => (
                <div key={m.monthIndex} className="border rounded-xl p-2 text-sm flex items-center justify-between">
                  <span className="capitalize">{m.label}</span>
                  <span className="font-medium">{m.days}</span>
                </div>
              ))}
            </div>

            <div className="text-xs text-gray-500 mt-3">
              (Résumé en jours calendaires, basé sur les congés approuvés. Le solde "reste estimé" utilise les jours ouvrables, dimanches exclus.)
            </div>
          </div>
        </>
      )}
    </div>
  );
}
