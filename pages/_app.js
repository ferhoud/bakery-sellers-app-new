// pages/_app.js
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import "../styles/globals.css"; // garde si tu utilises Tailwind / styles globaux

function InstallButton({ deferredPrompt, onInstalled }) {
  if (!deferredPrompt) return null;

  const handleClick = async () => {
    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice; // "accepted" | "dismissed"
      if (outcome === "accepted") onInstalled?.();
    } catch (e) {
      console.error("Install prompt error:", e);
    }
  };

  return (
    <button
      className="btn"
      onClick={handleClick}
      style={{ position: "fixed", right: 16, bottom: 16, zIndex: 9999 }}
    >
      ⬇️ Installer l’app
    </button>
  );
}

export default function MyApp({ Component, pageProps }) {
  const router = useRouter();
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installHidden, setInstallHidden] = useState(false);

  // Affichage du bouton d'installation PWA
  useEffect(() => {
    if (typeof window === "undefined") return;

    const installedFlag = localStorage.getItem("pwaInstalled") === "1";
    setInstallHidden(installedFlag);

    const onBeforeInstall = (e) => {
      e.preventDefault(); // bloque le prompt auto
      if (localStorage.getItem("pwaInstalled") === "1") return;
      setDeferredPrompt(e);
    };

    const onInstalled = () => {
      try { localStorage.setItem("pwaInstalled", "1"); } catch {}
      setDeferredPrompt(null);
      setInstallHidden(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Refresh doux à la réception d'un push depuis le SW
  const reloadSoft = useCallback(() => {
    router.replace(router.asPath);
  }, [router]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const handler = (e) => {
      if (e?.data?.type === "push") {
        reloadSoft();
        if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [reloadSoft]);

  // Quand l’app revient en premier plan → petit refresh doux
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "visible") reloadSoft();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [reloadSoft]);

  return (
    <>
      <Head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Bakery Sellers</title>

        {/* Police globale soignée */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />

        {/* Icônes Material (si tu utilises <span className="material-symbols-outlined">home</span>) */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@200..700&display=swap"
          rel="stylesheet"
        />
        <style>{`
          .material-symbols-outlined {
            font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
          }
        `}</style>
      </Head>

      {/* Application */}
      <Component {...pageProps} />

      {/* Bouton d'installation flottant (si pas encore installée) */}
      {!installHidden && (
        <InstallButton
          deferredPrompt={deferredPrompt}
          onInstalled={() => setInstallHidden(true)}
        />
      )}

      {/* Styles de secours si tes classes .btn/.card/.hdr/.input ne sont pas définies dans globals.css */}
      <style jsx global>{`
        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
          padding: .55rem .9rem; border: 1px solid #e5e7eb; border-radius: .75rem;
          background: #111827; color: #fff; font-weight: 600; cursor: pointer;
        }
        .btn:hover { opacity: .9; }
        .card { border: 1px solid #e5e7eb; border-radius: 1rem; padding: 1rem; background: #fff; }
        .hdr { font-size: 1.125rem; font-weight: 700; }
        .hdr .sub { font-weight: 400; color: #6b7280; font-size: .95rem; }
        .select, .input {
          width: 100%; border: 1px solid #e5e7eb; border-radius: .75rem; padding: .5rem .75rem; background: #fff;
        }
      `}</style>
    </>
  );
}
