// @vitest-environment node
/**
 * Behavioural tests for the hand-written service worker (`public/sw.js`).
 *
 * The real script runs inside a `node:vm` sandbox that provides a minimal ServiceWorker
 * global scope: an in-memory CacheStorage, a programmable `fetch`, `clients` and
 * `registration` fakes. Events are dispatched to the listeners the script registers, so the
 * caching strategies, offline fallbacks and push handling are tested exactly as shipped.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://resq.test";
const SW_SOURCE = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");

type Handler = (event: Record<string, unknown>) => void;
type Route = () => Response | Promise<Response>;

function absolute(input: unknown): string {
  if (typeof input === "string") return new URL(input, ORIGIN).href;
  if (input instanceof URL) return input.href;
  return new URL((input as Request).url, ORIGIN).href;
}

class FakeCache {
  readonly store = new Map<string, Response>();
  constructor(private readonly doFetch: (input: unknown) => Promise<Response>) {}

  async match(input: unknown, options: { ignoreSearch?: boolean } = {}) {
    const key = absolute(input);
    let hit = this.store.get(key);
    if (!hit && options.ignoreSearch) {
      const base = key.split("?")[0];
      for (const [stored, response] of this.store) {
        if (stored.split("?")[0] === base) {
          hit = response;
          break;
        }
      }
    }
    return hit?.clone();
  }
  async put(input: unknown, response: Response) {
    this.store.delete(absolute(input));
    this.store.set(absolute(input), response.clone());
  }
  async delete(input: unknown) {
    return this.store.delete(absolute(input));
  }
  async keys() {
    return [...this.store.keys()].map((url) => new Request(url));
  }
  async addAll(inputs: unknown[]) {
    for (const input of inputs) {
      const response = await this.doFetch(input);
      if (!response.ok) throw new TypeError(`addAll: ${absolute(input)} -> ${response.status}`);
      await this.put(input, response);
    }
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  constructor(private readonly doFetch: (input: unknown) => Promise<Response>) {}

  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache(this.doFetch);
      this.caches.set(name, cache);
    }
    return cache;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
  async match(input: unknown, options?: { ignoreSearch?: boolean }) {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(input, options);
      if (hit) return hit;
    }
    return undefined;
  }
  /** Test helper: URLs stored in the cache whose name starts with `prefix`. */
  urls(prefix: string): string[] {
    const name = [...this.caches.keys()].find((key) => key.startsWith(prefix));
    return name ? [...(this.caches.get(name)?.store.keys() ?? [])] : [];
  }
  cache(prefix: string): FakeCache | undefined {
    const name = [...this.caches.keys()].find((key) => key.startsWith(prefix));
    return name ? this.caches.get(name) : undefined;
  }
}

