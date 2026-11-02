import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import {
  decodeVapidPublicKey,
  getPushStatus,
  getPushSupport,
  isPushSupported,
  loadPushPreferences,
  PUSH_PREFS_STORAGE_KEY,
  PUSH_SYNCED_STORAGE_KEY,
  PushError,
  resyncSubscription,
  SERVICE_WORKER_URL,
  subscribe,
  unlinkCurrentSubscription,
  unsubscribe,
  urlBase64ToUint8Array,
} from "@/lib/push";

// ---------------------------------------------------------------------------------------
// Fakes: Notification, PushManager, service worker registration, backend (fetch)
// ---------------------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(65);
  bytes[0] = 0x04;
  for (let i = 1; i < 65; i += 1) bytes[i] = (i * seed) % 256;
  return bytes;
}

const KEY_BYTES = makeKey(3);
const VAPID_KEY = toBase64Url(KEY_BYTES);

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
}

function makeSubscription(endpoint: string, key: Uint8Array | null): FakeSubscription {
  return {
    endpoint,
    options: { applicationServerKey: key ? (key.slice().buffer as ArrayBuffer) : null },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-secret" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

interface Env {
  current: FakeSubscription | null;
  pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  serviceWorker: {
    getRegistration: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
    ready: Promise<unknown>;
  };
  notification: { permission: NotificationPermission; next: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };
  fetch: ReturnType<typeof vi.fn>;
  backend: {
    vapid: { enabled: boolean; public_key: string | null };
    subscribeStatus: number;
    unsubscribeStatus: number;
  };
}

let env: Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installBrowser({ registered = true }: { registered?: boolean } = {}): Env {
  const state = {} as Env;
  state.current = null;
  state.backend = { vapid: { enabled: true, public_key: VAPID_KEY }, subscribeStatus: 200, unsubscribeStatus: 200 };

  state.pushManager = {
    getSubscription: vi.fn(async () => state.current),
    subscribe: vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
      state.current = makeSubscription("https://push.example/new", new Uint8Array(options.applicationServerKey));
      return state.current;
    }),
  };
  const registration = { active: {}, pushManager: state.pushManager };
  state.serviceWorker = {
    getRegistration: vi.fn(async () => (registered ? registration : undefined)),
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
  };
  Object.defineProperty(navigator, "serviceWorker", { value: state.serviceWorker, configurable: true });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  vi.stubGlobal("PushManager", function PushManager() {});

  const notification = {
    permission: "default" as NotificationPermission,
    next: "granted" as NotificationPermission,
    requestPermission: vi.fn(async () => {
      notification.permission = notification.next;
      return notification.next;
    }),
  };
  state.notification = notification;
  vi.stubGlobal("Notification", {
    get permission() {
      return notification.permission;
    },
    requestPermission: notification.requestPermission,
  });

  state.fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/backend/push/vapid-public-key") return jsonResponse(state.backend.vapid);
    if (url.pathname === "/api/backend/push/subscribe") {
      if (state.backend.subscribeStatus !== 200) {
        return jsonResponse(
          { error: { code: "upstream_error", message: "Database unavailable", request_id: "r1" } },
          state.backend.subscribeStatus,
        );
      }
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ id: "sub-1", radius_km: body.radius_km, topics: body.topics });
    }
    if (url.pathname === "/api/backend/push/unlink") return jsonResponse({ ok: true });
    if (url.pathname === "/api/backend/push/unsubscribe") {
      return state.backend.unsubscribeStatus === 200
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: { code: "internal_error", message: "boom", request_id: "" } }, 500);
    }
    return jsonResponse({ error: { code: "not_found", message: "Not found", request_id: "" } }, 404);
  });
  vi.stubGlobal("fetch", state.fetch);
  return state;
}

function callsTo(path: string) {
  return env.fetch.mock.calls.filter(([input]) => new URL(String(input), "http://localhost").pathname === path);
}

function lastSubscribeBody() {
  const calls = callsTo("/api/backend/push/subscribe");
  return JSON.parse(String(calls[calls.length - 1][1].body));
}

