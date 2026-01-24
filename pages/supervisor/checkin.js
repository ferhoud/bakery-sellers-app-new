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
  const [err, setErr] = useState("");
  const [plan, setPlan] = useState(null);

  const [selected, setSelected] = useState(null); // {seller_id, full_name, shift_code}
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {code, late_minutes,...}
  const [msg, setMsg] = useState("");

  useEffect(() => {
    // Horloge HH:MM:SS (client only, évite les soucis d’hydration)
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  async function fetchPlan() {
    setLoading(true);
    setErr("");
    setMsg("");
    setResult(null);
    setSelected(null);
    setPw("");

    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) {
      window.location.href = `/login?next=/supervisor/checkin&stay=1`;
      return;
    }

    const r = await fetch(`/api/supervisor/plan?date=${encodeURIComponent(today)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setErr(`Erreur API (${r.status}) ${t}`);
      setLoading(false);
      return;
    }
    const j = await r.json();
    setPlan(j);
    setLoading(false);
  }

  useEffect(() => {
    fetchPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const todayAssignments = plan?.assignments?.[today] || {};
  const todays = useMemo(() => {
    const rows = [];
    for (const code of ["MORNING", "MIDDAY", "EVENING", "SUNDAY_EXTRA"]) {
      const a = todayAssignments?.[code];
      if (a?.seller_id) rows.push({ seller_id: a.seller_id, full_name: a.full_name || "", shift_code: code });
    }
    return uniqBy(rows, (x) => x.seller_id);
  }, [todayAssignments]);

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
            <button className="btn" onClick={fetchPlan} disabled={loading}>Rafraîchir</button>
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
                <div style={{ opacity: 0.7 }}>Aucune vendeuse planifiée aujourd’hui.</div>
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
                        <span style={{ fontSize: 12, opacity: 0.8 }}>Choisir</span>
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
                      <div style={{ fontSize: 12, opacity: 0.75 }}>CODE DU JOUR</div>
                      <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: 6 }}>{result.code}</div>
                      <div style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>
                        Retard détecté: <b>{result.late_minutes} min</b>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                        Date: {frDateFromISO(today)} · Heure: {fmtTime(now)}
                      </div>
                      <div style={{ height: 10 }} />
                      <button className="btn" onClick={copyCode}>Copier le code</button>
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
