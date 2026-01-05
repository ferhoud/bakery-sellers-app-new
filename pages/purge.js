// pages/purge.js
import { useEffect, useState } from "react";

export default function Purge() {
  const [log, setLog] = useState(["Purge en cours…"]);

  useEffect(() => {
    (async () => {
      const add = (s) => setLog((p) => [...p, s]);

      // 0) Cookies server-side (HttpOnly inclus)
      try {
        const r = await fetch("/api/purge-cookies", { method: "POST" });
        const j = await r.json().catch(() => ({}));
        add(`✅ Cookies purgés (server): ${j.ok ? "OK" : "KO"} • ${j.cleared ?? 0}`);
      } catch (e) {
        add(`⚠️ purge-cookies failed: ${e?.message || e}`);
      }

      // 1) Unregister SW
      if ("serviceWorker" in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
          add(`✅ Service Worker supprimé (${regs.length})`);
        } catch (e) {
          add(`⚠️ SW unregister failed: ${e?.message || e}`);
        }
      } else {
        add("ℹ️ Pas de Service Worker");
      }

      // 2) Clear Cache Storage
      if (window.caches?.keys) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
          add(`✅ Caches supprimés (${keys.length})`);
        } catch (e) {
          add(`⚠️ Cache delete failed: ${e?.message || e}`);
        }
      }

      // 3) Clear Supabase tokens + storages
      try {
        const lsKeys = Object.keys(localStorage || {});
        const sbKeys = lsKeys.filter((k) => k.startsWith("sb-") || k.toLowerCase().includes("supabase"));
        sbKeys.forEach((k) => localStorage.removeItem(k));
        add(`✅ localStorage Supabase supprimé (${sbKeys.length})`);
      } catch (e) {
        add(`⚠️ localStorage failed: ${e?.message || e}`);
      }

      try {
        const ssKeys = Object.keys(sessionStorage || {});
        ssKeys.forEach((k) => sessionStorage.removeItem(k));
        add(`✅ sessionStorage vidé (${ssKeys.length})`);
      } catch (e) {
        add(`⚠️ sessionStorage failed: ${e?.message || e}`);
      }

      // 4) Redirect
      const ts = Date.now();
      add("➡️ Redirection vers /login…");
      setTimeout(() => {
        window.location.replace(`/login?stay=1&next=/app&purged=1&ts=${ts}`);
      }, 900);
    })();
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 18, fontWeight: 700 }}>Purge (dépannage)</h1>
      <p style={{ marginTop: 8, color: "#374151" }}>
        Cette page supprime Service Worker + caches + tokens + cookies, puis renvoie vers /login.
      </p>
      <pre
        style={{
          marginTop: 12,
          background: "#111827",
          color: "#e5e7eb",
          padding: 12,
          borderRadius: 12,
          overflowX: "auto",
        }}
      >
        {log.join("\n")}
      </pre>
    </div>
  );
}
