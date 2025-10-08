// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // En-têtes HTTP pour certains fichiers statiques
  async headers() {
    return [
      {
        // Service Worker : jamais mis en cache
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          // Permet au SW de contrôler tout le scope "/"
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // (optionnel) éviter le cache agressif du manifest
        source: "/manifest.json",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
};

module.exports = nextConfig;
