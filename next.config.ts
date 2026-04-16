import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  // pino and pino-pretty use Node.js built-ins (node:stream, worker_threads)
  // that webpack cannot resolve. Externalize them so they load from
  // node_modules at runtime instead of being bundled.
  serverExternalPackages: ["pino", "pino-pretty"],
};

export default withNextIntl(nextConfig);
