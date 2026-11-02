import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COORDS,
  formatDistance,
  haversineKm,
  LAST_FIX_STORAGE_KEY,
  mapsLink,
  offlineFallbackFix,
  readLastFix,
  rememberLastFix,
  resolveCoords,
  useGeolocation,
} from "@/lib/geo";

type SuccessCb = (position: GeolocationPosition) => void;
type ErrorCb = (error: GeolocationPositionError) => void;

/** Installs a controllable fake `navigator.geolocation`. */
function installGeolocation() {
  const pending: { success: SuccessCb; error: ErrorCb }[] = [];
  const geolocation = {
    getCurrentPosition: vi.fn((success: SuccessCb, error: ErrorCb) => {
      pending.push({ success, error });
    }),
    watchPosition: vi.fn((success: SuccessCb, error: ErrorCb) => {
      pending.push({ success, error });
      return 7;
    }),
    clearWatch: vi.fn(),
  };
  Object.defineProperty(navigator, "geolocation", { value: geolocation, configurable: true });
  return {
    geolocation,
    succeed(lat: number, lon: number, accuracy = 25) {
      const cb = pending.shift();
      cb?.success({
        coords: { latitude: lat, longitude: lon, accuracy } as GeolocationCoordinates,
        timestamp: 1_700_000_000_000,
      } as GeolocationPosition);
    },
    fail(code: number, message = "") {
      const cb = pending.shift();
      cb?.error({ code, message } as GeolocationPositionError);
    },
  };
}

afterEach(() => {
  // Remove the fake so every test starts from a clean navigator.
  delete (navigator as { geolocation?: unknown }).geolocation;
});

describe("useGeolocation", () => {
  it("starts idle-then-locating and resolves to ready with coords", () => {
    const geo = installGeolocation();
    const { result } = renderHook(() => useGeolocation({ enableHighAccuracy: true, timeoutMs: 5000 }));

    expect(result.current.status).toBe("locating");
    expect(geo.geolocation.getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true, timeout: 5000 }),
    );

    act(() => geo.succeed(19.076, 72.8777, 12));
    expect(result.current.status).toBe("ready");
    expect(result.current.coords).toEqual({ lat: 19.076, lon: 72.8777, accuracy: 12 });
    expect(result.current.timestamp).toBe(1_700_000_000_000);
  });

  it("reports denied permission without alert() and can retry", () => {
    const geo = installGeolocation();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const { result } = renderHook(() => useGeolocation());

    act(() => geo.fail(1, "User denied Geolocation"));
    expect(result.current.status).toBe("denied");
    expect(result.current.error).toMatch(/denied/i);
    expect(alertSpy).not.toHaveBeenCalled();

    act(() => result.current.retry());
    expect(result.current.status).toBe("locating");
    expect(geo.geolocation.getCurrentPosition).toHaveBeenCalledTimes(2);
    act(() => geo.succeed(1, 2));
    expect(result.current.status).toBe("ready");
  });

  it("maps POSITION_UNAVAILABLE and TIMEOUT", () => {
    const geo = installGeolocation();
    const { result } = renderHook(() => useGeolocation());
    act(() => geo.fail(2));
    expect(result.current.status).toBe("unavailable");

    act(() => result.current.retry());
    act(() => geo.fail(3));
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/too long/i);
  });

  it("is unavailable when the browser has no geolocation API", () => {
    const { result } = renderHook(() => useGeolocation());
    expect(result.current.status).toBe("unavailable");
  });

  it("does nothing until retry() when auto is false", () => {
    const geo = installGeolocation();
    const { result } = renderHook(() => useGeolocation({ auto: false }));
    expect(result.current.status).toBe("idle");
    expect(geo.geolocation.getCurrentPosition).not.toHaveBeenCalled();
    act(() => result.current.retry());
    expect(result.current.status).toBe("locating");
  });

  it("watches the position and clears the watch on unmount", () => {
    const geo = installGeolocation();
    const { result, unmount } = renderHook(() => useGeolocation({ watch: true }));
    act(() => geo.succeed(10, 20));
    expect(result.current.coords?.lat).toBe(10);
    unmount();
    expect(geo.geolocation.clearWatch).toHaveBeenCalledWith(7);
  });

  it("does not throw on unmount when the Geolocation API has disappeared", () => {
    installGeolocation();
    const { unmount } = renderHook(() => useGeolocation({ watch: true }));
    delete (navigator as { geolocation?: unknown }).geolocation;
    expect(() => unmount()).not.toThrow();
  });
});

