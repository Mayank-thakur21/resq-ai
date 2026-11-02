/* ResQ AI service worker — hand-written, no build step (served as-is from /sw.js).
 *
 * Registered by components/PwaRegister.tsx as `/sw.js?v=<build id>` (scope "/"). The build id
 * in the URL is this worker's version: every deploy registers a new URL, so browsers install
 * a fresh worker (the file's bytes never change) that re-warms the offline pages of that
 * build. next.config.ts serves this file with `Cache-Control: no-cache, no-store,
 * must-revalidate` and `Service-Worker-Allowed: /`.
 *
 * Caching strategies
 * ------------------
 * - Install: precache the offline page, the web app manifest and the icons (required), then
 *   best-effort "warm" the offline-critical pages (WARM_PAGES: /offline, /sos, /contacts,
 *   /map, /incidents) plus the /_next/static assets their HTML references, so those pages
 *   open fully styled and interactive without a connection even if never visited. Warmed
 *   pages and assets live in a dedicated per-build "critical" cache that is never trimmed
 *   (the shared static cache is LRU-trimmed and would evict them first).
 * - Navigations: network-first with a 3 s timeout → cached copy of the page → redirect to
 *   /offline?from=<path> (precached). Successful HTML responses are cached (max 30), except
 *   `no-store` (dynamic/private) pages. A 5xx answer (server trouble, e.g. the frontend
 *   container restarting behind nginx) also falls back to the saved page; for 502/503/504
 *   without one, to the offline page.
 * - /_next/static/* and /icons/*: cache-first (content-hashed / immutable), max 250 entries.
 * - GET /api/backend/(weather|alerts|incidents|places): network-first (6 s timeout) with a
 *   cache fallback (max 50), also used when the server answers 5xx (backend down → the
 *   proxy's 502, both weather providers failing → 502 ...). Responses served from the cache
 *   carry `X-ResQ-Offline: 1` and `X-ResQ-Cached-At: <iso>` (plus
 *   `X-ResQ-Offline-Reason: server-error` for the 5xx case) so the UI can label stale data.
 *   Location-based URLs rarely match exactly offline (a new GPS fix differs in the 4th
 *   decimal), so on an exact miss the saved copy with the same path and non-location
 *   parameters whose lat/lon is NEAREST to the request is used, within a tolerance
 *   (a quarter of the query radius, 1-10 km; 5 km for weather; else 2 km); it carries
 *   `X-ResQ-Cached-Distance-M`.
 * - OpenStreetMap tiles (*.tile.openstreetmap.org): stale-while-revalidate, max 200 tiles.
 * - Never handled: non-GET requests (POST etc.), /api/auth/*, other /api/* routes, Range
 *   requests and /sw.js itself — they always go straight to the network.
 *
 * Messages: {type: "SKIP_WAITING"} activates a waiting update (sent by the "Reload" toast);
 * {type: "CLEAR_API_CACHE"} drops cached API data (e.g. on sign-out).
 *
 * Push: shows the backend's payload {title, body, url, tag, severity}; clicking focuses an
 * open ResQ AI window (navigating it to the url) or opens a new one.
 *
 * Versions: build-specific caches (precache, critical, pages, static) are named after the
 * build id, so a new deploy starts clean and the old ones are deleted on activate. Data
 * caches (api, tiles) use DATA_CACHE_VERSION and survive deploys; bump it when their format
 * changes.
 */

"use strict";

/** Build id from the registration URL (`/sw.js?v=<id>`); "dev" when missing or malformed. */
function readVersion() {
  try {
    const value = new URL(self.location.href).searchParams.get("v") || "";
    return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : "dev";
  } catch {
    return "dev";
  }
}

const SW_VERSION = readVersion();
const DATA_CACHE_VERSION = "2";
const CACHE_PREFIX = "resq-";
const CACHE_NAMES = {
  precache: `${CACHE_PREFIX}precache-${SW_VERSION}`,
  /** Warmed offline-critical pages + their assets: never trimmed. */
  critical: `${CACHE_PREFIX}critical-${SW_VERSION}`,
  pages: `${CACHE_PREFIX}pages-${SW_VERSION}`,
  static: `${CACHE_PREFIX}static-${SW_VERSION}`,
  api: `${CACHE_PREFIX}api-v${DATA_CACHE_VERSION}`,
  tiles: `${CACHE_PREFIX}tiles-v${DATA_CACHE_VERSION}`,
};
const CACHE_LIMITS = { pages: 30, static: 250, api: 50, tiles: 200 };

