import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="fr">
      <Head>
        {/* 👇 ligne essentielle pour les caractères */}
        <meta charSet="utf-8" />

        {/* PWA */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0ea5e9" />

        {/* iOS: mode "vraie app" quand ajouté à l’écran d’accueil */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Vendeuses" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />

        {/* (Optionnel) aide certains navigateurs Android */}
        <meta name="mobile-web-app-capable" content="yes" />

        {/* Enregistre le service worker au chargement (utile pour l'installation Chrome/Android) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  });
})();
`,
          }}
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
