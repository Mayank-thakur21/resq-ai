import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: auth.signOut }));

import { CHAT_HISTORY_STORAGE_KEY } from "@/app/chat/chat-helpers";
import { INCIDENT_DRAFT_KEY } from "@/components/IncidentForm";
import { PUSH_SYNCED_STORAGE_KEY } from "@/lib/push";
import {
  CLEAR_API_CACHE_MESSAGE,
  forgetUserData,
  INCIDENT_DRAFT_STORAGE_KEY,
  signOutAndForget,
} from "@/lib/sign-out";

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
      expect(() => forgetUserData()).not.toThrow();
      await expect(signOutAndForget()).resolves.toBeUndefined();
      expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
    } finally {
      removeItem.mockRestore();
    }
  });
});
