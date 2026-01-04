// pages/_app.js
import "../styles/globals.css";
import { useEffect } from "react";

async function closeAllOriginNotifications() {
  if (!("serviceWorker" in navigator)) return;

  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;

  try {
    const notifs = await reg.getNotifications();
    notifs.forEach((n) => n.close());
  } catch (_) {}

  if ("clearAppBadge" in navigator) {
    try {
      await navigator.clearAppBadge();
    } catch (_) {}
  }
}

export default function App({ Component, pageProps }) {
  useEffect(() => {
    let reloaded = false;

    const onFocus = () => {
      closeAllOriginNotifications().catch(() => {});
    };

    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);

    // IMPORTANT: pas de await au top-level → tout ici, dans une IIFE async
    (async () => {
      if (!("serviceWorker" in navigator)) return;

      try {
        const reg = await navigator.serviceWorker.register("/sw.js", {
          updateViaCache: "none",
        });

        // Force un check update
        try {
          await reg.update();
        } catch (_) {}

        // Si une version attend, on la prend direct
        if (reg.waiting) {
          try {
            reg.waiting.postMessage({ type: "SKIP_WAITING" });
          } catch (_) {}
        }

        // Quand le nouveau SW prend le contrôle, reload 1 fois (évite les états “cassés”)
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (reloaded) return;
          reloaded = true;
          window.location.reload();
        });

        // Nettoyage notifs au démarrage
        await closeAllOriginNotifications();
      } catch (e) {
        // Ne bloque jamais l’app si SW casse
        console.warn("[sw] register error:", e);
      }
    })();

    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return <Component {...pageProps} />;
}
