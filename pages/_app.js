// pages/_app.js
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/router";
import "../styles/globals.css"; // garde si tu utilises Tailwind / styles globaux


function InstallButton({ deferredPrompt, onInstalled }) {
  if (!deferredPrompt) return null;

  const handleClick = async () => {
    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      // outcome: "accepted" | "dismissed"
      if (outcome === "accepted") {
        // onInstalled sera aussi appelé via "appinstalled", mais on le met ici au cas où
        onInstalled?.();
      }
    } catch (e) {
      console.error("Install prompt error:", e);
    }
  };

  return (
    <button
      className="btn"
      onClick={handleClick}
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9999,
      }}
    >
      ⬇️ Installer l’app
    </button>
  );
}

export default function MyApp({ Component, pageProps }) {
  const router = useRouter();
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installHidden, setInstallHidden] = useState(false);

  // Afficher le bouton d'installation PWA
  useEffect(() => {
    const installedFlag = typeof window !== "undefined" && localStorage.getItem("pwaInstalled") === "1";
    setInstallHidden(installedFlag);

    const onBeforeInstall = (e) => {
      // Empêche le prompt auto
      e.preventDefault();
      // Si déjà installée, on ne montre pas
      if (localStorage.getItem("pwaInstalled") === "1") return;
      setDeferredPrompt(e);
    };

    const onInstalled = () => {
      try {
        localStorage.setItem("pwaInstalled", "1");
      } catch {}
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

  // Écoute SW → rafraîchir les données/pages quand un push arrive
  const reloadSoft = useCallback(() => {
    // Recharger la page courante sans remonter l’historique
    router.replace(router.asPath);
  }, [router]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const handler = (e) => {
      // convention : le SW envoie { type: 'push' } après réception
      if (e?.data?.type === "push") {
        reloadSoft();
        // Nettoyer la pastille si supportée
        if (navigator.clearAppBadge) {
          navigator.clearAppBadge().catch(() => {});
        }
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [reloadSoft]);

  // Quand l’app revient en premier plan → petit refresh doux (utile si la page admin est ouverte)
  useEffect(() => {
    const onWake = () => reloadSoft();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [reloadSoft]);

  return (
    <>
      {/* Ton application */}
      <Component {...pageProps} />

      {/* Bouton d'installation flottant (si pas encore installée) */}
      {!installHidden && <InstallButton deferredPrompt={deferredPrompt} onInstalled={() => setInstallHidden(true)} />}

      {/* Styles de secours si tes classes .btn/.card/etc. ne sont pas encore définies quelque part */}
      <style jsx global>{`
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.55rem 0.9rem;
          border: 1px solid #e5e7eb;
          border-radius: 0.75rem;
          background: #111827;
          color: #fff;
          font-weight: 600;
          cursor: pointer;
        }
        .btn:hover { opacity: 0.9; }
        .card {
          border: 1px solid #e5e7eb;
          border-radius: 1rem;
          padding: 1rem;
          background: #fff;
        }
        .hdr {
          font-size: 1.125rem;
          font-weight: 700;
        }
        .hdr .sub { font-weight: 400; color: #6b7280; font-size: 0.95rem; }
        .select, .input {
          width: 100%;
          border: 1px solid #e5e7eb;
          border-radius: 0.75rem;
          padding: 0.5rem 0.75rem;
          background: #fff;
        }
      `}</style>
    </>
  );
}
