// pages/admin/checkins.js
// Page admin dédiée: "Pointages manquants" (alerte après 60 min).
// - Poll toutes les 60s
// - Notifications navigateur (si autorisées)
// - Ne marque PAS absent automatiquement
// ✅ Fix hydration: on calcule Notification.permission + date après mount (client only)

import Head from "next/head";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

function pad2(n) {
  return String(n).padStart(2, "0");
}
function parisTodayISO() {
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
}
function fmtHM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${pad2(m)}`;
}
function humanSince(min) {
  if (min < 60) return `${min} min`;
  return fmtHM(min);
}

const SHIFT_LABEL = {
  MORNING: "Matin",
  MIDDAY: "Matin",
  EVENING: "Après-midi",
  SUNDAY_EXTRA: "Dimanche",
};

export default function AdminCheckinsPage() {
  const [mounted, setMounted] = useState(false);
  const [day, setDay] = useState(""); // date Europe/Paris, calculée côté client
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  // Notification state, calculé côté client
  const [notifState, setNotifState] = useState("…");

  const seenRef = useRef(new Set());
  const lastKeyRef = useRef("");

  const storageKey = useMemo(() => {
    return day ? `seen_missing_checkins_${day}` : "";
  }, [day]);

  // Mount: init date + Notification.permission (client-only)
  useEffect(() => {
    setMounted(true);
    setDay(parisTodayISO());

    if (typeof Notification === "undefined") {
      setNotifState("unsupported");
    } else {
      setNotifState(Notification.permission);
    }
  }, []);

  // Load seen from localStorage (quand day est connu)
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey) || "[]";
      const arr = JSON.parse(raw);
      seenRef.current = new Set(Array.isArray(arr) ? arr : []);
    } catch {
      seenRef.current = new Set();
    }
  }, [storageKey]);

  function saveSeen() {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(Array.from(seenRef.current)));
    } catch {}
  }

  async function fetchMissing() {
    if (!day) return;
    setErr("");

    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) {
      window.location.href = `/login?next=/admin/checkins&stay=1`;
      return;
    }

    const r = await fetch(`/api/admin/checkins/missing?day=${encodeURIComponent(day)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setErr(`Erreur API (${r.status}) ${t}`);
      setItems([]);
      setLoading(false);
      return;
    }

    const j = await r.json().catch(() => ({}));
    if (!j?.ok) {
      setErr(`Erreur: ${j?.error || "UNKNOWN"}`);
      setItems([]);
      setLoading(false);
      return;
    }

    const list = Array.isArray(j.items) ? j.items : [];
    setItems(list);
    setLoading(false);

    // Browser notifications for new items
    if (mounted && typeof Notification !== "undefined" && Notification.permission === "granted" && list.length) {
      for (const it of list) {
        const key = `${it.day}:${it.seller_id}:${it.shift_code}`;
        if (seenRef.current.has(key)) continue;

        const name = it.full_name || "Vendeuse";
        const label = SHIFT_LABEL[it.shift_code] || it.shift_code;
        const body = `${name} • ${label} • non pointée depuis ${humanSince(it.minutes_since_start || 0)}.`;

        // eslint-disable-next-line no-new
        new Notification("⚠️ Pointage manquant", { body });

        seenRef.current.add(key);
      }
      saveSeen();
    }

    lastKeyRef.current = `${day}:${list.length}:${Date.now()}`;
  }

  // Start polling only when day is ready
  useEffect(() => {
    if (!day) return;
    fetchMissing();
    const id = setInterval(fetchMissing, 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  async function askNotif() {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setNotifState(p);
  }

  function markSeen(it) {
    const key = `${it.day}:${it.seller_id}:${it.shift_code}`;
    seenRef.current.add(key);
    saveSeen();
    setItems((cur) => [...cur]);
  }

  return (
    <>
      <Head>
        <title>Admin • Pointages manquants</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div style={{ width: "100%", padding: 16, maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900 }}>Pointages manquants</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Alerte après 60 minutes • Date: {day || "…"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn" onClick={fetchMissing} disabled={loading || !day}>
              Rafraîchir
            </button>
            <Link className="btn" href="/admin">Retour admin</Link>
          </div>
        </div>

        <div style={{ height: 14 }} />

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div>
              <div className="hdr">Notifications navigateur</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Statut: <b>{notifState}</b>
              </div>
            </div>

            {mounted && typeof Notification !== "undefined" && Notification.permission !== "granted" ? (
              <button className="btn" onClick={askNotif}>Activer</button>
            ) : null}
          </div>

          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
            Astuce: laisse cette page ouverte en admin. Si une vendeuse n’a pas pointé 1h après son début, tu reçois une alerte.
          </div>
        </div>

        <div style={{ height: 14 }} />

        {loading ? (
          <div className="card">Chargement…</div>
        ) : err ? (
          <div className="card" style={{ borderColor: "#ef4444" }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Erreur</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{err}</div>
          </div>
        ) : items.length === 0 ? (
          <div className="card">
            <div style={{ fontWeight: 800 }}>Aucun pointage manquant</div>
            <div style={{ marginTop: 6, opacity: 0.8 }}>Tout va bien 🎯</div>
          </div>
        ) : (
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 900 }}>⚠️ {items.length} vendeur(s) non pointé(s)</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Mise à jour auto chaque minute</div>
            </div>

            <div style={{ height: 12 }} />

            <div style={{ display: "grid", gap: 10 }}>
              {items.map((it) => {
                const key = `${it.day}:${it.seller_id}:${it.shift_code}`;
                const alreadySeen = seenRef.current.has(key);
                return (
                  <div
                    key={key}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 14,
                      padding: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 900, fontSize: 16 }}>
                        {it.full_name || "Vendeuse"}{" "}
                        <span style={{ fontSize: 12, opacity: 0.7 }}>
                          • {SHIFT_LABEL[it.shift_code] || it.shift_code}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, opacity: 0.85 }}>
                        Non pointée depuis <b>{humanSince(it.minutes_since_start || 0)}</b>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span style={{ fontSize: 12, opacity: 0.7 }}>{alreadySeen ? "vu" : "nouveau"}</span>
                      <button className="btn" onClick={() => markSeen(it)}>Marquer vu</button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 14, fontSize: 13, opacity: 0.85 }}>
              Ensuite: tu vérifies les caméras et, si besoin, tu appliques un retard dans l’admin. Sinon tu ne fais rien: les heures restent comptées.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
