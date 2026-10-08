import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // cc:begin analytics
  // posthog-js sends events to paths ending in a slash (/ingest/e/), and
  // Next.js would otherwise answer each with a redirect to the path without
  // one. app/ingest/[...path]/route.ts passes the slash on as it came.
  skipTrailingSlashRedirect: true,
  // cc:end analytics
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "pbs.twimg.com",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },
};

export default nextConfig;
