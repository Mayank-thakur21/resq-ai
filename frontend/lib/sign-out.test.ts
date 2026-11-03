import { readFileSync } from "node:fs";
import path from "node:path";

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

beforeEach(() => {
  auth.signOut.mockReset().mockResolvedValue(undefined);
  window.sessionStorage.clear();
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
    expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
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
      expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
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
