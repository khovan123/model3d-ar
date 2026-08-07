import type { NextConfig } from "next";

function getAppHost() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return undefined;

  try {
    return new URL(appUrl).hostname;
  } catch {
    return undefined;
  }
}

const appHost = getAppHost();

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "192.168.1.14",
    "*.ngrok-free.dev",
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.fogewise.io.vn",
    ...(appHost ? [appHost] : [])
  ],
  output: "standalone",
  poweredByHeader: false
};

export default nextConfig;
