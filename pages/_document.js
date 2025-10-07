// pages/_document.js
import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="fr">
      <Head>
        {/* Manifest PWA */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0ea5e9" />

        {/* iOS : ***OBLIGATOIRE*** pour ouvrir en plein écran (sans barre Safari) */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Vendeuses" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />

        {/* Favicon basique (optionnel si tu en as déjà) */}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* Viewport (souvent déjà présent ailleurs) */}
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
