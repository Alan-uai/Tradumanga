import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-to-img", "pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/inngest": [
      "./node_modules/pdfjs-dist/**",
      "./node_modules/@napi-rs/canvas*/**",
    ],
  },
};

export default nextConfig;