beforeEach(() => {
  env = installBrowser();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (window as { isSecureContext?: unknown }).isSecureContext;
});

// ---------------------------------------------------------------------------------------

describe("urlBase64ToUint8Array / decodeVapidPublicKey", () => {
  it("decodes base64url with and without padding", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([0xfb, 0xff]);
    expect(Array.from(urlBase64ToUint8Array("-_8="))).toEqual([0xfb, 0xff]);
    expect(Array.from(urlBase64ToUint8Array("+/8"))).toEqual([0xfb, 0xff]);
    expect(urlBase64ToUint8Array(VAPID_KEY)).toEqual(KEY_BYTES);
  });

  it("rejects invalid input", () => {
    expect(() => urlBase64ToUint8Array("not base64!")).toThrow(TypeError);
    expect(() => urlBase64ToUint8Array("A")).toThrow(TypeError);
  });

  it("validates the VAPID key shape", () => {
    expect(decodeVapidPublicKey(VAPID_KEY)).toEqual(KEY_BYTES);
    expect(() => decodeVapidPublicKey("AQID")).toThrow(PushError);
    try {
      decodeVapidPublicKey("%%%");
    } catch (error) {
      expect((error as PushError).code).toBe("invalid_key");
    }
  });
});

describe("getPushSupport", () => {
  it("is supported when every API is present in a secure context", () => {
    expect(getPushSupport()).toEqual({ supported: true });
    expect(isPushSupported()).toBe(true);
  });

  it("reports insecure contexts", () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    expect(getPushSupport()).toMatchObject({ supported: false, reason: "insecure" });
  });

  it("reports missing APIs and the iOS install hint", () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(getPushSupport()).toEqual({ supported: false, reason: "no_api", iosNeedsInstall: false });

    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
    );
    expect(getPushSupport()).toEqual({ supported: false, reason: "no_api", iosNeedsInstall: true });
  });
});

