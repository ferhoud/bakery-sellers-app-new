/* pages/_app.js */
import { useEffect, useRef } from "react";
import Head from "next/head";
import "../styles/globals.css";

// ⬇️ Si ton hook useAuth expose un AuthProvider, on l'utilise.
//    Sinon, laisse ce import et je t’enverrai le fichier provider.
import { AuthProvider } from "@/lib/useAuth";

export default function MyApp({ Component, pageProps }) {
  const reloadedRef = useRef(false);

  // Enregistre le Service Worker + gère les updates proprement
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Enregistrement basique
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Si un nouveau SW est trouvé, on attend qu'il passe "installed"
        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            // Quand le nouveau SW est prêt, on force un reload 1x
            if (newWorker.state === "installed" && navigator.serviceWorker.controller && !reloadedRef.current) {
              reloadedRef.current = true;
              // Donne le temps au SW de prendre la main
              setTimeout(() => window.location.reload(), 250);
            }
          });
        });
      })
      .catch(() => {
        // Ignore silencieusement si /sw.js n'est pas encore présent
      });

    // Si le contrôleur change (skipWaiting/claim) => reload 1x
    const onControllerChange = () => {
      if (!reloadedRef.current) {
        reloadedRef.current = true;
        setTimeout(() => window.location.reload(), 150);
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);

  return (
    <>
      {/* Meta PWA basiques (ok même sans _document.js) */}
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Mets ton vrai chemin si manifest.json existe à la racine /public */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#111111" />
      </Head>

      {/* Fournit le contexte d'auth à toute l'app (useAuth) */}
      <AuthProvider>
        <Component {...pageProps} />
      </AuthProvider>
    </>
  );
}
