import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  // pino uses Node.js built-ins that webpack cannot resolve in Edge Runtime.
  serverExternalPackages: ["pino"],
  // remark-pdf → jpeg-exif requires 'fs' which is unavailable in browser.
  // Stub it out on client side for both Turbopack (dev) and webpack (build).
  turbopack: {
    resolveAlias: {
      fs: { browser: "./src/lib/empty.ts" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
      };
    }
    return config;
  },
};

export default withNextIntl(nextConfig);
