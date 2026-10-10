import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  // Native binaries with `.node` addons or worker threads must NOT be
  // bundled by Turbopack — only pure-JS modules can be ESM-imported
  // after tree-shaking. `sharp` is already in Next's pre-baked list;
  // `@napi-rs/canvas` is the renderer that `unpdf` (used by
  // `lib/pdf-extract.ts`) needs at runtime, and `tesseract.js` spawns a
  // worker that depends on its native bits surviving module
  // resolution.
  serverExternalPackages: ["@napi-rs/canvas", "tesseract.js"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
