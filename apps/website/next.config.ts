import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Where `next dev` forwards /api. In production nginx routes /api to the cloud service
// before a request ever reaches Next, so nothing here applies there.
const cloudOrigin = process.env.CLOUD_API_ORIGIN || "http://127.0.0.1:9089";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-hosted behind nginx, not on Vercel: a minimal server bundle to run in a container.
  output: "standalone",
  // Keep preview/test builds separate from a developer's running dev server.
  distDir: process.env.WEBSITE_BUILD_DIR || ".next",
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    return [{ source: "/api/:path*", destination: `${cloudOrigin}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
