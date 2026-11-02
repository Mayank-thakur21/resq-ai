import type { NextConfig } from "next";

/**
 * Security headers applied to every route.
 *
 * - `X-Frame-Options: DENY` + the `frame-ancestors` CSP directive below prevent click-jacking.
 * - `Permissions-Policy` only allows the browser features ResQ AI actually needs: geolocation
 *   (maps, SOS, incident reports) and the microphone (voice input in the chat). Camera is off.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=(self)" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

/**
 * The service worker (`public/sw.js`, registered as `/sw.js?v=<build id>`) must never be
 * served from an HTTP cache, otherwise clients can be stuck on an old worker.
 * `Service-Worker-Allowed: /` lets it control the whole origin.
 */
const serviceWorkerHeaders = [
  { key: "Content-Type", value: "application/javascript; charset=utf-8" },
  { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
  { key: "Service-Worker-Allowed", value: "/" },
];

/**
 * One id per build, used to version the service worker URL (`lib/sw-url.ts`) so every deploy
 * reinstalls the worker and re-warms the offline pages. Computed once in the main build
 * process and stored in `process.env`, so Next's build workers (which inherit the
 * environment) inline the same value. Override with `RESQ_BUILD_ID` (e.g. the git SHA).
 */
process.env.RESQ_BUILD_ID ||= (process.env.GITHUB_SHA?.slice(0, 12) ?? "") || Date.now().toString(36);

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (`node server.js`).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_RESQ_BUILD_ID: process.env.RESQ_BUILD_ID,
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/sw.js", headers: serviceWorkerHeaders },
    ];
  },
};

export default nextConfig;
