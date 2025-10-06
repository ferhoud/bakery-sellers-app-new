/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  eslint: {
    // Laisse ESLint en local, mais n'empêche pas le build sur Vercel
    ignoreDuringBuilds: true,
  },
};