function html(body: string, headers: Record<string, string> = {}) {
  return new Response(`<!doctype html><html><body>${body}</body></html>`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Build id the default test worker is registered with (`/sw.js?v=<id>`). */
const BUILD = "build-1";

/** Creates a fresh worker sandbox with programmable network routes. */
function createWorker(scriptUrl = `${ORIGIN}/sw.js?v=${BUILD}`, sharedCaches?: FakeCacheStorage) {
  const listeners: Record<string, Handler[]> = {};
  const routes = new Map<string, Route>();
  const fetchLog: string[] = [];

  const fetchImpl = vi.fn(async (input: unknown, _init?: unknown) => {
    const url = absolute(input);
    fetchLog.push(url);
    const route = routes.get(url);
    if (!route) throw new TypeError(`network down: ${url}`);
    return route();
  });

  const caches = sharedCaches ?? new FakeCacheStorage((input) => fetchImpl(input));
  const registration = {
    navigationPreload: { enable: vi.fn().mockResolvedValue(undefined) },
    showNotification: vi.fn().mockResolvedValue(undefined),
    pushManager: { subscribe: vi.fn() },
  };
  const clients = {
    claim: vi.fn().mockResolvedValue(undefined),
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn().mockResolvedValue(null),
  };

  class SandboxRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init);
    }
  }

  const context: Record<string, unknown> = {
    addEventListener: (type: string, handler: Handler) => {
      (listeners[type] ??= []).push(handler);
    },
    location: new URL(scriptUrl),
    registration,
    clients,
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    caches,
    fetch: fetchImpl,
    Request: SandboxRequest,
    Response,
    Headers,
    URL,
    console: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, log: () => {} },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context, { filename: "sw.js" });

  /** Dispatches an extendable event and waits for every waitUntil promise (incl. late ones). */
  async function dispatch(type: string, init: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    const event = {
      ...init,
      waitUntil: (promise: Promise<unknown>) => pending.push(Promise.resolve(promise)),
      respondWith: (promise: Promise<Response> | Response) => {
        responded = Promise.resolve(promise);
      },
    };
    for (const handler of listeners[type] ?? []) handler(event);
    const response = responded ? await responded : undefined;
    const results: PromiseSettledResult<unknown>[] = [];
    while (results.length < pending.length) {
      results.push(...(await Promise.allSettled(pending.slice(results.length))));
    }
    const failures = results.filter((result) => result.status === "rejected");
    return { response, responded: !!responded, failures };
  }

  function request(path: string, init: RequestInit & { navigate?: boolean } = {}) {
    const { navigate, ...rest } = init;
    const req = new Request(new URL(path, ORIGIN).href, rest);
    if (navigate) Object.defineProperty(req, "mode", { value: "navigate" });
    return req;
  }

  const fetchEvent = (req: Request) => dispatch("fetch", { request: req, preloadResponse: undefined });

  return { routes, fetchImpl, fetchLog, caches, registration, clients, context, dispatch, request, fetchEvent };
}

type Worker = ReturnType<typeof createWorker>;

const PRECACHE = [
  "/offline",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/badge-72.png",
];

function servePrecache(worker: Worker, offlineBody = '<h1>You are offline</h1><script src="/_next/static/chunks/offline-1.js"></script>') {
  for (const path of PRECACHE) {
    worker.routes.set(`${ORIGIN}${path}`, () =>
      path === "/offline" ? html(offlineBody) : new Response("x", { status: 200 }),
    );
  }
}

let worker: Worker;

