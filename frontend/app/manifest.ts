import type { MetadataRoute } from "next";

/**
 * Web App Manifest, served by Next.js at `/manifest.webmanifest` (referenced from the root
 * layout's `metadata.manifest`).
 *
 * Icons live in `public/icons/` and are generated from `public/icons/icon.svg`:
 * - `icon-192.png` / `icon-512.png`  — purpose "any" (rounded tile, transparent corners)
 * - `maskable-512.png`               — purpose "maskable" (full bleed, artwork in the safe zone)
 * - `shortcut-*.png` (96×96)         — app shortcut icons (long-press menu / jump list)
 *
 * The service worker (`public/sw.js`) precaches this manifest and the icons so the
 * installed app keeps its identity offline.
 */

/** Brand colours (theme matches `viewport.themeColor` in `app/layout.tsx`). */
const THEME_COLOR = "#dc2626";
const BACKGROUND_COLOR = "#0f172a";

const shortcutIcon = (name: string): MetadataRoute.Manifest["icons"] => [
  { src: `/icons/shortcut-${name}.png`, sizes: "96x96", type: "image/png", purpose: "any" },
];

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ResQ AI — Disaster Response Assistant",
    short_name: "ResQ AI",
    description:
      "AI-powered disaster response: one-tap SOS to your trusted contacts, live disaster alerts, real weather hazards, nearby hospitals and shelters, and community incident reports.",
    lang: "en",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    categories: ["utilities", "health", "weather", "navigation", "news"],
    prefer_related_applications: false,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Send SOS",
        short_name: "SOS",
        description: "Send your location to your trusted contacts",
        url: "/sos",
        icons: shortcutIcon("sos"),
      },
      {
        name: "Relief map",
        short_name: "Map",
        description: "Nearby hospitals, shelters, police and fire stations",
        url: "/map",
        icons: shortcutIcon("map"),
      },
      {
        name: "Emergency AI chat",
        short_name: "Chat",
        description: "Ask the multi-agent emergency assistant",
        url: "/chat",
        icons: shortcutIcon("chat"),
      },
      {
        name: "Disaster alerts",
        short_name: "Alerts",
        description: "Live GDACS disaster events and humanitarian news",
        url: "/alerts",
        icons: shortcutIcon("alerts"),
      },
    ],
  };
}
