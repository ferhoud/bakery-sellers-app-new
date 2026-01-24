// pages/supervisor.js
import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import WeekNav from "../components/WeekNav";
import { startOfWeek, fmtISODate } from "../lib/date";

function pad2(n) {
  return String(n).padStart(2, "0");
}
function localISODate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}


function frDateFromISO(iso) {
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
const SHIFT_DAY = ["MORNING", "MIDDAY", "EVENING"];

const SHIFT_TEXT = {
  MORNING: { title: "Matin", time: "6h30–13h30" },
  MIDDAY: { title: "Midi", time: "6h30–13h30" },
  EVENING: { title: "Soir", time: "13h30–20h30" },
  SUNDAY_EXTRA: { title: "9h–13h30", time: "" },
};

const COLOR_OVERRIDES = {
  Antonia: "#e57373",
  Olivia: "#64b5f6",
  Colleen: "#81c784",
  Ibtissam: "#ba68c8",
};

const PALETTE = [
  "#60a5fa",
  "#a78bfa",
  "#22c55e",
  "#f87171",
  "#34d399",
  "#fb7185",
  "#38bdf8",
  "#c084fc",
  "#fbbf24",
  "#4ade80",
];

function hash31(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

function pickColor(name) {
  const n = (name || "").trim();
  if (!n) return "#e5e7eb";
  if (COLOR_OVERRIDES[n]) return COLOR_OVERRIDES[n];
  const idx = hash31(n) % PALETTE.length;
  return PALETTE[idx];
}

function dayLabelFR(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const s = new Intl.DateTimeFormat("fr-FR", { weekday: "long" }).format(d);
  return (s || "").toUpperCase();
}

function isSundayISO(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.getDay() === 0;
}

function weekShiftOrderForDate(iso) {
  // IMPORTANT: dimanche -> mettre 9h-13h30 juste après Matin
  // et garder Soir en dernier.
  if (isSundayISO(iso)) return ["MORNING", "SUNDAY_EXTRA", "MIDDAY", "EVENING"];
  return ["MORNING", "MIDDAY", "EVENING"];
}

function cardStyle(bg) {
  return {
    background: bg,
    color: "#fff",
    borderRadius: 16,
    padding: 16,
    minHeight: 88,
  };
}

function emptyCardStyle() {
  return {
    background: "#f3f4f6",
    color: "#6b7280",
    borderRadius: 16,
    padding: 16,
    minHeight: 88,
    border: "1px dashed #d1d5db",
  };
}

function Modal({ open, title, children, onClose }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 9999,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 520,
          borderRadius: 16,
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
          <button className="btn" type="button" onClick={onClose} style={{ padding: "8px 12px" }}>
            Fermer
          </button>
        </div>
        <div style={{ height: 12 }} />
        {children}
      </div>
    </div>
  );
}

export default function SupervisorPage() {
  const router = useRouter();
  const todayISO = useMemo(() => localISODate(new Date()), []);
  const [focusDate, setFocusDate] = useState(todayISO);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [payload, setPayload] = useState(null);
  const [now, setNow] = useState(null);

  // Largeur écran -> sur desktop on passe en GRID (pas de scroll horizontal)
  const [isWide, setIsWide] = useState(false);
  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 1100);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Horloge HH:MM:SS (client only, évite les soucis d’hydration)
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);


  const monday = useMemo(() => fmtISODate(startOfWeek(new Date(`${focusDate}T12:00:00`))), [focusDate]);

  // Modal déconnexion (mot de passe masqué)
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutPw, setLogoutPw] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutErr, setLogoutErr] = useState("");
  const pwRef = useRef(null);

  async function fetchPlan(dateISO) {
    setLoading(true);
    setErr("");

    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;

    if (!token) {
      router.replace(`/login?next=/supervisor&stay=1`);
      return;
    }

    const r = await fetch(`/api/supervisor/plan?date=${encodeURIComponent(dateISO)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setErr(`Erreur API (${r.status}) ${t}`);
      setLoading(false);
      return;
    }

    const j = await r.json();
    setPayload(j);
    setLoading(false);
  }

  useEffect(() => {
    fetchPlan(focusDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDate]);

  const assignments = payload?.assignments || {};
  const weekDates = payload?.dates || [];
  const dayRow = assignments[focusDate] || {};

  function openLogout() {
    setLogoutErr("");
    setLogoutPw("");
    setLogoutOpen(true);
    setTimeout(() => pwRef.current?.focus?.(), 0);
  }

  async function confirmLogout() {
    setLogoutBusy(true);
    setLogoutErr("");

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;

      if (!token) {
        router.replace(`/login?stay=1`);
        return;
      }

      const r = await fetch("/api/supervisor/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: String(logoutPw || "") }),
      });

      const j = await r.json().catch(() => ({}));

      if (!r.ok || !j?.ok) {
        const msg =
          j?.error === "BAD_PASSWORD"
            ? "Mot de passe incorrect."
            : j?.error
            ? `Déconnexion refusée: ${j.error}`
            : `Déconnexion refusée (${r.status})`;
        setLogoutErr(msg);
        return;
      }

      await supabase.auth.signOut();
      router.replace("/login?stay=1");
    } finally {
      setLogoutBusy(false);
    }
  }

  function onPrevWeek() {
    const d = new Date(`${focusDate}T12:00:00`);
    d.setDate(d.getDate() - 7);
    setFocusDate(fmtISODate(d));
  }
  function onNextWeek() {
    const d = new Date(`${focusDate}T12:00:00`);
    d.setDate(d.getDate() + 7);
    setFocusDate(fmtISODate(d));
  }
  function onToday() {
    setFocusDate(todayISO);
  }

  return (
    <>
      <Head>
        <title>Superviseur</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <Modal
        open={logoutOpen}
        title="Déconnexion superviseur"
        onClose={() => {
          if (logoutBusy) return;
          setLogoutOpen(false);
        }}
      >
        <div style={{ fontSize: 13, opacity: 0.8 }}>Entrez le mot de passe superviseur pour autoriser la déconnexion.</div>

        <div style={{ height: 10 }} />

        <input
          ref={pwRef}
          className="input"
          type="password"
          value={logoutPw}
          onChange={(e) => setLogoutPw(e.target.value)}
          placeholder="Mot de passe superviseur"
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmLogout();
            if (e.key === "Escape") setLogoutOpen(false);
          }}
        />

        {logoutErr ? (
          <div style={{ marginTop: 10, padding: "10px 12px", border: "1px solid #ef4444", borderRadius: 12, background: "rgba(239,68,68,.06)" }}>
            {logoutErr}
          </div>
        ) : null}

        <div style={{ height: 12 }} />

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn" type="button" onClick={() => setLogoutOpen(false)} disabled={logoutBusy}>
            Annuler
          </button>
          <button className="btn" type="button" onClick={confirmLogout} disabled={logoutBusy || !logoutPw}>
            {logoutBusy ? "Vérification…" : "Se déconnecter"}
          </button>
        </div>
      </Modal>

      {/* ✅ pleine largeur */}
      <div style={{ width: "100%", margin: 0, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Écran superviseur</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Lecture seule · Jour: {focusDate}
              {payload?.monday ? ` · Semaine: ${payload.monday} → ${payload.sunday}` : ""}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn" onClick={() => fetchPlan(focusDate)} disabled={loading}>
              Rafraîchir
            </button>

            {/* ✅ Bouton Pointage */}
            <Link className="btn" href="/supervisor/checkin">
              Pointage
            </Link>

            <button className="btn" onClick={openLogout}>
              Déconnexion
            </button>
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
              <div className="hdr">Planning du jour - {frDateFromISO(focusDate)} · {fmtTime(now)}</div>

              <div style={{ height: 12 }} />
              {Array.isArray(payload?.absences?.[focusDate]) && payload.absences[focusDate].length > 0 ? (
                <div
                  style={{
                    marginTop: 10,
                    marginBottom: 6,
                    padding: "10px 12px",
                    borderRadius: 14,
                    border: "1px solid #fecaca",
                    background: "#fff7ed",
                  }}
                >
                  <div style={{ fontWeight: 800 }}>Absence(s) aujourd’hui</div>
                  <div style={{ marginTop: 4, opacity: 0.9 }}>
                    {(payload.absences[focusDate] || [])
                      .map((a) => (a.full_name || "").trim())
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </div>
                </div>
              ) : null}


              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(220px, 1fr))", gap: 12 }}>
                {SHIFT_DAY.map((code) => {
                  const a = dayRow?.[code];
                  const name = (a?.full_name || "").trim();
                  const bg = name ? pickColor(name) : null;

                  return (
                    <div key={code} style={name ? cardStyle(bg) : emptyCardStyle()}>
                      <div style={{ fontSize: 14, opacity: name ? 1 : 0.8 }}>
                        {SHIFT_TEXT[code].title} ({SHIFT_TEXT[code].time})
                      </div>
                      <div style={{ marginTop: 8, fontSize: 18, fontWeight: 800 }}>{name || "—"}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ height: 14 }} />

            <div className="card">
              <div className="hdr">Planning de la semaine</div>
              <div style={{ height: 10 }} />

              <WeekNav monday={monday} onPrev={onPrevWeek} onToday={onToday} onNext={onNextWeek} />

              <div style={{ height: 14 }} />

              {/* ✅ Sur desktop: GRID 7 colonnes (pas de scroll) / Sur mobile: scroll horizontal */}
              <div
                style={
                  isWide
                    ? {
                        display: "grid",
                        gridTemplateColumns: "repeat(7, minmax(150px, 1fr))",
                        gap: 12,
                        width: "100%",
                      }
                    : {
                        display: "flex",
                        gap: 12,
                        overflowX: "auto",
                        paddingBottom: 4,
                      }
                }
              >
                {weekDates.map((d) => {
                  const row = assignments[d] || {};
                  const isFocus = d === focusDate;
                  const order = weekShiftOrderForDate(d);

                  return (
                    <div
                      key={d}
                      onClick={() => setFocusDate(d)}
                      style={{
                        minWidth: isWide ? 0 : 170,
                        borderRadius: 16,
                        padding: 12,
                        background: "#fff",
                        border: isFocus ? "2px solid #2563eb" : "1px solid #e5e7eb",
                        cursor: "pointer",
                      }}
                      title="Cliquer pour afficher le planning du jour"
                    >
                      <div style={{ fontSize: 12, opacity: 0.6, letterSpacing: 0.6 }}>{dayLabelFR(d)}</div>
                      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800 }}>{d}</div>

                      <div style={{ height: 10 }} />

                      {order.map((code) => {
                        const a = row?.[code];
                        const name = (a?.full_name || "").trim();
                        if (!name) return null;

                        const bg = pickColor(name);

                        const topLine =
                          code === "SUNDAY_EXTRA"
                            ? "9h-13h30"
                            : `${SHIFT_TEXT[code].title} (${SHIFT_TEXT[code].time})`;

                        return (
                          <div key={code} style={{ ...cardStyle(bg), padding: 14, minHeight: 0, marginTop: 10 }}>
                            <div style={{ fontSize: 14, opacity: 0.95 }}>{topLine}</div>
                            <div style={{ marginTop: 8, fontSize: 16, fontWeight: 800 }}>{name}</div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