beforeEach(() => {
  worker = createWorker();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("install / activate / messages", () => {
  it("precaches the offline page, manifest and icons, and warms pages with their static assets", async () => {
    servePrecache(worker);
    worker.routes.set(`${ORIGIN}/_next/static/chunks/offline-1.js`, () => new Response("js"));
    worker.routes.set(`${ORIGIN}/contacts`, () =>
      html('<link rel="stylesheet" href="/_next/static/css/app-9.css"><script src="/_next/static/chunks/contacts-2.js" async></script>'),
    );
    worker.routes.set(`${ORIGIN}/_next/static/css/app-9.css`, () => new Response("css"));
    worker.routes.set(`${ORIGIN}/_next/static/chunks/contacts-2.js`, () => new Response("js"));
    // A no-store page must not be stored.
    worker.routes.set(`${ORIGIN}/sos`, () => html("sos", { "Cache-Control": "private, no-store" }));

    const { failures } = await worker.dispatch("install");
    expect(failures).toEqual([]);

    expect(worker.caches.urls(`resq-precache-${BUILD}`).sort()).toEqual(PRECACHE.map((p) => `${ORIGIN}${p}`).sort());
    // Warmed pages and their assets live in the untrimmed per-build critical cache.
    expect(worker.caches.urls(`resq-critical-${BUILD}`).sort()).toEqual(
      [
        `${ORIGIN}/contacts`,
        `${ORIGIN}/_next/static/chunks/offline-1.js`,
        `${ORIGIN}/_next/static/css/app-9.css`,
        `${ORIGIN}/_next/static/chunks/contacts-2.js`,
      ].sort(),
    );
    expect(worker.caches.urls("resq-pages-")).toEqual([]);
    expect(worker.caches.urls("resq-static-")).toEqual([]);
  });

  it("fails installation when a required precache file is missing", async () => {
    servePrecache(worker);
    worker.routes.set(`${ORIGIN}/icons/badge-72.png`, () => new Response("missing", { status: 404 }));
    const { failures } = await worker.dispatch("install");
    expect(failures).toHaveLength(1);
    expect(String((failures[0] as PromiseRejectedResult).reason)).toContain("badge-72.png");
    expect(worker.caches.urls("resq-critical-")).toEqual([]);
  });

  it("removes old ResQ caches on activate, keeps foreign ones and claims clients", async () => {
    await worker.caches.open("resq-api-v1.0.0");
    await worker.caches.open("resq-critical-build-0");
    await worker.caches.open("resq-pages-v2.0.0");
    await worker.caches.open(`resq-pages-${BUILD}`);
    await worker.caches.open("resq-tiles-v2");
    await worker.caches.open("someone-elses-cache");
    await worker.dispatch("activate");
    // Current build caches and the deploy-independent data caches (api/tiles) stay.
    expect(await worker.caches.keys()).toEqual([`resq-pages-${BUILD}`, "resq-tiles-v2", "someone-elses-cache"]);
    expect(worker.clients.claim).toHaveBeenCalled();
    expect(worker.registration.navigationPreload.enable).toHaveBeenCalled();
  });

  it("activates a waiting update on SKIP_WAITING and can drop cached API data", async () => {
    await worker.dispatch("message", { data: { type: "SKIP_WAITING" } });
    expect(worker.context.skipWaiting).toHaveBeenCalled();

    await worker.caches.open("resq-api-v2");
    await worker.dispatch("message", { data: { type: "CLEAR_API_CACHE" } });
    expect(await worker.caches.keys()).not.toContain("resq-api-v2");
  });

  it("takes its version from the registration URL", async () => {
    const versioned = createWorker(`${ORIGIN}/sw.js?v=abc123`);
    servePrecache(versioned);
    await versioned.dispatch("install");
    expect(await versioned.caches.keys()).toEqual(
      expect.arrayContaining(["resq-precache-abc123", "resq-critical-abc123"]),
    );
    // Missing or malformed versions fall back to "dev" (never an arbitrary cache name).
    const unversioned = createWorker(`${ORIGIN}/sw.js?v=../../evil`);
    servePrecache(unversioned);
    await unversioned.dispatch("install");
    expect(await unversioned.caches.keys()).toContain("resq-precache-dev");
  });

  it("warms /map and /incidents so they open offline without a prior visit", async () => {
    servePrecache(worker);
    worker.routes.set(`${ORIGIN}/map`, () => html('<script src="/_next/static/chunks/map-3.js"></script>'));
    worker.routes.set(`${ORIGIN}/_next/static/chunks/map-3.js`, () => new Response("js"));
    // The Leaflet map is loaded with next/dynamic: not in the HTML, listed by the build.
    worker.routes.set(`${ORIGIN}/offline-assets.json`, () =>
      json({ pages: { "/map": ["/_next/static/chunks/leaflet-9.js", "https://evil.example/x.js"] } }),
    );
    worker.routes.set(`${ORIGIN}/_next/static/chunks/leaflet-9.js`, () => new Response("leaflet"));
    worker.routes.set(`${ORIGIN}/incidents`, () => html("incidents shell"));
    await worker.dispatch("install");
    worker.routes.clear();

    const map = await worker.fetchEvent(worker.request("/map?lat=1&lon=2", { navigate: true }));
    expect(map.response?.status).toBe(200);
    const incidents = await worker.fetchEvent(worker.request("/incidents?focus=abc", { navigate: true }));
    expect(await incidents.response?.text()).toContain("incidents shell");
    const chunk = await worker.fetchEvent(worker.request("/_next/static/chunks/map-3.js"));
    expect(await chunk.response?.text()).toBe("js");
    const lazy = await worker.fetchEvent(worker.request("/_next/static/chunks/leaflet-9.js"));
    expect(await lazy.response?.text()).toBe("leaflet");
    expect(worker.fetchLog).not.toContain("https://evil.example/x.js");
  });

  it("sends an unvisited incident report to the warmed incidents list offline", async () => {
    servePrecache(worker);
    worker.routes.set(`${ORIGIN}/incidents`, () => html("incidents shell"));
    await worker.dispatch("install");
    worker.routes.clear();

    const { response } = await worker.fetchEvent(worker.request("/incidents/abc-123", { navigate: true }));
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(`${ORIGIN}/incidents?focus=abc-123`);
    // The report form is not an incident id.
    const form = await worker.fetchEvent(worker.request("/incidents/new", { navigate: true }));
    expect(form.response?.headers.get("location")).toBe(`${ORIGIN}/offline?from=%2Fincidents%2Fnew`);
  });

  it("never evicts warmed offline assets when the static cache is trimmed", async () => {
    // Regression: warmed assets sat in the LRU static cache and were evicted first.
    servePrecache(worker);
    worker.routes.set(`${ORIGIN}/_next/static/chunks/offline-1.js`, () => new Response("offline js"));
    await worker.dispatch("install");
    for (let i = 0; i < 260; i += 1) {
      const path = `/_next/static/chunks/other-${i}.js`;
      worker.routes.set(`${ORIGIN}${path}`, () => new Response(`chunk ${i}`));
      await worker.fetchEvent(worker.request(path));
    }
    expect(worker.caches.urls(`resq-static-${BUILD}`)).toHaveLength(250);
    worker.routes.clear();
    const offlineJs = await worker.fetchEvent(worker.request("/_next/static/chunks/offline-1.js"));
    expect(await offlineJs.response?.text()).toBe("offline js");
  });

  it("a new deploy installs fresh caches and drops the previous build's", async () => {
    servePrecache(worker);
    await worker.dispatch("install");
    await worker.dispatch("activate");

    const next = createWorker(`${ORIGIN}/sw.js?v=build-2`, worker.caches);
    const v2 = '<h1>offline v2</h1><script src="/_next/static/chunks/offline-2.js"></script>';
    // The shared CacheStorage fetches `addAll` entries through the first sandbox's network.
    servePrecache(worker, v2);
    servePrecache(next, v2);
    next.routes.set(`${ORIGIN}/_next/static/chunks/offline-2.js`, () => new Response("v2"));
    await next.dispatch("install");
    await next.dispatch("activate");

    const names = await next.caches.keys();
    expect(names).toEqual(expect.arrayContaining(["resq-precache-build-2", "resq-critical-build-2"]));
    expect(names.some((name) => name.endsWith(BUILD))).toBe(false);
    expect(next.caches.urls("resq-critical-build-2")).toContain(`${ORIGIN}/_next/static/chunks/offline-2.js`);
  });
});

describe("navigations", () => {
  it("is network-first and caches successful HTML pages", async () => {
    worker.routes.set(`${ORIGIN}/map`, () => html("live map"));
    const { response } = await worker.fetchEvent(worker.request("/map", { navigate: true }));
    expect(await response?.text()).toContain("live map");
    expect(worker.caches.urls("resq-pages-")).toEqual([`${ORIGIN}/map`]);
  });

  it("serves the cached page offline, otherwise the precached offline page", async () => {
    servePrecache(worker);
    await worker.dispatch("install");
    worker.routes.set(`${ORIGIN}/map`, () => html("live map"));
    await worker.fetchEvent(worker.request("/map", { navigate: true }));
    worker.routes.clear();

    const cached = await worker.fetchEvent(worker.request("/map?layer=hospitals", { navigate: true }));
    expect(await cached.response?.text()).toContain("live map");

    // Uncached pages are redirected to the precached offline page (HTML matches the URL).
    const fallback = await worker.fetchEvent(worker.request("/alerts?tab=news", { navigate: true }));
    expect(fallback.response?.status).toBe(302);
    const location = fallback.response?.headers.get("Location") ?? "";
    expect(location).toBe(`${ORIGIN}/offline?from=%2Falerts%3Ftab%3Dnews`);

    const offline = await worker.fetchEvent(worker.request(location, { navigate: true }));
    expect(offline.response?.status).toBe(200);
    expect(await offline.response?.text()).toContain("You are offline");
  });

  it("returns a built-in offline page when nothing is cached at all", async () => {
    const { response } = await worker.fetchEvent(worker.request("/alerts", { navigate: true }));
    expect(response?.status).toBe(503);
    const body = (await response?.text()) ?? "";
    expect(body).toContain("You're offline");
    expect(body).toContain('href="tel:112"');
  });

  it("uses the cached copy when the network is slower than 3 s", async () => {
    worker.routes.set(`${ORIGIN}/map`, () => html("cached map"));
    await worker.fetchEvent(worker.request("/map", { navigate: true }));

    vi.useFakeTimers();
    let resolveSlow: (value: Response) => void = () => {};
    worker.routes.set(`${ORIGIN}/map`, () => new Promise<Response>((resolve) => (resolveSlow = resolve)));
    const pending = worker.fetchEvent(worker.request("/map", { navigate: true }));
    await vi.advanceTimersByTimeAsync(3000);
    resolveSlow(html("fresh map"));
    const { response } = await pending;
    expect(await response?.text()).toContain("cached map");
    // The slow response still refreshed the cache in the background.
    const refreshed = await worker.caches.cache("resq-pages-")?.match(`${ORIGIN}/map`);
    expect(await refreshed?.text()).toContain("fresh map");
  });

  it("serves the saved page when the server answers 5xx, else the offline page for 502-504", async () => {
    servePrecache(worker);
    await worker.dispatch("install");
    worker.routes.set(`${ORIGIN}/map`, () => html("live map"));
    await worker.fetchEvent(worker.request("/map", { navigate: true }));

    // nginx's bare 502 page while the frontend container restarts.
    const gateway = () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    worker.routes.set(`${ORIGIN}/map`, gateway);
    const saved = await worker.fetchEvent(worker.request("/map", { navigate: true }));
    expect(saved.response?.status).toBe(200);
    expect(await saved.response?.text()).toContain("live map");

    worker.routes.set(`${ORIGIN}/alerts`, gateway);
    const unsaved = await worker.fetchEvent(worker.request("/alerts", { navigate: true }));
    expect(unsaved.response?.status).toBe(302);
    expect(unsaved.response?.headers.get("Location")).toBe(`${ORIGIN}/offline?from=%2Falerts`);

    // An application error page (500) without a saved copy is shown as is.
    worker.routes.set(
      `${ORIGIN}/chat`,
      () => new Response("app error", { status: 500, headers: { "Content-Type": "text/html" } }),
    );
    const appError = await worker.fetchEvent(worker.request("/chat", { navigate: true }));
    expect(appError.response?.status).toBe(500);
  });

  it("never handles NextAuth or other /api navigations", async () => {
    expect((await worker.fetchEvent(worker.request("/api/auth/callback/github", { navigate: true }))).responded).toBe(false);
    expect((await worker.fetchEvent(worker.request("/api/backend/weather", { navigate: true }))).responded).toBe(false);
  });
});

describe("static assets", () => {
  it("is cache-first for /_next/static and /icons", async () => {
    worker.routes.set(`${ORIGIN}/_next/static/chunks/app-1.js`, () => new Response("chunk"));
    await worker.fetchEvent(worker.request("/_next/static/chunks/app-1.js"));
    worker.routes.clear();
    const { response } = await worker.fetchEvent(worker.request("/_next/static/chunks/app-1.js"));
    expect(await response?.text()).toBe("chunk");
    expect(worker.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("API data", () => {
  const WEATHER = "/api/backend/weather?lat=28.6139&lon=77.209";

  it("is network-first and serves the cached copy offline, marked X-ResQ-Offline", async () => {
    worker.routes.set(`${ORIGIN}${WEATHER}`, () => json({ weather: { temperature: 31 } }));
    const online = await worker.fetchEvent(worker.request(WEATHER));
    expect(online.response?.headers.get("X-ResQ-Offline")).toBeNull();
    expect(await online.response?.json()).toEqual({ weather: { temperature: 31 } });

    worker.routes.clear();
    const offline = await worker.fetchEvent(worker.request(WEATHER));
    expect(offline.response?.headers.get("X-ResQ-Offline")).toBe("1");
    expect(offline.response?.headers.get("X-ResQ-Cached-At")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await offline.response?.json()).toEqual({ weather: { temperature: 31 } });
  });

  it("returns a JSON error envelope for uncached data while offline", async () => {
    const { response } = await worker.fetchEvent(worker.request("/api/backend/incidents?lat=1&lon=2"));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: { code: "network_error" } });
  });

  it("does not cache error responses or other endpoints, and never intercepts writes", async () => {
    worker.routes.set(`${ORIGIN}/api/backend/places?lat=1&lon=2&type=hospital`, () => json({ error: {} }, 502));
    await worker.fetchEvent(worker.request("/api/backend/places?lat=1&lon=2&type=hospital"));
    expect(worker.caches.urls("resq-api-")).toEqual([]);

    expect((await worker.fetchEvent(worker.request("/api/backend/sos/history"))).responded).toBe(false);
    expect((await worker.fetchEvent(worker.request("/api/backend/sos", { method: "POST", body: "{}" }))).responded).toBe(false);
    expect((await worker.fetchEvent(worker.request("/api/auth/session"))).responded).toBe(false);
  });

  it("offline, answers with the saved copy for the NEAREST location (GPS jitter)", async () => {
    // Regression: only the exact 4-decimal URL matched, so a new fix ~20 m away (or the
    // default location when desktop geolocation fails offline) found nothing.
    const saved = "/api/backend/places?lat=28.6139&lon=77.209&type=hospital&radius=5000";
    const farther = "/api/backend/places?lat=28.6239&lon=77.209&type=hospital&radius=5000";
    worker.routes.set(`${ORIGIN}${saved}`, () => json({ places: [{ id: "near" }] }));
    worker.routes.set(`${ORIGIN}${farther}`, () => json({ places: [{ id: "far" }] }));
    worker.routes.set(`${ORIGIN}/api/backend/places?lat=28.6141&lon=77.2091&type=police&radius=5000`, () =>
      json({ places: [{ id: "police" }] }),
    );
    await worker.fetchEvent(worker.request(saved));
    await worker.fetchEvent(worker.request(farther));
    await worker.fetchEvent(worker.request("/api/backend/places?lat=28.6141&lon=77.2091&type=police&radius=5000"));
    worker.routes.clear();

    // ~25 m from the first copy; parameters in another order still match.
    const jittered = await worker.fetchEvent(
      worker.request("/api/backend/places?radius=5000&type=hospital&lat=28.6141&lon=77.2091"),
    );
    expect(jittered.response?.status).toBe(200);
    expect(await jittered.response?.json()).toEqual({ places: [{ id: "near" }] });
    expect(jittered.response?.headers.get("X-ResQ-Offline")).toBe("1");
    expect(jittered.response?.headers.get("X-ResQ-Cached-At")).toMatch(/^\d{4}-/);
    expect(Number(jittered.response?.headers.get("X-ResQ-Cached-Distance-M"))).toBeLessThan(50);

    // Other filters never match (a police list is not a hospital list) ...
    const pharmacy = await worker.fetchEvent(
      worker.request("/api/backend/places?lat=28.6141&lon=77.2091&type=pharmacy&radius=5000"),
    );
    expect(pharmacy.response?.status).toBe(503);
    // ... nor does a copy beyond the tolerance (radius 5 km -> 1.25 km).
    const away = await worker.fetchEvent(
      worker.request("/api/backend/places?lat=28.6439&lon=77.209&type=hospital&radius=5000"),
    );
    expect(away.response?.status).toBe(503);
  });

  it("uses wider tolerances for weather and large incident radii", async () => {
    const weather = "/api/backend/weather?lat=28.6139&lon=77.209";
    const incidents = "/api/backend/incidents?lat=28.6139&lon=77.209&radius_km=50&status=open";
    worker.routes.set(`${ORIGIN}${weather}`, () => json({ weather: { temperature: 30 } }));
    worker.routes.set(`${ORIGIN}${incidents}`, () => json({ incidents: [] }));
    await worker.fetchEvent(worker.request(weather));
    await worker.fetchEvent(worker.request(incidents));
    worker.routes.clear();

    // ~3.3 km away: fine for weather (5 km) and incidents within 50 km (10 km cap).
    const w = await worker.fetchEvent(worker.request("/api/backend/weather?lat=28.6439&lon=77.209"));
    expect(await w.response?.json()).toEqual({ weather: { temperature: 30 } });
    const i = await worker.fetchEvent(
      worker.request("/api/backend/incidents?lat=28.6439&lon=77.209&radius_km=50&status=open"),
    );
    expect(i.response?.status).toBe(200);
    // ~11 km away: too far for both.
    const tooFar = await worker.fetchEvent(worker.request("/api/backend/weather?lat=28.7139&lon=77.209"));
    expect(tooFar.response?.status).toBe(503);
  });

  it("prefers a saved copy over a 5xx from the server (backend down)", async () => {
    const path = "/api/backend/alerts/disasters?limit=50";
    worker.routes.set(`${ORIGIN}${path}`, () => json({ events: [{ id: "eq-1" }] }));
    await worker.fetchEvent(worker.request(path));

    worker.routes.set(`${ORIGIN}${path}`, () =>
      json({ error: { code: "backend_unreachable", message: "down", request_id: "" } }, 502),
    );
    const { response } = await worker.fetchEvent(worker.request(path));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ events: [{ id: "eq-1" }] });
    expect(response?.headers.get("X-ResQ-Offline")).toBe("1");
    expect(response?.headers.get("X-ResQ-Offline-Reason")).toBe("server-error");
    // The error never replaced the saved copy.
    const stored = await worker.caches.cache("resq-api-")?.match(`${ORIGIN}${path}`);
    expect(stored?.status).toBe(200);

    // Nothing saved: the server's error is passed through unchanged.
    worker.routes.set(`${ORIGIN}/api/backend/weather?lat=1&lon=2`, () => json({ error: {} }, 502));
    const uncached = await worker.fetchEvent(worker.request("/api/backend/weather?lat=1&lon=2"));
    expect(uncached.response?.status).toBe(502);
  });

  it("caps the API cache at 50 entries", async () => {
    for (let i = 0; i < 55; i += 1) {
      const path = `/api/backend/alerts/disasters?limit=${i}`;
      worker.routes.set(`${ORIGIN}${path}`, () => json({ events: [], i }));
      await worker.fetchEvent(worker.request(path));
    }
    const urls = worker.caches.urls("resq-api-");
    expect(urls).toHaveLength(50);
    expect(urls[0]).toContain("limit=5");
  });
});

describe("map tiles", () => {
  const TILE = "https://a.tile.openstreetmap.org/12/2925/1712.png";

  it("is stale-while-revalidate and stores CORS (non-opaque) tiles", async () => {
    worker.routes.set(TILE, () => new Response("tile-v1", { headers: { "Content-Type": "image/png" } }));
    const first = await worker.fetchEvent(new Request(TILE));
    expect(await first.response?.text()).toBe("tile-v1");

    worker.routes.set(TILE, () => new Response("tile-v2"));
    const second = await worker.fetchEvent(new Request(TILE));
    expect(await second.response?.text()).toBe("tile-v1");
    const updated = await worker.caches.cache("resq-tiles-")?.match(TILE);
    expect(await updated?.text()).toBe("tile-v2");
  });

  it("never stores opaque responses", async () => {
    worker.routes.set(TILE, () => {
      const response = new Response("opaque");
      Object.defineProperty(response, "type", { value: "opaque" });
      return response;
    });
    await worker.fetchEvent(new Request(TILE));
    expect(worker.caches.urls("resq-tiles-")).toEqual([]);
  });
});

describe("push notifications", () => {
  const pushData = (value: unknown) => ({
    json: () => (typeof value === "string" ? JSON.parse(value) : value),
    text: () => (typeof value === "string" ? value : JSON.stringify(value)),
  });

  it("shows the backend payload; high severity requires interaction", async () => {
    await worker.dispatch("push", {
      data: pushData({
        title: "High flood reported nearby",
        body: "Water rising on MG Road",
        url: "/incidents?focus=abc",
        tag: "incident-abc",
        severity: "high",
      }),
    });
    expect(worker.registration.showNotification).toHaveBeenCalledWith(
      "High flood reported nearby",
      expect.objectContaining({
        body: "Water rising on MG Road",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-72.png",
        tag: "incident-abc",
        renotify: true,
        requireInteraction: true,
        data: { url: "/incidents?focus=abc" },
      }),
    );
  });

  it("sanitises foreign URLs and tolerates non-JSON payloads", async () => {
    await worker.dispatch("push", {
      data: pushData({ title: "x", body: "y", url: "https://evil.example/phish", severity: "low" }),
    });
    const [, options] = worker.registration.showNotification.mock.calls[0];
    expect(options).toMatchObject({ data: { url: "/" }, requireInteraction: false });
    expect(options).not.toHaveProperty("tag");

    await worker.dispatch("push", {
      data: { json: () => JSON.parse("not json"), text: () => "Plain text alert" },
    });
    expect(worker.registration.showNotification).toHaveBeenLastCalledWith(
      "ResQ AI alert",
      expect.objectContaining({ body: "Plain text alert", data: { url: "/alerts" } }),
    );
  });

  it("focuses an open window at the URL, navigates another app window, or opens a new one", async () => {
    const close = vi.fn();
    const notification = { close, data: { url: "/alerts" } };

    const exact = { url: `${ORIGIN}/alerts`, focus: vi.fn().mockResolvedValue("focused") };
    worker.clients.matchAll.mockResolvedValueOnce([exact]);
    await worker.dispatch("notificationclick", { notification });
    expect(close).toHaveBeenCalled();
    expect(exact.focus).toHaveBeenCalled();

    const focusedAfterNavigate = { focus: vi.fn().mockResolvedValue("focused") };
    const other = { url: `${ORIGIN}/map`, focus: vi.fn(), navigate: vi.fn().mockResolvedValue(focusedAfterNavigate) };
    worker.clients.matchAll.mockResolvedValueOnce([other]);
    await worker.dispatch("notificationclick", { notification });
    expect(other.navigate).toHaveBeenCalledWith(`${ORIGIN}/alerts`);
    expect(focusedAfterNavigate.focus).toHaveBeenCalled();

    worker.clients.matchAll.mockResolvedValueOnce([]);
    await worker.dispatch("notificationclick", { notification: { close, data: { url: "//evil.example" } } });
    expect(worker.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("re-registers a rotated push subscription with the backend", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    worker.fetchImpl.mockImplementation(async (input: unknown, init?: unknown) => {
      posts.push({ url: absolute(input), body: JSON.parse(String((init as RequestInit).body)) });
      return json({ ok: true });
    });
    const newSubscription = {
      toJSON: () => ({ endpoint: "https://push.example/new", expirationTime: null, keys: { p256dh: "p", auth: "a" } }),
    };
    worker.registration.pushManager.subscribe.mockResolvedValue(newSubscription);

    await worker.dispatch("pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://push.example/old", options: { userVisibleOnly: true } },
      newSubscription: null,
    });
    expect(worker.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true });
    expect(posts).toEqual([
      {
        url: `${ORIGIN}/api/backend/push/subscribe`,
        body: { subscription: { endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } } },
      },
      { url: `${ORIGIN}/api/backend/push/unsubscribe`, body: { endpoint: "https://push.example/old" } },
    ]);
  });
});
