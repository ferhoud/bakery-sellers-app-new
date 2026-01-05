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

async function resetServiceWorkerAndCachesOnce() {
  const KEY = "sw_reset_done_2026_01_05_v2";
  try {
    if (localStorage.getItem(KEY) === "1") return;
    localStorage.setItem(KEY, "1");
  } catch (_) {
    // si localStorage bloqué, on ne force pas
    return;
  }

  // Unregister SW
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
  } catch (_) {}

  // Purge caches
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
    }
  } catch (_) {}
}

export default function App({ Component, pageProps }) {
  useEffect(() => {
    let disposed = false;

    const onFocus = () => {
      if (document.visibilityState && document.visibilityState !== "visible") return;
      closeAllOriginNotifications().catch(() => {});
    };

    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);

    (async () => {
      // Kill-switch si besoin (tu peux mettre NEXT_PUBLIC_DISABLE_SW=1 sur Vercel)
      if (process.env.NEXT_PUBLIC_DISABLE_SW === "1") return;
      if (!("serviceWorker" in navigator)) return;

      try {
        // ✅ réparation une fois
        await resetServiceWorkerAndCachesOnce();
        if (disposed) return;

        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });

        try {
          await reg.update();
        } catch (_) {}

        if (reg.waiting) {
          try {
            reg.waiting.postMessage({ type: "SKIP_WAITING" });
          } catch (_) {}
        }

        await closeAllOriginNotifications();
      } catch (e) {
        console.warn("[sw] init error:", e?.message || e);
      }
    })();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return <Component {...pageProps} />;
}