describe("subscribe", () => {
  it("asks permission, subscribes with the VAPID key and registers with the backend", async () => {
    const result = await subscribe({ lat: 28.613912, lon: 77.209012, radiusKm: 100, topics: ["disasters"] });

    expect(env.notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(env.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const options = env.pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(new Uint8Array(options.applicationServerKey)).toEqual(KEY_BYTES);

    expect(lastSubscribeBody()).toEqual({
      subscription: { endpoint: "https://push.example/new", keys: { p256dh: "p256dh-key", auth: "auth-secret" } },
      radius_km: 100,
      topics: ["disasters"],
      lat: 28.614,
      lon: 77.209,
    });
    expect(result.server).toEqual({ id: "sub-1", radius_km: 100, topics: ["disasters"] });
    expect(loadPushPreferences()).toEqual({ radiusKm: 100, topics: ["disasters"], lat: 28.614, lon: 77.209 });
  });

  it("skips the key request when the caller passes it, and uses lazy locate()", async () => {
    const locate = vi.fn(async () => ({ lat: 10, lon: 20 }));
    await subscribe({ vapidPublicKey: VAPID_KEY, locate });
    expect(callsTo("/api/backend/push/vapid-public-key")).toHaveLength(0);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(lastSubscribeBody()).toMatchObject({ lat: 10, lon: 20, radius_km: 50, topics: ["incidents", "disasters"] });
  });

  it("omits the location when it is unknown", async () => {
    await subscribe({ vapidPublicKey: VAPID_KEY, locate: async () => null });
    const body = lastSubscribeBody();
    expect(body).not.toHaveProperty("lat");
    expect(body).not.toHaveProperty("lon");
  });

  it("fails with 'disabled' when the backend has no VAPID keys (no permission prompt)", async () => {
    env.backend.vapid = { enabled: false, public_key: null };
    await expect(subscribe()).rejects.toMatchObject({ name: "PushError", code: "disabled" });
    expect(env.notification.requestPermission).not.toHaveBeenCalled();
  });

  it("fails with 'denied' / 'dismissed' when permission isn't granted", async () => {
    env.notification.next = "denied";
    await expect(subscribe({ vapidPublicKey: VAPID_KEY })).rejects.toMatchObject({ code: "denied" });
    expect(env.pushManager.subscribe).not.toHaveBeenCalled();

    env.notification.permission = "default";
    env.notification.next = "default";
    await expect(subscribe({ vapidPublicKey: VAPID_KEY })).rejects.toMatchObject({ code: "dismissed" });
  });

  it("rolls back a new browser subscription when the backend rejects it", async () => {
    env.backend.subscribeStatus = 502;
    const error = await subscribe({ vapidPublicKey: VAPID_KEY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect(env.current?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(PUSH_PREFS_STORAGE_KEY)).toBeNull();
  });

  it("reuses an existing subscription created with the same key", async () => {
    env.current = makeSubscription("https://push.example/existing", KEY_BYTES);
    await subscribe({ vapidPublicKey: VAPID_KEY });
    expect(env.pushManager.subscribe).not.toHaveBeenCalled();
    expect(lastSubscribeBody().subscription.endpoint).toBe("https://push.example/existing");
  });

  it("replaces a subscription made with an outdated key", async () => {
    const old = makeSubscription("https://push.example/old", makeKey(7));
    env.current = old;
    await subscribe({ vapidPublicKey: VAPID_KEY });
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(env.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(lastSubscribeBody().subscription.endpoint).toBe("https://push.example/new");
  });

  it("refuses to register a service worker outside production unless opted in", async () => {
    env = installBrowser({ registered: false });
    await expect(subscribe({ vapidPublicKey: VAPID_KEY })).rejects.toMatchObject({ code: "no_service_worker" });
    expect(env.serviceWorker.register).not.toHaveBeenCalled();

    vi.stubEnv("NEXT_PUBLIC_ENABLE_SW_IN_DEV", "true");
    await subscribe({ vapidPublicKey: VAPID_KEY });
    expect(env.serviceWorker.register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: "/" });
    expect(SERVICE_WORKER_URL).toMatch(/^\/sw\.js\?v=[A-Za-z0-9._-]+$/);
  });

  it("reports unsupported browsers before any request", async () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    await expect(subscribe()).rejects.toMatchObject({ code: "unsupported" });
    expect(env.fetch).not.toHaveBeenCalled();
  });
});

describe("unsubscribe", () => {
  it("removes the browser subscription, tells the backend and clears preferences", async () => {
    await subscribe({ vapidPublicKey: VAPID_KEY });
    const subscription = env.current;
    await expect(unsubscribe()).resolves.toBe(true);
    expect(subscription?.unsubscribe).toHaveBeenCalledTimes(1);
    const [, init] = callsTo("/api/backend/push/unsubscribe")[0];
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: "https://push.example/new" });
    expect(loadPushPreferences()).toBeNull();
  });

  it("still succeeds when the backend call fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    env.current = makeSubscription("https://push.example/x", KEY_BYTES);
    env.backend.unsubscribeStatus = 500;
    await expect(unsubscribe()).resolves.toBe(true);
  });

  it("returns false when there is nothing to remove", async () => {
    await expect(unsubscribe()).resolves.toBe(false);
    expect(callsTo("/api/backend/push/unsubscribe")).toHaveLength(0);
  });

  it("throws unsubscribe_failed when the browser refuses", async () => {
    env.current = makeSubscription("https://push.example/x", KEY_BYTES);
    env.current.unsubscribe.mockResolvedValueOnce(false);
    await expect(unsubscribe()).rejects.toMatchObject({ code: "unsubscribe_failed" });
  });
});

