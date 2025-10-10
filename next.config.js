/** @type {import("next").NextConfig} */
const nextConfig = {
  eslint: {
    // TEMPORAIRE : on ignore les erreurs ESLint pendant le build Vercel
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
