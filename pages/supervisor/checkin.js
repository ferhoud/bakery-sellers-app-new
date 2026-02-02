// pages/supervisor/checkin.js
import Head from "next/head";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

function pad2(n) { return String(n).padStart(2, "0"); }
function localISODate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function frDateFromISO(iso) {
  // iso: YYYY-MM-DD -> JJ-MM-YYYY
  const s = (iso || "").toString();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const [, y, mo, d] = m;
  return `${d}-${mo}-${y}`;
}
function fmtTime(d) {
  if (!d) return "--:--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const SHIFT_LABELS = {
  MORNING: "Matin (6h30–13h30)",
  MIDDAY: "Midi (6h30–13h30)",
  EVENING: "Soir (13h30–20h30)",
  SUNDAY_EXTRA: "Dimanche (9h–13h30)",
};

const CHECKIN_OPEN_BEFORE_MIN = 30; // 30 min avant
const CHECKIN_HIDE_AFTER_MIN = 120; // 2h
const SOFT_REFRESH_MS = 30000; // 30s

function plannedMinutesFromShift(shiftCode) {
  const sc = String(shiftCode || "").toUpperCase();
  if (sc === "EVENING") return 13 * 60 + 30; // 13:30
  if (sc === "SUNDAY_EXTRA") return 9 * 60;  // 09:00
  // MORNING + MIDDAY => même arrivée 06:30
  return 6 * 60 + 30;
}

