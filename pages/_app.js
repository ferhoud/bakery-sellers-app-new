// pages/_app.js
import "../styles/globals.css";
import { useEffect } from "react";

async function registerSWOnce() {
  if (!("serviceWorker" in navigator)) return;
  try {
    // Register (ou garde l’existant si déjà enregistré)
    await navigator.serviceWorker.register("/sw.js");
  } catch (_) {}
}

async function closeAllOriginNotifications() {
  if (!("serviceWorker" in navigator)) return;

  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;

  // Ferme toutes les notifs créées via CE service worker (même origine / même registration)
  const notifs = await reg.getNotifications(); // :contentReference[oaicite:0]{index=0}
  notifs.forEach((n) => n.close()); // :contentReference[oaicite:1]{index=1}

  // Optionnel: badge (Chrome/Android surtout)
  if ("clearAppBadge" in navigator) {
    try { await navigator.clearAppBadge(); } catch (_) {}
  }
}

export default function App({ Component, pageProps }) {
  useEffect(() => {
    registerSWOnce().then(() => closeAllOriginNotifications());

    const onVisible = () => {
      if (document.visibilityState === "visible") closeAllOriginNotifications();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", closeAllOriginNotifications);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", closeAllOriginNotifications);
    };
  }, []);

  return <Component {...pageProps} />;
}
