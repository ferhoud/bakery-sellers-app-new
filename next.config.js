// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,

  // 🔴 IMPORTANT : permettre à Next de servir aussi les pages .ts/.tsx
  pageExtensions: ['ts', 'tsx', 'js', 'jsx'],

  // (Optionnel) Si des erreurs ESLint bloquent le build, décommente temporairement :
  // eslint: { ignoreDuringBuilds: true },

  // (Optionnel) Pendant une migration vers TypeScript, pour ne pas bloquer le build :
  // typescript: { ignoreBuildErrors: true },
};

module.exports = nextConfig;
