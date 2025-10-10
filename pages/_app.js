
// touch: 2025-10-10 _app with AuthProvider + defensive loader + SW updater

import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { AuthProvider, useAuth } from "@/lib/useAuth";
import { supabase } from "@/lib/supabaseClient";
import "../styles/globals.css";

function Shell({ Component, pageProps }) {
  const { session, loading } = useAuth();
  const r = useRouter();
  const [stuck, setStuck] = useState(false);
  const [envOK, setEnvOK] = useState(true);

  // Simple env sanity check
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) setEnvOK(false);
  }, []);

  // Detect long "loading" states (e.g., bad session, SW cache) and surface exit
  useEffect(() => {
    const t = setTimeout(() => {
      if (loading) setStuck(true);
    }, 8000);
    return () => clearTimeout(t);
  }, [loading]);

  // Proactively refresh session once if we're stuck
  useEffect(() => {
    if (!stuck) return;
    (async () => {
      try { await supabase.auth.getSession(); } catch {}
    })();
  }, [stuck]);

  // Service Worker: auto-update & reload on new versions to avoid stale bundles
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(reg => {
        reg.update().catch(() => {});
        if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            if (sw.state === "installed" && navigator.serviceWorker.controller) {
              sw.postMessage({ type: "SKIP_WAITING" });
              setTimeout(() => window.location.reload(), 150);
            }
          });
        });
      });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      setTimeout(() => window.location.reload(), 150);
    });
  }, []);

  if (!envOK) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Configuration manquante</h1>
        <p>Variables d'environnement Supabase absentes sur ce déploiement.</p>
        <ul>
          <li><code>NEXT_PUBLIC_SUPABASE_URL</code></li>
          <li><code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code></li>
        </ul>
        <p>Ajoute-les dans Vercel → Project Settings → Environment Variables, puis redeploie.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Chargement…</div>
        {!session && stuck && (
          <div style={{ marginTop: 10 }}>
            <p>Ça semble bloqué. Essaie :</p>
            <ol>
              <li>Rafraîchir (Ctrl+F5) ou ouvrir en navigation privée</li>
              <li>Si PWA installée, ré-ouvrir l'app (le Service Worker va se mettre à jour)</li>
              <li><a href="/login" style={{ color: "#2563eb", textDecoration: "underline" }}>Aller au login</a></li>
            </ol>
          </div>
        )}
      </div>
    );
  }

  return <Component {...pageProps} />;
}

export default function MyApp(props) {
  return (
    <AuthProvider>
      <Shell {...props} />
    </AuthProvider>
  );
}
