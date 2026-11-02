/**
 * `GET /offline-assets.json` — lazily loaded chunks the offline-critical pages need.
 *
 * The service worker warms each page in its `WARM_PAGES` list by fetching the HTML and every
 * `/_next/static` asset the HTML references. Code loaded with `next/dynamic` (the Leaflet map
 * on `/map`) is *not* referenced by the HTML, so a never-visited map would open offline
 * without its map. This prerendered file lists those chunks per page, taken from Next.js'
 * `react-loadable-manifest.json` at build time; `public/sw.js` fetches it during install.
 *
 * Shape: `{"pages": {"/map": ["/_next/static/chunks/….js", "/_next/static/css/….css"]}}`.
 * Best effort: an unreadable manifest yields empty lists (the pages still work online).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-static";

/** Warmed page -> source-module prefixes whose lazy imports it needs. */
const LAZY_MODULES_BY_PAGE: Record<string, readonly string[]> = {
  "/map": ["app/map/"],
};

interface LoadableEntry {
  files?: unknown;
}

async function readLoadableManifest(): Promise<Record<string, LoadableEntry>> {
  try {
    const file = path.join(process.cwd(), ".next", "react-loadable-manifest.json");
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, LoadableEntry>) : {};
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "offline_assets.manifest_unavailable",
        time: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {};
  }
}

/** `static/chunks/x.js` -> `/_next/static/chunks/x.js`; anything unexpected is dropped. */
function toPublicPath(file: unknown): string | null {
  if (typeof file !== "string" || !/^static\/[A-Za-z0-9/_.-]+\.(?:js|css)$/.test(file)) return null;
  return `/_next/${file}`;
}

export async function GET(): Promise<Response> {
  const manifest = await readLoadableManifest();
  const pages: Record<string, string[]> = {};
  for (const [page, prefixes] of Object.entries(LAZY_MODULES_BY_PAGE)) {
    const files = new Set<string>();
    for (const [key, entry] of Object.entries(manifest)) {
      if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
      for (const file of Array.isArray(entry.files) ? entry.files : []) {
        const publicPath = toPublicPath(file);
        if (publicPath) files.add(publicPath);
      }
    }
    pages[page] = [...files].sort();
  }
  return Response.json({ pages }, { headers: { "Cache-Control": "no-cache" } });
}
