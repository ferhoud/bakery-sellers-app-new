/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: '/', destination: '/admin', permanent: false },
    ];
  },
};

module.exports = nextConfig;
