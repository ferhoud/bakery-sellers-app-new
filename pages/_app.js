// pages/_app.js
import { useEffect, useRef } from "react";
import Head from "next/head";
import "../styles/globals.css";
import { AuthProvider } from "@/lib/useAuth";

export default function MyApp({ Component, pageProps }) {
  const reloadedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller && !reloadedRef.current) {
              reloadedRef.current = true;
              setTimeout(() => window.location.reload(), 250);
            }
          });
        });
      })
      .catch(() => {});

    const onCtrl = () => {
      if (!reloadedRef.current) {
        reloadedRef.current = true;
        setTimeout(() => window.location.reload(), 150);
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onCtrl);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onCtrl);
  }, []);

  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#111111" />
      </Head>
      <AuthProvider>
        <Component {...pageProps} />
      </AuthProvider>
    </>
  );
}
