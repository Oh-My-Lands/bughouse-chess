import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Self-contained server bundle for deployment: `next build` emits
  // `.next/standalone/` with its own minimal node_modules, so the box only
  // needs the Node runtime (no `npm install`, no build toolchain on-server).
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "chessboardjs.com",
        pathname: "/img/chesspieces/wikipedia/*",
      },
    ],
  },
};

export default nextConfig;
