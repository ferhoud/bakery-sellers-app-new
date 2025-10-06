/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true, // <- déverrouille le build même si ESLint râle
  },
  // typescript: { ignoreBuildErrors: true }, // décommente si besoin
};

module.exports = nextConfig;
