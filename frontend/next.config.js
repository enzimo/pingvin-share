/** @type {import('next').NextConfig} */
const { version } = require("./package.json");

module.exports = {
  outputFileTracingRoot: __dirname,
  output: "standalone",
  env: {
    VERSION: version,
  },
  // Files remain available as downloads; untrusted images bypass native decoding.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Content-Security-Policy",
            value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};
