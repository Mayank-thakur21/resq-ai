import { readFileSync } from "node:fs";
import path from "node:path";

import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: auth.signOut }));

import { CHAT_HISTORY_STORAGE_KEY } from "@/app/chat/chat-helpers";
import { INCIDENT_DRAFT_KEY } from "@/components/IncidentForm";
import { PUSH_SYNCED_STORAGE_KEY } from "@/lib/push";
import {
  API_CACHE_NAME,
  CLEAR_API_CACHE_MESSAGE,
  forgetUserData,
  INCIDENT_DRAFT_STORAGE_KEY,
  signOutAndForget,
} from "@/lib/sign-out";
import { SOS_NAME_STORAGE_KEY, storeSosName } from "@/lib/sos-name";

/** jsdom cannot navigate: stands in for `window.location` (restored by `unstubGlobals`). */
function stubLocation() {
  const location = { origin: window.location.origin, href: window.location.href, assign: vi.fn(), reload: vi.fn() };
  vi.stubGlobal("location", location);
  return location;
}

let location: ReturnType<typeof stubLocation>;

beforeEach(() => {
  auth.signOut.mockReset().mockResolvedValue({ url: "http://localhost:3000/" });
  window.sessionStorage.clear();
  location = stubLocation();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("signOutAndForget", () => {
  it("uses the incident form's draft key", () => {
    expect(INCIDENT_DRAFT_STORAGE_KEY).toBe(INCIDENT_DRAFT_KEY);
  });

  it("clears the SW API cache and chat transcript before signing out", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage } },
    });
    window.sessionStorage.setItem(CHAT_HISTORY_STORAGE_KEY, "[]");
    window.sessionStorage.setItem(INCIDENT_DRAFT_KEY, "{}");
    window.localStorage.setItem("resq_contacts", "[]");
    window.localStorage.setItem("resq_last_fix", '{"lat":1,"lon":2,"accuracy":null,"at":1}');

    await signOutAndForget("/login");

    expect(postMessage).toHaveBeenCalledWith(CLEAR_API_CACHE_MESSAGE);
    expect(window.sessionStorage.getItem(CHAT_HISTORY_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(INCIDENT_DRAFT_KEY)).toBeNull();
    expect(window.localStorage.getItem("resq_last_fix")).toBeNull();
    // Device data that is not tied to the account is kept.
    expect(window.localStorage.getItem("resq_contacts")).toBe("[]");
    // NextAuth must not navigate by itself: the cache is cleared again after its request.
    expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: "/login", redirect: false });
    expect(location.assign).toHaveBeenCalledWith("/login");
    window.localStorage.clear();
  });

  it("forgets the push re-sync marker and unlinks the device before signing out", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      order.push(`fetch ${new URL(input, "http://localhost").pathname} ${String(init?.body)}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("PushManager", function PushManager() {});
    vi.stubGlobal("Notification", { permission: "granted" });
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/dev1" };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: null,
        getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }),
      },
    });
    auth.signOut.mockImplementation(async () => {
      order.push("signOut");
    });
    window.sessionStorage.setItem(PUSH_SYNCED_STORAGE_KEY, `${subscription.endpoint}|user-a`);

    try {
      await signOutAndForget();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(window.sessionStorage.getItem(PUSH_SYNCED_STORAGE_KEY)).toBeNull();
    expect(order).toEqual([
      `fetch /api/backend/push/unlink ${JSON.stringify({ endpoint: subscription.endpoint })}`,
      "signOut",
    ]);
  });

  it("never throws without a service worker or when storage is blocked", async () => {
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      await expect(forgetUserData()).resolves.toBeUndefined();
      await expect(signOutAndForget()).resolves.toBeUndefined();
      expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: "/", redirect: false });
      expect(location.assign).toHaveBeenCalledWith("/");
    } finally {
      removeItem.mockRestore();
    }
  });
});

describe("forgetUserData (review round 3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("deletes the API cache even when no service worker controls the page", async () => {
    // Regression: after a hard reload (Shift+Reload) the page has no controller, so the
    // CLEAR_API_CACHE message went nowhere and the previous user's incidents stayed cached.
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", { delete: deleteCache });
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: null, getRegistration: async () => ({ active: { postMessage } }) },
    });

    await forgetUserData();

    expect(deleteCache).toHaveBeenCalledWith(API_CACHE_NAME);
    // The active (non-controlling) worker is still told, so in-flight responses are dropped.
    expect(postMessage).toHaveBeenCalledWith(CLEAR_API_CACHE_MESSAGE);
  });

  it("finishes clearing before NextAuth navigates away", async () => {
    let deleted = false;
    vi.stubGlobal("caches", {
      delete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        deleted = true;
        return true;
      },
    });
    auth.signOut.mockImplementation(async () => {
      expect(deleted).toBe(true);
    });
    await signOutAndForget();
    expect(auth.signOut).toHaveBeenCalled();
  });

  it("uses the service worker's API cache name", () => {
    // jsdom's import.meta.url is not a file: URL; vitest runs from the frontend root.
    const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");
    const prefix = /const CACHE_PREFIX = "([^"]+)";/.exec(source)?.[1];
    const version = /const DATA_CACHE_VERSION = "([^"]+)";/.exec(source)?.[1];
    expect(source).toContain("api: `${CACHE_PREFIX}api-v${DATA_CACHE_VERSION}`");
    expect(API_CACHE_NAME).toBe(`${prefix}api-v${version}`);
  });

  it("forgets the remembered SOS sender name", async () => {
    storeSosName("Alice Upvoter", "u-alice");
    window.localStorage.setItem("resq_contacts", "[]");
    await forgetUserData();
    expect(window.localStorage.getItem(SOS_NAME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem("resq_contacts")).toBe("[]");
  });
});

describe("signOutAndForget ordering (review round 4)", () => {
  // A successful sign-out leaves the module "signing out" until the page is replaced, so
  // every test here loads fresh copies of the modules that hold that state.
  async function freshModules() {
    vi.resetModules();
    const signOutModule = await import("@/lib/sign-out");
    const { swrConfig } = await import("@/components/Providers");
    const swr = await import("swr");
    return { ...signOutModule, swrConfig, swr };
  }

  /**
   * Fake browser around a sign-out: the worker's API cache (`stored`), the CLEAR_API_CACHE
   * messages and cache deletions, NextAuth's request and the navigation, all in `steps`.
   */
  function fakeBrowser() {
    const steps: string[] = [];
    const stored = new Set<string>();
    vi.stubGlobal("caches", {
      delete: async (name: string) => {
        steps.push(`delete ${name}`);
        if (name === API_CACHE_NAME) stored.clear();
        return true;
      },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage: (message: { type: string }) => steps.push(`message ${message.type}`) } },
    });
    auth.signOut.mockImplementation(async (options: unknown) => {
      steps.push(`signOut ${JSON.stringify(options)}`);
      return { url: "http://localhost:3000/login" };
    });
    location.assign.mockImplementation((url: string) => steps.push(`assign ${url}`));
    return { steps, stored };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("clears the API cache again once NextAuth has deleted the session cookie, then loads the page", async () => {
    const { signOutAndForget: signOutFresh } = await freshModules();
    const { steps } = fakeBrowser();

    await signOutFresh("/login");

    // Regression: the cache was only cleared before the sign-out request, and NextAuth then
    // navigated by itself, so nothing ran once the cookie was actually gone.
    expect(steps).toEqual([
      "message CLEAR_API_CACHE",
      `delete ${API_CACHE_NAME}`,
      'signOut {"callbackUrl":"/login","redirect":false}',
      "message CLEAR_API_CACHE",
      `delete ${API_CACHE_NAME}`,
      "assign /login",
    ]);
  });

  it("drops a response the worker stored with the old session during the sign-out request", async () => {
    const { signOutAndForget: signOutFresh } = await freshModules();
    const { stored } = fakeBrowser();
    auth.signOut.mockImplementation(async () => {
      // The incidents list refreshed (still authenticated) while the request was on its way.
      stored.add("/api/backend/incidents?lat=28.61&lon=77.21 upvoted_by_me=true");
      return { url: "http://localhost:3000/" };
    });

    await signOutFresh();

    expect(stored.size).toBe(0);
  });

  it("pauses SWR revalidation until the page is replaced", async () => {
    const { signOutAndForget: signOutFresh, isSigningOut, swrConfig, swr } = await freshModules();
    fakeBrowser();
    let finishSignOut: (value: { url: string }) => void = () => {};
    auth.signOut.mockImplementation(() => new Promise((resolve) => (finishSignOut = resolve)));
    const useSWR = swr.default;
    const fetcher = vi.fn(async () => ({ ok: true }));
    function Incidents() {
      useSWR("/incidents?lat=1&lon=2", fetcher, { refreshInterval: 20 });
      return null;
    }
    render(
      createElement(
        swr.SWRConfig,
        { value: { ...swrConfig, provider: () => new Map(), dedupingInterval: 0 } },
        createElement(Incidents),
      ),
    );
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(swrConfig.isPaused?.()).toBe(false);

    const done = signOutFresh();
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(isSigningOut()).toBe(true);
    expect(swrConfig.isPaused?.()).toBe(true);
    const callsAtSignOut = fetcher.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Several refresh intervals went by without a request carrying the ending session.
    expect(fetcher.mock.calls.length).toBe(callsAtSignOut);

    finishSignOut({ url: "http://localhost:3000/" });
    await done;
    // Still paused: the page is being replaced by the signed-out one.
    expect(isSigningOut()).toBe(true);
    expect(location.assign).toHaveBeenCalledWith("/");
  });

  it("resumes SWR and keeps the data forgotten when the sign-out request fails", async () => {
    const { signOutAndForget: signOutFresh, isSigningOut } = await freshModules();
    const { steps, stored } = fakeBrowser();
    auth.signOut.mockImplementation(async () => {
      stored.add("/api/backend/incidents?lat=28.61&lon=77.21");
      throw new TypeError("Failed to fetch");
    });

    await expect(signOutFresh()).rejects.toThrow("Failed to fetch");

    // Whether the cookie survived is unknown, so the cache is cleared again anyway...
    expect(steps.filter((step) => step === `delete ${API_CACHE_NAME}`)).toHaveLength(2);
    expect(stored.size).toBe(0);
    // ...but the user is still signed in as far as the app knows: no navigation, SWR resumes.
    expect(location.assign).not.toHaveBeenCalled();
    expect(isSigningOut()).toBe(false);
  });

  it("only ever loads a page of this app afterwards", async () => {
    const { signOutAndForget: signOutFresh } = await freshModules();
    fakeBrowser();

    await signOutFresh("/incidents?focus=abc");
    await signOutFresh("https://evil.example/phish");
    await signOutFresh("//evil.example/phish");
    await signOutFresh(`${window.location.origin}/login`);

    expect(location.assign.mock.calls.map(([url]) => url)).toEqual(["/incidents?focus=abc", "/", "/", "/login"]);
    expect(location.reload).not.toHaveBeenCalled();
    // A fragment-only change would not load a new page, so it is reloaded (as NextAuth does).
    await signOutFresh("/#top");
    expect(location.assign).toHaveBeenLastCalledWith("/#top");
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads the page if the browser restores it from the back/forward cache", async () => {
    const { signOutAndForget: signOutFresh } = await freshModules();
    fakeBrowser();
    await signOutFresh();

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    expect(location.reload).not.toHaveBeenCalled();
    // Restored with the previous account's data in memory (and SWR paused): load it afresh.
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(location.reload).toHaveBeenCalled();
  });
});
