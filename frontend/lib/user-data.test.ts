import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: auth.signOut }));

import { CHAT_HISTORY_STORAGE_KEY } from "@/app/chat/chat-helpers";
import { LAST_FIX_STORAGE_KEY, readLastFix, rememberLastFix, useGeolocation } from "@/lib/geo";
import { signOutAndForget } from "@/lib/sign-out";
import { readSosName, SOS_NAME_STORAGE_KEY, storeSosName } from "@/lib/sos-name";
import { isSigningOut, setSigningOut, writeUserData } from "@/lib/user-data";

type SuccessCb = (position: GeolocationPosition) => void;

/** A `navigator.geolocation` whose watch can deliver any number of fixes. */
function installWatchableGeolocation() {
  let onFix: SuccessCb | null = null;
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: vi.fn(),
      watchPosition: vi.fn((success: SuccessCb) => {
        onFix = success;
        return 1;
      }),
      clearWatch: vi.fn(),
    },
  });
  return (lat: number, lon: number) =>
    onFix?.({
      coords: { latitude: lat, longitude: lon, accuracy: 10 } as GeolocationCoordinates,
      timestamp: Date.now(),
    } as GeolocationPosition);
}

beforeEach(() => {
  auth.signOut.mockReset().mockResolvedValue({ url: "http://localhost:3000/" });
  // jsdom cannot navigate: the page that signed out stays, as it does until the next loads.
  vi.stubGlobal("location", {
    origin: window.location.origin,
    href: window.location.href,
    assign: vi.fn(),
    reload: vi.fn(),
  });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  // A successful sign-out leaves the page "signing out" until it is replaced.
  setSigningOut(false);
  Reflect.deleteProperty(navigator, "geolocation");
});

describe("per-user storage after sign-out (review round 5)", () => {
  it("is not written again by the page once signOutAndForget has resolved", async () => {
    // Regression: the old page kept running until the next document loaded, and a late
    // write (chat answer, position fix) put the previous user's data back for that page.
    await signOutAndForget("/");
    expect(isSigningOut()).toBe(true);

    rememberLastFix({ lat: 19.076, lon: 72.8777, accuracy: 30 });
    storeSosName("Alice Upvoter", "u-alice");
    writeUserData("session", CHAT_HISTORY_STORAGE_KEY, '[{"content":"PRIVATE"}]');

    expect(window.localStorage.getItem(LAST_FIX_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(SOS_NAME_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(CHAT_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it("drops a fix that a position watch delivers after the sign-out", async () => {
    const deliverFix = installWatchableGeolocation();
    const { result } = renderHook(() => useGeolocation({ watch: true }));
    act(() => deliverFix(28.6139, 77.209));
    expect(readLastFix()).toMatchObject({ lat: 28.6139, lon: 77.209 });

    await act(() => signOutAndForget("/"));
    expect(window.localStorage.getItem(LAST_FIX_STORAGE_KEY)).toBeNull();

    act(() => deliverFix(19.076, 72.8777)); // the device moved before the next page loaded
    expect(result.current.coords).toMatchObject({ lat: 19.076, lon: 72.8777 });
    expect(window.localStorage.getItem(LAST_FIX_STORAGE_KEY)).toBeNull();
  });

  it("stores again when the sign-out request fails (the user is still signed in)", async () => {
    auth.signOut.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(signOutAndForget("/")).rejects.toThrow("Failed to fetch");
    expect(isSigningOut()).toBe(false);

    rememberLastFix({ lat: 19.076, lon: 72.8777, accuracy: 30 });
    storeSosName("Alice Upvoter", "u-alice");
    expect(readLastFix()).toMatchObject({ lat: 19.076 });
    expect(readSosName("u-alice")).toBe("Alice Upvoter");
  });

  it("still removes entries while signing out, and never throws", () => {
    storeSosName("Alice Upvoter", "u-alice");
    setSigningOut(true);
    storeSosName("", "u-alice"); // an empty name forgets the stored one
    expect(window.localStorage.getItem(SOS_NAME_STORAGE_KEY)).toBeNull();

    setSigningOut(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => writeUserData("local", SOS_NAME_STORAGE_KEY, "x")).not.toThrow();
  });
});
