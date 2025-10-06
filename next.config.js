/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // ⚠️ Décommente temporairement si besoin d'un déploiement immédiat
    ignoreDuringBuilds: true,
  },
  // Si tu as aussi des erreurs TypeScript bloquantes, tu peux activer :
  // typescript: { ignoreBuildErrors: true },
};

module.exports = nextConfig;
