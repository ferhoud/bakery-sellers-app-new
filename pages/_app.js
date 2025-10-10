import "../styles/globals.css";
import { AuthProvider, useAuth } from "@/lib/useAuth";
import { useEffect, useState } from "react";
import Link from "next/link";

function Shell({ Component, pageProps }) {
  const { session, loading } = useAuth();
  const [stuck, setStuck] = useState(false);
  const [envOK, setEnvOK] = useState(true);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) setEnvOK(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { if (loading) setStuck(true); }, 8000);
    return () => clearTimeout(t);
  }, [loading]);

  // SW auto-update pour éviter les vieilles versions en PWA
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistrations()
      .then(regs => {
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
      })
      .catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      setTimeout(() => window.location.reload(), 150);
    });
  }, []);

  if (!envOK) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Configuration manquante</h1>
        <p>Variables d’environnement Supabase absentes.</p>
        <ul>
          <li><code>NEXT_PUBLIC_SUPABASE_URL</code></li>
          <li><code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code></li>
        </ul>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Chargement…</div>
        {!session && stuck && (
          <div style={{ marginTop: 10 }}>
            <p>Ça semble bloqué. Essaie :</p>
            <ol>
              <li>Rafraîchir (Ctrl+F5) ou navigation privée</li>
              <li>
                Aller au{" "}
                <Link href="/login" style={{ color: "#2563eb", textDecoration: "underline" }}>
                  login
                </Link>
              </li>
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
