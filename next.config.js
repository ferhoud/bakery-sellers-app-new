// next.config.js
module.exports = {
  reactStrictMode: true,
  async redirects() {
    return [{ source: "/", destination: "/admin", permanent: false }];
  },
};