describe("getPushStatus / resyncSubscription", () => {
  it("reports denied, unsubscribed and subscribed states", async () => {
    await expect(getPushStatus()).resolves.toEqual({ state: "unsubscribed" });

    env.notification.permission = "denied";
    await expect(getPushStatus()).resolves.toEqual({ state: "denied" });

    env.notification.permission = "granted";
    window.localStorage.setItem(PUSH_PREFS_STORAGE_KEY, JSON.stringify({ radiusKm: 25, topics: ["incidents"] }));
    env.current = makeSubscription("https://push.example/x", KEY_BYTES);
    await expect(getPushStatus()).resolves.toMatchObject({
      state: "subscribed",
      prefs: { radiusKm: 25, topics: ["incidents"] },
    });
  });

  it("re-registers once per session and never guesses missing preferences", async () => {
    env.current = makeSubscription("https://push.example/x", KEY_BYTES);
    await expect(resyncSubscription()).resolves.toBe(false); // no stored prefs

    window.localStorage.setItem(
      PUSH_PREFS_STORAGE_KEY,
      JSON.stringify({ radiusKm: 100, topics: ["disasters"], lat: 1.5, lon: 2.5 }),
    );
    await expect(resyncSubscription()).resolves.toBe(true);
    await expect(resyncSubscription()).resolves.toBe(false);
    expect(callsTo("/api/backend/push/subscribe")).toHaveLength(1);
    expect(lastSubscribeBody()).toMatchObject({ radius_km: 100, topics: ["disasters"], lat: 1.5, lon: 2.5 });
  });

  it("re-posts after sign-in, after sign-out and when another user signs in", async () => {
    // Regression: the marker ignored the identity, so signing in in the same tab never
    // linked the device to the account (test notifications reported 0 devices).
    env.current = makeSubscription("https://push.example/x", KEY_BYTES);
    window.localStorage.setItem(PUSH_PREFS_STORAGE_KEY, JSON.stringify({ radiusKm: 50, topics: ["incidents"] }));

    await expect(resyncSubscription({ identity: null })).resolves.toBe(true); // signed out
    await expect(resyncSubscription({ identity: null })).resolves.toBe(false);
    await expect(resyncSubscription({ identity: "user-a" })).resolves.toBe(true); // signs in
    await expect(resyncSubscription({ identity: "user-a" })).resolves.toBe(false);
    await expect(resyncSubscription({ identity: "user-b" })).resolves.toBe(true); // other user
    expect(callsTo("/api/backend/push/subscribe")).toHaveLength(3);
  });

  it("subscribe() records the identity it subscribed with", async () => {
    window.localStorage.setItem(PUSH_PREFS_STORAGE_KEY, JSON.stringify({ radiusKm: 50, topics: ["incidents"] }));
    await subscribe({ vapidPublicKey: VAPID_KEY, identity: "user-a" });
    const calls = callsTo("/api/backend/push/subscribe").length;
    await expect(resyncSubscription({ identity: "user-a" })).resolves.toBe(false);
    await expect(resyncSubscription({ identity: null })).resolves.toBe(true);
    expect(callsTo("/api/backend/push/subscribe")).toHaveLength(calls + 1);
  });

  it("unlinkCurrentSubscription() detaches the device and forgets the marker", async () => {
    env.current = makeSubscription("https://push.example/x", KEY_BYTES);
    window.sessionStorage.setItem(PUSH_SYNCED_STORAGE_KEY, "https://push.example/x|user-a");
    await expect(unlinkCurrentSubscription()).resolves.toBe(true);
    expect(window.sessionStorage.getItem(PUSH_SYNCED_STORAGE_KEY)).toBeNull();
    expect(callsTo("/api/backend/push/unlink")).toHaveLength(1);

    env.current = null;
    await expect(unlinkCurrentSubscription()).resolves.toBe(false);
    expect(callsTo("/api/backend/push/unlink")).toHaveLength(1);
  });

  it("ignores corrupt stored preferences", () => {
    window.localStorage.setItem(PUSH_PREFS_STORAGE_KEY, "{not json");
    expect(loadPushPreferences()).toBeNull();
    window.localStorage.setItem(PUSH_PREFS_STORAGE_KEY, JSON.stringify({ radiusKm: 9999, topics: ["bogus"] }));
    expect(loadPushPreferences()).toEqual({ radiusKm: 50, topics: ["incidents", "disasters"] });
  });
});
