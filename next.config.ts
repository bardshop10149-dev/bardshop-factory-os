import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
    resolveAlias: {
      tailwindcss: path.resolve(__dirname, "node_modules/tailwindcss"),
    },
  },
  async redirects() {
    return [
      {
        source: "/admin/production/anomaly",
        destination: "/qa",
        permanent: true,
      },
      {
        source: "/admin/production/anomaly/report",
        destination: "/qa/report",
        permanent: true,
      },
      {
        source: "/admin/production/anomaly/records",
        destination: "/qa/records",
        permanent: true,
      },
      {
        source: "/admin/production/anomaly/options",
        destination: "/qa/options",
        permanent: true,
      },
    ]
  },
};

export default nextConfig;
