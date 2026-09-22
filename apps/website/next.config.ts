import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep preview/test builds separate from a developer's running dev server.
  distDir: process.env.WEBSITE_BUILD_DIR || ".next",
};

export default withNextIntl(nextConfig);
