// pages/_app.js
import { useEffect } from "react";
import Head from "next/head";
import "../styles/globals.css"; // ← supprime cette ligne si le fichier n'existe pas

export default function MyApp({ Component, pageProps }) {
  // ⚠️ Temporaire : on désactive tout SW et on vide les caches pour forcer la dernière build
  useEffect(() => {
    (async () => {
      if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
      } catch {}

      try {
        if (window.caches?.keys) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
        }
      } catch {}
    })();
  }, []);

  return (
    <>
      <Head>
        {/* Ajuste si besoin */}
        <meta name="theme-color" content="#ffffff" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
