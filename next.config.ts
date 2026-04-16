import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  // pino uses Node.js built-ins that webpack cannot resolve in Edge Runtime.
  serverExternalPackages: ["pino"],
};

export default withNextIntl(nextConfig);