function minutesNowLocal(d) {
  if (!d) return null;
  return d.getHours() * 60 + d.getMinutes();
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

export default function SupervisorCheckinPage() {
  const today = useMemo(() => localISODate(new Date()), []);
  const [now, setNow] = useState(null);

  const [loading, setLoading] = useState(true);
  const [softRefreshing, setSoftRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const [plan, setPlan] = useState(null);

  const [selected, setSelected] = useState(null); // {seller_id, full_name, shift_code}
  const [pw, setPw] = useState("");
  const [pwFocused, setPwFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {code, late_minutes,...}
  const [msg, setMsg] = useState("");

  useEffect(() => {
    // PWA/tablette: on mémorise que la dernière page utilisée est superviseur
    try { window.localStorage?.setItem?.("LAST_OPEN_PATH", "/supervisor/checkin"); } catch {}
  }, []);

  useEffect(() => {
    // Horloge HH:MM:SS (client only)
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  async function fetchPlan(opts = {}) {
    const soft = !!opts.soft;

    if (!soft) setLoading(true);
    else setSoftRefreshing(true);

    setErr("");
    if (!soft) {
      setMsg("");
      setResult(null);
      setSelected(null);
      setPw("");
    }

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;

      if (!token) {
        window.location.href = `/login?next=/supervisor/checkin&stay=1`;
        return;
      }

      const r = await fetch(`/api/supervisor/plan?date=${encodeURIComponent(today)}&ts=${Date.now()}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        if (r.status === 401 || r.status === 403) {
          // Session perdue -> on renvoie proprement au login
          window.location.href = `/login?next=/supervisor/checkin&stay=1`;
          return;
        }
        setErr(`Erreur API (${r.status}) ${t}`);
        return;
      }

      const j = await r.json().catch(() => null);
      if (!j || j.ok === false) {
        const e = j?.error ? String(j.error) : "Réponse API invalide.";
        // Session manquante -> login
        if (String(e).toLowerCase().includes("auth session")) {
          window.location.href = `/login?next=/supervisor/checkin&stay=1`;
          return;
        }
        setErr(e);
        return;
      }

      setPlan(j);
    } finally {
      if (!soft) setLoading(false);
      setSoftRefreshing(false);
    }
  }

  useEffect(() => {
    fetchPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Refresh léger (sans casser la saisie du mot de passe)
    const t = setInterval(() => {
      // Si on tape le mot de passe, on laisse tranquille.
      if (pwFocused) return;
      // Si un mot de passe est en cours de saisie et qu'on n'a pas encore de résultat, on ne refresh pas.
      if (pw && !result) return;
      // Évite de lancer plusieurs fetch en même temps
      if (loading || softRefreshing) return;
      fetchPlan({ soft: true });
    }, SOFT_REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pwFocused, pw, result, loading, softRefreshing]);

  const todayAssignments = plan?.assignments?.[today] || {};

  const checkinsBySellerId = useMemo(() => {
    const m = {};
    const items = Array.isArray(plan?.checkins_today) ? plan.checkins_today : [];
    for (const it of items) {
      if (it?.seller_id) m[it.seller_id] = it;
    }
    return m;
  }, [plan]);

  const nowMin = useMemo(() => minutesNowLocal(now), [now]);

  const todays = useMemo(() => {
    const rows = [];
    for (const code of ["MORNING", "MIDDAY", "EVENING", "SUNDAY_EXTRA"]) {
      const a = todayAssignments?.[code];
      if (a?.seller_id) rows.push({ seller_id: a.seller_id, full_name: a.full_name || "", shift_code: code });
    }

    // 1) un seul bouton par vendeuse
    const uniq = uniqBy(rows, (x) => x.seller_id);

    // 2) on masque celles déjà pointées, et celles pour lesquelles la fenêtre est dépassée (>2h)
    return uniq.filter((s) => {
      const ck = checkinsBySellerId?.[s.seller_id] || null;
      if (ck?.confirmed_at) return false;

      if (nowMin != null) {
        const planned = plannedMinutesFromShift(s.shift_code);
        const start = planned - CHECKIN_OPEN_BEFORE_MIN;
        const end = planned + CHECKIN_HIDE_AFTER_MIN;
        if (nowMin < start) return false; // après la fenêtre: on laisse visible (pointage validé sans retard)
      }

      return true;
    });
  }, [todayAssignments, checkinsBySellerId, nowMin]);

  async function generateCode() {
    if (!selected?.seller_id) return;
    if (!pw) { setMsg("Saisis le mot de passe."); return; }

    setBusy(true);
    setMsg("");
    setResult(null);

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;

      if (!token) {
        window.location.href = `/login?next=/supervisor/checkin&stay=1`;
        return;
      }

      const r = await fetch("/api/supervisor/checkin-code", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ day: today, seller_id: selected.seller_id, password: pw }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        const e = j?.error || `HTTP ${r.status}`;
        setMsg(e === "BAD_PASSWORD" ? "Mot de passe incorrect." : `Erreur: ${e}`);
        return;
      }

      setResult(j);
      setPw(""); // on efface le mot de passe tout de suite
      // petit refresh soft pour que la page soit toujours à jour (sans casser l'écran)
      fetchPlan({ soft: true });
    } finally {
      setBusy(false);
    }
  }

  function copyCode() {
    if (!result?.code) return;
    navigator.clipboard?.writeText?.(result.code);
    setMsg("Code copié ✅");
    setTimeout(() => setMsg(""), 1500);
  }

  function nextSeller() {
    setSelected(null);
    setResult(null);
    setMsg("");
    setPw("");
    fetchPlan({ soft: true });
  }

  return (
    <>
      <Head>
        <title>Pointage</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div style={{ width: "100%", padding: 16, maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Pointage du jour</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Date: {frDateFromISO(today)} · Heure: {fmtTime(now)}
              {softRefreshing ? <span style={{ marginLeft: 10, opacity: 0.7 }}>Actualisation…</span> : null}
            </div>

            {Array.isArray(plan?.absences_today) && plan.absences_today.length > 0 ? (
              <div
                style={{
                  marginTop: 10,
                  padding: "10px 12px",
                  borderRadius: 14,
                  border: "1px solid #fecaca",
                  background: "#fff7ed",
                }}
              >
                <div style={{ fontWeight: 800 }}>Absence(s) aujourd’hui</div>
                <div style={{ marginTop: 4, opacity: 0.9 }}>
                  {plan.absences_today
                    .map((a) => (a.full_name || "").trim())
                    .filter(Boolean)
                    .join(", ") || "—"}
                </div>
              </div>
            ) : null}
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn" onClick={() => fetchPlan({ soft: true })} disabled={loading || busy}>
              Rafraîchir
            </button>
            <Link className="btn" href="/supervisor">Retour planning</Link>
          </div>
        </div>

        <div style={{ height: 14 }} />

        {loading ? (
          <div className="card">Chargement…</div>
        ) : err ? (
          <div className="card" style={{ borderColor: "#ef4444" }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Erreur</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{err}</div>
          </div>
        ) : (
          <>
            <div className="card">
              <div className="hdr">Qui pointe aujourd’hui ?</div>
              <div style={{ height: 10 }} />

              {todays.length === 0 ? (
                <div style={{ opacity: 0.7 }}>Tout est pointé ✅ (ou fenêtre dépassée).</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {todays.map((s) => {
                    const active = selected?.seller_id === s.seller_id;
                    return (
                      <button
                        key={s.seller_id}
                        className="btn"
                        onClick={() => { setSelected(s); setResult(null); setMsg(""); setPw(""); }}
                        style={{
                          justifyContent: "space-between",
                          background: active ? "#111827" : "#0f172a",
                          opacity: active ? 1 : 0.92,
                        }}
                      >
                        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <b>{s.full_name || "—"}</b>
                          <span style={{ fontSize: 12, opacity: 0.8 }}>{SHIFT_LABELS[s.shift_code] || s.shift_code}</span>
                        </span>
                        <span style={{ fontSize: 12, opacity: 0.8 }}>{active ? "Sélectionnée" : "Choisir"}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ height: 14 }} />

            <div className="card">
              <div className="hdr">Générer le code</div>
              <div style={{ height: 10 }} />

              {!selected ? (
                <div style={{ opacity: 0.7 }}>Choisis une vendeuse ci-dessus.</div>
              ) : (
                <>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    Vendeuse: <b>{selected.full_name || "—"}</b> · {SHIFT_LABELS[selected.shift_code] || selected.shift_code}
                  </div>

                  <div style={{ height: 10 }} />

                  <input
                    className="input"
                    type="password"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    onFocus={() => setPwFocused(true)}
                    onBlur={() => setPwFocused(false)}
                    placeholder="Mot de passe de la vendeuse"
                    autoComplete="off"
                  />

                  <div style={{ height: 10 }} />

                  <button className="btn" onClick={generateCode} disabled={busy || !pw}>
                    {busy ? "Vérification…" : "Afficher le code du jour"}
                  </button>

                  {msg ? <div style={{ marginTop: 10, opacity: 0.85 }}>{msg}</div> : null}

                  {result?.ok ? (
                    <div style={{ marginTop: 14, padding: 14, border: "1px solid #e5e7eb", borderRadius: 14 }}>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>CODE DU JOUR (pour {selected.full_name || "—"})</div>
                      <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: 6 }}>{result.code}</div>
                      <div style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>
                        Retard détecté: <b>{result.late_minutes} min</b>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                        Date: {frDateFromISO(today)} · Heure: {fmtTime(now)}
                      </div>
                      <div style={{ height: 10 }} />
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button className="btn" onClick={copyCode}>Copier le code</button>
                        <button className="btn" onClick={nextSeller}>Passer à la suivante</button>
                      </div>
                      <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8 }}>
                        Ensuite: sur le compte vendeuse → <b>Pointage</b> → saisir ce code.
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