const OFFLINE_URL = "/offline";
/** Required for install to succeed. */
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/badge-72.png",
];
/** Pages warmed at install (best effort) so they work offline even if never visited. */
const WARM_PAGES = [OFFLINE_URL, "/sos", "/contacts", "/map", "/incidents"];
/** Upper bound of static assets fetched per warmed page. */
const MAX_WARM_ASSETS_PER_PAGE = 80;
/**
 * Lazily loaded chunks per warmed page (e.g. the Leaflet map of /map), which the HTML does
 * not reference. Prerendered by app/offline-assets.json/route.ts from Next's build manifest.
 */
const OFFLINE_ASSETS_URL = "/offline-assets.json";

const NAVIGATION_TIMEOUT_MS = 3000;
const API_TIMEOUT_MS = 6000;
const API_CACHE_PATTERN = /^\/api\/backend\/(weather|alerts|incidents|places)(\/|$)/;
const TILE_HOST_PATTERN = /(^|\.)tile\.openstreetmap\.org$/;
const INCIDENT_DETAIL_PATTERN = /^\/incidents\/([A-Za-z0-9._~%-]{1,96})\/?$/;
const STATIC_ASSET_PATTERN = /\/_next\/static\/[A-Za-z0-9\-_.~/%=?]+/g;

/** Query parameters that carry the location: matched by distance, not by value. */
const COORD_PARAMS = new Set(["lat", "lon"]);
/** Nearest-saved-copy tolerances (km), see `nearestToleranceKm`. */
const NEAREST_MIN_KM = 1;
const NEAREST_MAX_KM = 10;
const NEAREST_WEATHER_KM = 5;
const NEAREST_DEFAULT_KM = 2;

const PUSH_ICON = "/icons/icon-192.png";
const PUSH_BADGE = "/icons/badge-72.png";
const PUSH_SEVERITIES = ["low", "medium", "high"];

const TIMEOUT = Symbol("timeout");

