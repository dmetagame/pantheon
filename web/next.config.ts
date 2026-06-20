import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pantheon/agents", "@pantheon/sdk"],
  typedRoutes: true,
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