describe("geo helpers", () => {
  it("falls back to DEFAULT_COORDS (New Delhi by default)", () => {
    expect(DEFAULT_COORDS).toMatchObject({ lat: 28.6139, lon: 77.209 });
    expect(resolveCoords({})).toMatchObject({ lat: 28.6139, lon: 77.209, isDefault: true });
    expect(resolveCoords({ coords: { lat: 1, lon: 2, accuracy: 5 } })).toEqual({
      lat: 1,
      lon: 2,
      accuracy: 5,
      isDefault: false,
    });
  });

  it("computes haversine distances", () => {
    const delhi = { lat: 28.6139, lon: 77.209 };
    const mumbai = { lat: 19.076, lon: 72.8777 };
    expect(haversineKm(delhi, mumbai)).toBeGreaterThan(1140);
    expect(haversineKm(delhi, mumbai)).toBeLessThan(1160);
    expect(haversineKm(delhi, delhi)).toBe(0);
  });

  it("formats distances and maps links", () => {
    expect(formatDistance(0.35)).toBe("350 m");
    expect(formatDistance(2.345)).toBe("2.3 km");
    expect(formatDistance(42.6)).toBe("43 km");
    expect(formatDistance(null)).toBe("");
    expect(mapsLink(28.6139, 77.209)).toBe("https://maps.google.com/?q=28.613900,77.209000");
  });
});

describe("last known fix (offline fallback)", () => {
  function setOnline(online: boolean) {
    Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
  }

  afterEach(() => {
    delete (navigator as { onLine?: boolean }).onLine;
    window.localStorage.clear();
  });

  it("remembers every successful fix on the device", () => {
    const geo = installGeolocation();
    renderHook(() => useGeolocation());
    act(() => geo.succeed(19.076, 72.8777, 12));
    const stored = JSON.parse(window.localStorage.getItem(LAST_FIX_STORAGE_KEY) ?? "null");
    expect(stored).toEqual({ lat: 19.076, lon: 72.8777, accuracy: 12, at: 1_700_000_000_000 });
    expect(readLastFix(1_700_000_000_000 + 60_000)).toEqual(stored);
  });

  it("ignores old, future or malformed entries", () => {
    const now = Date.now();
    rememberLastFix({ lat: 1, lon: 2, accuracy: null }, now - 40 * 86_400_000);
    expect(readLastFix(now)).toBeNull();
    rememberLastFix({ lat: 1, lon: 2, accuracy: null }, now + 3_600_000);
    expect(readLastFix(now)).toBeNull();
    for (const raw of ["not json", "null", '{"lat":"1","lon":2,"at":1}', `{"lat":95,"lon":2,"at":${now}}`]) {
      window.localStorage.setItem(LAST_FIX_STORAGE_KEY, raw);
      expect(readLastFix(now)).toBeNull();
    }
  });

  it("is used instead of the default location only offline, after locating failed", () => {
    // Regression: offline, desktop geolocation fails and pages queried DEFAULT_COORDS, whose
    // data the service worker never saved, instead of the user's own area.
    rememberLastFix({ lat: 19.076, lon: 72.8777, accuracy: 30 });
    setOnline(false);
    const fix = offlineFallbackFix({ status: "unavailable" });
    expect(fix).toMatchObject({ lat: 19.076, lon: 72.8777, accuracy: 30 });
    expect(resolveCoords({}, fix)).toEqual({
      lat: 19.076,
      lon: 72.8777,
      accuracy: 30,
      isDefault: false,
      isLastKnown: true,
    });
    expect(offlineFallbackFix({ status: "error" })).not.toBeNull();
    // Still locating: only once the page stopped waiting.
    expect(offlineFallbackFix({ status: "locating" })).toBeNull();
    expect(offlineFallbackFix({ status: "locating" }, true)).not.toBeNull();
    // Never after the user denied location access, never with a current fix.
    expect(offlineFallbackFix({ status: "denied" }, true)).toBeNull();
    expect(offlineFallbackFix({ status: "ready", coords: { lat: 1, lon: 2, accuracy: 5 } })).toBeNull();

    setOnline(true);
    expect(offlineFallbackFix({ status: "unavailable" }, true)).toBeNull();
    expect(resolveCoords({}, null)).toEqual({ ...DEFAULT_COORDS, isDefault: true });
  });
});