/** Shown when even the precached /offline page is missing. */
const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline · ResQ AI</title>
<style>body{margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.5}
h1{color:#fff;font-size:1.5rem}a{color:#fca5a5;font-weight:600}li{margin:.5rem 0}</style></head>
<body><h1>You're offline</h1>
<p>ResQ AI can't load this page without a connection. In an emergency, call:</p>
<ul><li><a href="tel:112">112</a> — International emergency number</li>
<li><a href="tel:108">108</a> — Ambulance (India)</li><li><a href="tel:100">100</a> — Police (India)</li>
<li><a href="tel:101">101</a> — Fire (India)</li><li><a href="tel:911">911</a> — US &amp; Canada</li>
<li><a href="tel:999">999</a> — UK</li></ul>
<p>Text messages (SMS) often still work when mobile data doesn't.</p>
<p><a href="/">Try again</a></p></body></html>`;

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function log(level, message, extra) {
  try {
    console[level](`[sw] ${message}`, extra === undefined ? "" : extra);
  } catch {
    // console unavailable — ignore
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms));
}

/**
 * Keeps the worker alive for `promise` without ever rejecting the event. Rejections are
 * expected here (e.g. the network is down while offline), so they are only debug-logged;
 * cache write failures are already reported by `putInCache`.
 */
function extendLifetime(event, promise) {
  const safe = Promise.resolve(promise).catch((error) => log("debug", "background task skipped", error && error.message));
  try {
    event.waitUntil(safe);
  } catch {
    // The event is no longer active; the task still runs best-effort.
  }
  return safe;
}

function isUsableResponse(response) {
  return (
    !!response &&
    response.status === 200 &&
    !response.redirected &&
    (response.type === "basic" || response.type === "cors" || response.type === "default")
  );
}

function hasNoStore(response) {
  return /\bno-store\b/i.test(response.headers.get("cache-control") || "");
}

function isHtml(response) {
  return /text\/html/i.test(response.headers.get("content-type") || "");
}

/** Deletes the oldest entries (insertion order) beyond `maxEntries`. */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let index = 0; index < keys.length - maxEntries; index += 1) {
    await cache.delete(keys[index]);
  }
}

/** `cache.put` + trim; storage errors (quota, private mode) are logged, never thrown. */
async function putInCache(cacheName, request, response, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    // Re-inserting moves the entry to the end, so trimming evicts least recently stored.
    await cache.delete(request);
    await cache.put(request, response);
    if (maxEntries) await trimCache(cacheName, maxEntries);
  } catch (error) {
    log("warn", `could not write to ${cacheName}`, error);
  }
}

/** Copy of `response` with extra headers (body buffered — only used for small JSON). */
async function withHeaders(response, extra) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function offlineFallbackResponse() {
  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** JSON error envelope (same shape as the backend) for uncached API requests while offline. */
function offlineApiResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: "network_error",
        message: "You're offline and this data isn't saved on your device yet.",
        request_id: "",
      },
    }),
    {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-ResQ-Offline": "1" },
    },
  );
}

/** Same-origin path for a notification click; anything else falls back to "/". */
function safeAppPath(value) {
  if (typeof value !== "string" || !value.trim()) return "/";
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// ---------------------------------------------------------------------------------------
// Install / activate / messages
// ---------------------------------------------------------------------------------------

/** Extracts /_next/static asset URLs referenced by an HTML document. */
function staticAssetsIn(html) {
  const found = new Set();
  for (const match of html.matchAll(STATIC_ASSET_PATTERN)) {
    const url = match[0].replace(/[?&]$/, "");
    if (!url.endsWith(".map")) found.add(url);
    if (found.size >= MAX_WARM_ASSETS_PER_PAGE) break;
  }
  return [...found];
}

/** `{"/map": ["/_next/static/…"]}` from OFFLINE_ASSETS_URL; `{}` on any problem. */
async function fetchOfflineAssets() {
  try {
    const response = await fetch(new Request(OFFLINE_ASSETS_URL, { cache: "reload", credentials: "same-origin" }));
    if (!response.ok) return {};
    const body = await response.json();
    const pages = body && typeof body === "object" && body.pages && typeof body.pages === "object" ? body.pages : {};
    const result = {};
    for (const [page, files] of Object.entries(pages)) {
      if (!Array.isArray(files)) continue;
      result[page] = files
        .filter((file) => typeof file === "string" && file.startsWith("/_next/static/"))
        .slice(0, MAX_WARM_ASSETS_PER_PAGE);
    }
    return result;
  } catch (error) {
    log("debug", "offline asset list unavailable", error && error.message);
    return {};
  }
}

/**
 * Best effort: cache a page's HTML and the static assets it needs to render offline (those
 * its HTML references plus `extraAssets`, e.g. lazily loaded chunks), in the untrimmed
 * per-build critical cache (so browsing other pages can never evict them).
 */
async function warmPage(path, extraAssets = []) {
  try {
    const precache = await caches.open(CACHE_NAMES.precache);
    const critical = await caches.open(CACHE_NAMES.critical);
    let response = path === OFFLINE_URL ? await precache.match(path) : undefined;
    if (!response) {
      response = await fetch(new Request(path, { cache: "reload", credentials: "same-origin" }));
      if (!isUsableResponse(response) || !isHtml(response) || hasNoStore(response)) return;
      await critical.put(path, response.clone());
    }
    const html = await response.text();
    const assets = [...new Set([...staticAssetsIn(html), ...extraAssets])];
    await Promise.all(
      assets.map(async (asset) => {
        try {
          if (await critical.match(asset)) return;
          const assetResponse = await fetch(asset, { credentials: "same-origin" });
          if (isUsableResponse(assetResponse)) await critical.put(asset, assetResponse);
        } catch {
          // A missing asset only degrades the offline page; never fail install for it.
        }
      }),
    );
  } catch (error) {
    log("warn", `could not warm ${path}`, error);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAMES.precache);
      // `cache: "reload"` bypasses the HTTP cache so a new version never precaches stale files.
      await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" })));
      const offlineAssets = await fetchOfflineAssets();
      for (const path of WARM_PAGES) await warmPage(path, offlineAssets[path] || []);
      log("info", `installed ${SW_VERSION}`);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const current = new Set(Object.values(CACHE_NAMES));
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && !current.has(name))
          .map((name) => caches.delete(name)),
      );
      if (self.registration && self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          // Not supported everywhere; navigations simply use fetch().
        }
      }
      await self.clients.claim();
      log("info", `activated ${SW_VERSION}`);
    })(),
  );
});

self.addEventListener("message", (event) => {
  const type = event.data && typeof event.data === "object" ? event.data.type : undefined;
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (type === "CLEAR_API_CACHE") {
    extendLifetime(event, caches.delete(CACHE_NAMES.api));
  }
});

// ---------------------------------------------------------------------------------------
// Fetch strategies
// ---------------------------------------------------------------------------------------

/** Saved copy of a page: last visited version first, then the copy warmed at install. */
async function cachedPage(request) {
  for (const name of [CACHE_NAMES.pages, CACHE_NAMES.critical]) {
    const cache = await caches.open(name);
    const hit =
      (await cache.match(request, { ignoreVary: true })) ||
      // `/incidents?focus=<id>` etc.: the static page reads its query on the client.
      (await cache.match(request, { ignoreVary: true, ignoreSearch: true }));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Offline answer for a navigation without a cached copy.
 *
 * Other pages are *redirected* to `/offline?from=<path>` rather than served the offline
 * HTML under their own URL: the HTML then matches the URL (no React hydration mismatch, e.g.
 * the navbar's active tab) and the offline page's "Try again" can return to `from`.
 */
async function offlineNavigationResponse(request) {
  const url = new URL(request.url);
  // An unvisited incident report: open the warmed incidents list focused on it, which can
  // show it from the saved incidents data.
  const detail = INCIDENT_DETAIL_PATTERN.exec(url.pathname);
  if (detail && detail[1] !== "new") {
    const critical = await caches.open(CACHE_NAMES.critical);
    if (await critical.match("/incidents", { ignoreVary: true })) {
      const target = new URL("/incidents", self.location.origin);
      target.searchParams.set("focus", decodeURIComponent(detail[1]).slice(0, 64));
      return Response.redirect(target.href, 302);
    }
  }
  const precache = await caches.open(CACHE_NAMES.precache);
  const offline = await precache.match(OFFLINE_URL, { ignoreVary: true });
  if (!offline) return offlineFallbackResponse();
  if (url.pathname === OFFLINE_URL) return offline;
  const target = new URL(OFFLINE_URL, self.location.origin);
  target.searchParams.set("from", `${url.pathname}${url.search}`);
  return Response.redirect(target.href, 302);
}

/** Gateway-style failures where the offline page beats the server's bare error page. */
const GATEWAY_ERRORS = new Set([502, 503, 504]);

/**
 * The server answered a navigation with 5xx (e.g. nginx's 502 while the frontend restarts):
 * the saved copy of the page, else for 502/503/504 the offline page (emergency numbers,
 * saved contacts), else the server's own response.
 */
async function serverErrorNavigation(request, response) {
  log("info", `navigation ${response.status}: trying a saved copy`, new URL(request.url).pathname);
  const cached = await cachedPage(request);
  if (cached) return cached;
  return GATEWAY_ERRORS.has(response.status) ? offlineNavigationResponse(request) : response;
}

/** Navigations: network-first (3 s) → cached page → /offline. */
async function handleNavigation(event) {
  const { request } = event;
  const network = (async () => {
    const preloaded = event.preloadResponse ? await event.preloadResponse.catch(() => undefined) : undefined;
    return preloaded || fetch(request);
  })();

  // Cache successful pages in the background (clone before the page consumes the body).
  extendLifetime(
    event,
    network.then((response) => {
      if (!isUsableResponse(response) || !isHtml(response) || hasNoStore(response)) return undefined;
      return putInCache(CACHE_NAMES.pages, request, response.clone(), CACHE_LIMITS.pages);
    }),
  );

  try {
    const winner = await Promise.race([network, sleep(NAVIGATION_TIMEOUT_MS)]);
    if (winner !== TIMEOUT) return isServerError(winner) ? serverErrorNavigation(request, winner) : winner;
    // Slow network: use the saved copy if we have one, otherwise keep waiting.
    const cached = await cachedPage(request);
    if (cached) return cached;
    const late = await network;
    return isServerError(late) ? serverErrorNavigation(request, late) : late;
  } catch (error) {
    log("info", `navigation offline: ${new URL(request.url).pathname}`, error && error.message);
    return (await cachedPage(request)) || offlineNavigationResponse(request);
  }
}

/** /_next/static and /icons: cache-first (any cache, incl. precache), then network. */
async function handleStatic(event) {
  const { request } = event;
  const cached = await caches.match(request, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (isUsableResponse(response)) {
    extendLifetime(event, putInCache(CACHE_NAMES.static, request, response.clone(), CACHE_LIMITS.static));
  }
  return response;
}

/** `{lat, lon}` of a URL's query, or `null` when absent / not valid coordinates. */
function coordsOf(url) {
  const rawLat = url.searchParams.get("lat");
  const rawLon = url.searchParams.get("lon");
  if (rawLat === null || rawLon === null || rawLat.trim() === "" || rawLon.trim() === "") return null;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Canonical form of every query parameter except the coordinates (order-independent). */
function nonCoordinateParams(url) {
  return [...url.searchParams.entries()]
    .filter(([name]) => !COORD_PARAMS.has(name))
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Great-circle distance in km. */
function distanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far away a saved copy may have been fetched and still answer `url`: a quarter of the
 * query radius (`radius` in m or `radius_km`), clamped to 1-10 km; 5 km for weather (the
 * backend itself caches weather per ~1 km cell); 2 km otherwise.
 */
function nearestToleranceKm(url) {
  const radiusKm = Number(url.searchParams.get("radius_km"));
  const radiusM = Number(url.searchParams.get("radius"));
  const radius = radiusKm > 0 ? radiusKm : radiusM > 0 ? radiusM / 1000 : null;
  if (radius !== null && Number.isFinite(radius)) {
    return Math.min(NEAREST_MAX_KM, Math.max(NEAREST_MIN_KM, radius / 4));
  }
  if (url.pathname === "/api/backend/weather") return NEAREST_WEATHER_KM;
  return NEAREST_DEFAULT_KM;
}

/**
 * Saved response for the same endpoint and filters whose location is nearest to the
 * request's (within `nearestToleranceKm`): `{response, km}` or `undefined`.
 */
async function nearestCachedApi(cache, request) {
  const url = new URL(request.url);
  const wanted = coordsOf(url);
  if (!wanted) return undefined;
  const params = nonCoordinateParams(url);
  const tolerance = nearestToleranceKm(url);
  let best;
  for (const key of await cache.keys()) {
    let candidate;
    try {
      candidate = new URL(key.url);
    } catch {
      continue;
    }
    if (candidate.origin !== url.origin || candidate.pathname !== url.pathname) continue;
    if (nonCoordinateParams(candidate) !== params) continue;
    const at = coordsOf(candidate);
    if (!at) continue;
    const km = distanceKm(wanted, at);
    if (km <= tolerance && (!best || km < best.km)) best = { key, km };
  }
  if (!best) return undefined;
  const response = await cache.match(best.key, { ignoreVary: true });
  return response ? { response, km: best.km } : undefined;
}

/**
 * Saved copy of an API response (exact URL, else the nearest location — see
 * `nearestCachedApi`), marked `X-ResQ-Offline: 1`. `reason` "server-error" adds
 * `X-ResQ-Offline-Reason` so the UI does not claim the device is offline.
 */
async function cachedApi(request, reason = "offline") {
  const cache = await caches.open(CACHE_NAMES.api);
  const marker = reason === "server-error" ? { "X-ResQ-Offline": "1", "X-ResQ-Offline-Reason": reason } : { "X-ResQ-Offline": "1" };
  const exact = await cache.match(request, { ignoreVary: true });
  if (exact) return withHeaders(exact, marker);
  const nearest = await nearestCachedApi(cache, request);
  if (!nearest) return undefined;
  return withHeaders(nearest.response, {
    ...marker,
    "X-ResQ-Cached-Distance-M": String(Math.round(nearest.km * 1000)),
  });
}

/** The server (not the network) failed: 5xx, incl. the Next proxy's 502 backend_unreachable. */
function isServerError(response) {
  return !!response && response.status >= 500;
}

/**
 * Public data API: network-first (6 s) → cached copy (marked X-ResQ-Offline) → 503 envelope.
 * A 5xx answer is replaced by a saved copy when there is one.
 */
async function handleApi(event) {
  const { request } = event;
  const network = fetch(request);

  extendLifetime(
    event,
    network.then(async (response) => {
      if (!isUsableResponse(response)) return;
      const copy = response.clone();
      const stamped = await withHeaders(copy, { "X-ResQ-Cached-At": new Date().toISOString() });
      await putInCache(CACHE_NAMES.api, request, stamped, CACHE_LIMITS.api);
    }),
  );

  try {
    const winner = await Promise.race([network, sleep(API_TIMEOUT_MS)]);
    if (winner !== TIMEOUT) {
      if (!isServerError(winner)) return winner;
      log("info", `API ${winner.status}: trying a saved copy`, new URL(request.url).pathname);
      return (await cachedApi(request, "server-error")) || winner;
    }
    const cached = await cachedApi(request);
    if (cached) return cached;
    const late = await network;
    return isServerError(late) ? (await cachedApi(request, "server-error")) || late : late;
  } catch {
    return (await cachedApi(request)) || offlineApiResponse();
  }
}

/** Fetches a tile in CORS mode (cacheable, not an opaque response) with a no-cors fallback. */
async function fetchTile(request) {
  try {
    return await fetch(new Request(request.url, { mode: "cors", credentials: "omit", referrer: request.referrer }));
  } catch {
    return fetch(request);
  }
}

/** OSM tiles: stale-while-revalidate, max 200 tiles. */
async function handleTile(event) {
  const { request } = event;
  const cache = await caches.open(CACHE_NAMES.tiles);
  const cached = await cache.match(request.url);
  const network = fetchTile(request);
  extendLifetime(
    event,
    network.then((response) => {
      // Opaque (no-cors) responses are never stored: browsers pad them to megabytes of quota.
      if (!isUsableResponse(response) || response.type === "opaque") return undefined;
      return putInCache(CACHE_NAMES.tiles, request.url, response.clone(), CACHE_LIMITS.tiles);
    }),
  );
  if (cached) return cached;
  try {
    return await network;
  } catch {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Never intercept writes (POST/PATCH/DELETE…) or partial content.
  if (request.method !== "GET" || request.headers.has("range")) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  if (url.origin === self.location.origin) {
    const path = url.pathname;
    if (path === "/sw.js" || path.startsWith("/api/auth")) return;
    if (request.mode === "navigate") {
      if (path.startsWith("/api/")) return;
      event.respondWith(handleNavigation(event));
      return;
    }
    if (path.startsWith("/_next/static/") || path.startsWith("/icons/")) {
      event.respondWith(handleStatic(event));
      return;
    }
    if (API_CACHE_PATTERN.test(path)) {
      event.respondWith(handleApi(event));
    }
    return;
  }

  if (TILE_HOST_PATTERN.test(url.hostname)) {
    event.respondWith(handleTile(event));
  }
});

// ---------------------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------------------

/** Validates the push payload ({title, body, url, tag, severity}); tolerant of bad input. */
function parsePushPayload(data) {
  const fallback = { title: "ResQ AI alert", body: "", url: "/alerts", tag: "", severity: "medium" };
  if (!data) return fallback;
  let raw;
  try {
    raw = data.json();
  } catch {
    try {
      return { ...fallback, body: clip(data.text(), 400) };
    } catch {
      return fallback;
    }
  }
  if (!raw || typeof raw !== "object") return fallback;
  return {
    title: clip(raw.title, 120) || fallback.title,
    body: clip(raw.body, 400),
    url: raw.url === undefined ? fallback.url : safeAppPath(raw.url),
    tag: clip(raw.tag, 100),
    severity: PUSH_SEVERITIES.includes(raw.severity) ? raw.severity : "medium",
  };
}

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data);
  const high = payload.severity === "high";
  const options = {
    body: payload.body,
    icon: PUSH_ICON,
    badge: PUSH_BADGE,
    data: { url: payload.url },
    vibrate: high ? [300, 100, 300, 100, 300] : [200, 100, 200],
    requireInteraction: high,
    timestamp: Date.now(),
    lang: "en",
  };
  if (payload.tag) {
    options.tag = payload.tag;
    // Re-alert when an existing notification with the same tag is replaced.
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

/** Focuses an open ResQ AI window (navigating it to `path`) or opens a new one. */
async function openOrFocus(path) {
  const target = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  const exact = windows.find((client) => client.url === target);
  if (exact && "focus" in exact) return exact.focus();

  const sameOrigin = windows.find((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  if (sameOrigin && "navigate" in sameOrigin) {
    try {
      const navigated = await sameOrigin.navigate(target);
      if (navigated) return navigated.focus();
    } catch {
      // Uncontrolled clients can't be navigated; open a new window instead.
    }
  }
  return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openOrFocus(safeAppPath(data.url)));
});

/**
 * The push service rotated our subscription: re-subscribe and tell the backend (default
 * topics, no location — the app re-syncs the user's preferences next time it is opened).
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription;
      let subscription = event.newSubscription;
      if (!subscription && previous && previous.options) {
        subscription = await self.registration.pushManager.subscribe(previous.options);
      }
      if (!subscription) return;
      const json = subscription.toJSON();
      await fetch("/api/backend/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: { endpoint: json.endpoint, keys: json.keys } }),
      });
      if (previous && previous.endpoint && previous.endpoint !== json.endpoint) {
        await fetch("/api/backend/push/unsubscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: previous.endpoint }),
        });
      }
    })().catch((error) => log("warn", "could not renew the push subscription", error)),
  );
});
