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
  } catch {
    return null;
  }
}

function fmtFr(iso) {
  const d = parseIso(iso);
  if (!d) return String(iso || "—");
  return d.toLocaleDateString("fr-FR");
}

function addDaysIso(iso, n) {
  const d = parseIso(iso);
  if (!d) return iso;
  d.setDate(d.getDate() + n);
  return fmtISODate(d);
}

// Jours ouvrables: Lundi → Samedi (dimanche exclu). (Sans gestion des jours fériés pour l'instant)
function daysOuvrablesInclusive(startIso, endIso) {
  const a = parseIso(startIso);
  const b = parseIso(endIso);
  if (!a || !b) return 0;
  if (b.getTime() < a.getTime()) return 0;

  let count = 0;
  const cur = new Date(a.getTime());
  while (cur.getTime() <= b.getTime()) {
    if (cur.getDay() !== 0) count += 1; // 0 = dimanche
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Overlap en jours ouvrables sur une fenêtre [windowStart..windowEnd] inclusive
function overlapOuvrables(leaveStartIso, leaveEndIso, windowStart, windowEnd) {
  const a = parseIso(leaveStartIso);
  const b = parseIso(leaveEndIso);
  if (!a || !b) return 0;

  const s = new Date(Math.max(a.getTime(), windowStart.getTime()));
  const e = new Date(Math.min(b.getTime(), windowEnd.getTime()));
  if (e.getTime() < s.getTime()) return 0;

  let count = 0;
  const cur = new Date(s.getTime());
  while (cur.getTime() <= e.getTime()) {
    if (cur.getDay() !== 0) count += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function computeYearMonthBreakdownOuvrables(approvedLeaves, year) {
  const months = Array.from({ length: 12 }).map((_, m) => {
    const start = new Date(year, m, 1);
    const end = new Date(year, m + 1, 0);
    let days = 0;
    for (const l of approvedLeaves) {
      days += overlapOuvrables(l.start_date, l.end_date, start, end);
    }
    return {
      monthIndex: m,
      label: start.toLocaleDateString("fr-FR", { month: "long" }),
      days,
    };
  });

  const total = months.reduce((s, x) => s + (x.days || 0), 0);
  return { months, total };
}

function statusLabel(s) {
  switch (String(s || "").toLowerCase()) {
    case "pending":
      return "En attente";
    case "approved":
      return "Approuvé";
    case "rejected":
      return "Refusé";
    case "cancelled":
      return "Annulé";
    default:
      return s || "—";
  }
}

function statusBg(s) {
  switch (String(s || "").toLowerCase()) {
    case "approved":
      return "#16a34a";
    case "pending":
      return "#f59e0b";
    case "rejected":
      return "#dc2626";
    case "cancelled":
      return "#6b7280";
    default:
      return "#2563eb";
  }
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

    // /leaves réservé aux vendeuses
    if (role === "admin") {
      (async () => {
        try {
          await supabase.auth.signOut();
        } catch (_) {}
        if (typeof window !== "undefined") {
          window.location.replace("/login?stay=1&next=/leaves");
        }
      })();
      return;
    }
  }, [authChecked, userId, role]);

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
        k.startsWith("sb-") ||
        k.includes("supabase") ||
        k.includes("auth-token") ||
        k.includes("token") ||
        k.includes("refresh") ||
        k.includes("LAST_OPEN_PATH"); // évite les boucles

      collectKeys(ls).forEach((k) => {
        if (shouldRemove(k)) ls.removeItem(k);
      });
      collectKeys(ss).forEach((k) => {
        if (shouldRemove(k)) ss.removeItem(k);
      });
    } catch (_) {}

    window.location.replace("/login?stay=1&next=/leaves");
  }, []);

  // Data: demandes congés
  const [leaves, setLeaves] = useState([]);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(false);

  // Solde bulletin (table leave_balances)
  const [balance, setBalance] = useState(null);
  const [balanceErr, setBalanceErr] = useState("");
  const [balanceLoading, setBalanceLoading] = useState(false);

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

  const loadMyLeaves = useCallback(async () => {
    if (!userId) return;
    setLoadErr("");
    setLoading(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token || "";
      const resp = await fetch("/api/leaves/my", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
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

  const loadMyBalance = useCallback(async () => {
    if (!userId) return;
    setBalanceErr("");
    setBalanceLoading(true);
    try {
      const { data, error } = await supabase
        .from("leave_balances")
        .select(
          "as_of, cp_acquired_n, cp_taken_n, cp_remaining_n, cp_acquired_n1, cp_taken_n1, cp_remaining_n1"
        )
        .eq("seller_id", userId)
        .maybeSingle();

      if (error) throw error;
      setBalance(data || null);
    } catch (e) {
      setBalance(null);
      setBalanceErr(e?.message || "Impossible de charger le solde (bulletin).");
    } finally {
      setBalanceLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadMyLeaves();
    loadMyBalance();
  }, [loadMyLeaves, loadMyBalance]);

  // Form
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
      // Le solde bulletin ne bouge pas tout seul, mais la prévision oui (car basée sur la liste)
    } catch (e2) {
      setMsg(`❌ ${e2?.message || "Impossible d'envoyer la demande."}`);
    } finally {
      setBusy(false);
    }
  }, [userId, startDate, endDate, reason, todayIso, loadMyLeaves, handleAuthResponse]);

  const approved = useMemo(
    () => leaves.filter((l) => String(l.status).toLowerCase() === "approved"),
    [leaves]
  );

  // Solde officiel bulletin
  const official = useMemo(() => {
    if (!balance) return null;
    const n = Number(balance.cp_remaining_n || 0) || 0;
    const n1 = Number(balance.cp_remaining_n1 || 0) || 0;
    return {
      as_of: balance.as_of || null,
      remaining_n: n,
      remaining_n1: n1,
      total_remaining: n + n1,
      acquired_n: Number(balance.cp_acquired_n || 0) || 0,
      taken_n: Number(balance.cp_taken_n || 0) || 0,
      acquired_n1: Number(balance.cp_acquired_n1 || 0) || 0,
      taken_n1: Number(balance.cp_taken_n1 || 0) || 0,
    };
  }, [balance]);

  // Prévision automatique : on déduit uniquement les congés approuvés APRÈS la date "as_of" du bulletin.
  const forecast = useMemo(() => {
    const asOf = official?.as_of || todayIso;
    const startIso = addDaysIso(asOf, 1);
    const start = parseIso(startIso);
    if (!start) return { startIso, approvedFutureDays: 0, estimatedRemaining: null };
    const farEnd = new Date(2099, 11, 31);

    let total = 0;
    for (const l of approved) {
      // On ne compte que la partie après startIso
      total += overlapOuvrables(l.start_date, l.end_date, start, farEnd);
    }

    const est = official ? official.total_remaining - total : null;
    return { startIso, approvedFutureDays: total, estimatedRemaining: est };
  }, [approved, official, todayIso]);

  const nowYear = new Date().getFullYear();
  const breakdown = useMemo(
    () => computeYearMonthBreakdownOuvrables(approved, nowYear),
    [approved, nowYear]
  );

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-6">
      <Head>
        <title>Congés</title>
      </Head>

      <div className="flex items-center justify-between">
        <div>
          <div className="hdr">Congés</div>
          <div className="text-sm text-gray-600">Connecté(e) : {displayName}</div>
        </div>

        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => r.push("/app")}>
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

      {/* Bloc solde CP */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div className="hdr">Solde congés payés</div>
          <button className="btn" onClick={() => loadMyBalance()} disabled={balanceLoading}>
            {balanceLoading ? "Chargement..." : "Rafraîchir"}
          </button>
        </div>

        <div className="text-xs text-gray-500 mt-1">
          Compteur basé sur le bulletin (officiel) + prévision automatique selon les congés approuvés dans l'application.
          (Calcul en jours ouvrables: lundi → samedi, dimanche exclu.)
        </div>

        {balanceErr ? <div className="text-sm text-red-600 mt-2">{balanceErr}</div> : null}

        {!official ? (
          <div className="text-sm text-gray-700 mt-3">
            Solde bulletin non renseigné. (L'admin le met à jour quand nécessaire.)
          </div>
        ) : (
          <div className="mt-3 grid md:grid-cols-2 gap-3">
            <div className="border rounded-2xl p-3">
              <div className="text-sm font-medium">Officiel (bulletin)</div>
              <div className="text-xs text-gray-600 mt-1">
                Mis à jour au {official.as_of ? fmtFr(official.as_of) : "—"}
              </div>

              <div className="mt-3 text-sm grid grid-cols-3 gap-2">
                <div className="text-gray-600">CP N-1</div>
                <div className="text-right text-gray-600">Solde</div>
                <div className="text-right font-medium">{official.remaining_n1.toFixed(2)}</div>

                <div className="text-gray-600">CP N</div>
                <div className="text-right text-gray-600">Solde</div>
                <div className="text-right font-medium">{official.remaining_n.toFixed(2)}</div>

                <div className="text-gray-600">Total</div>
                <div className="text-right text-gray-600">Restant</div>
                <div className="text-right font-semibold">{official.total_remaining.toFixed(2)}</div>
              </div>
            </div>

            <div className="border rounded-2xl p-3">
              <div className="text-sm font-medium">Prévision (appli)</div>
              <div className="text-xs text-gray-600 mt-1">
                Déduit automatiquement les congés approuvés après le {fmtFr(forecast.startIso)}.
              </div>

              <div className="mt-3 text-sm grid grid-cols-3 gap-2">
                <div className="text-gray-600">Approuvés à venir</div>
                <div className="text-right text-gray-600">Jours</div>
                <div className="text-right font-medium">{forecast.approvedFutureDays}</div>

                <div className="text-gray-600">Reste estimé</div>
                <div className="text-right text-gray-600">Jours</div>
                <div className="text-right font-semibold">
                  {forecast.estimatedRemaining === null ? "—" : forecast.estimatedRemaining.toFixed(2)}
                </div>
              </div>

              <div className="text-xs text-gray-500 mt-2">
                Si le reste estimé ne colle pas avec la paie: l'admin met à jour le bulletin, et la prévision se recalera toute
                seule.
              </div>
            </div>
          </div>
        )}
      </div>

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
          <button className="btn" onClick={() => { loadMyLeaves(); loadMyBalance(); }} disabled={loading}>
            {loading ? "Chargement..." : "Rafraîchir"}
          </button>
        </div>

        {loadErr && <div className="text-sm text-red-600 mb-2">{loadErr}</div>}

        {leaves.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune demande de congé pour l'instant.</div>
        ) : (
          <ul className="space-y-2">
            {leaves.map((l) => {
              const days = daysOuvrablesInclusive(l.start_date, l.end_date);
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
          Année {nowYear} : <span className="font-medium">{breakdown.total}</span> jour{breakdown.total > 1 ? "s" : ""} ouvrable{breakdown.total > 1 ? "s" : ""} approuvé{breakdown.total > 1 ? "s" : ""}.
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
          Calcul en jours ouvrables (lundi → samedi, dimanche exclu), basé sur les congés approuvés.
        </div>
      </div>
    </div>
  );
}
