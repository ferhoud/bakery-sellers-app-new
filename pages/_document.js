import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="fr">
      <Head>
        {/* Encodage + viewport (important iOS/PWA) */}
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />

        {/* PWA */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0ea5e9" />

        {/* iOS: mode "vraie app" (standalone) quand ajouté à l’écran d’accueil */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Vendeuses" />
        {/* iOS préfère souvent un apple-touch-icon dédié (180x180 idéal). */}
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />

        {/* Android/Chrome (optionnel) */}
        <meta name="mobile-web-app-capable" content="yes" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
