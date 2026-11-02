/**
 * Geolocation utilities.
 *
 * Deliberately NOT a "use client" module: server components may import the pure helpers
 * (`DEFAULT_COORDS`, `haversineKm`, `formatDistance`, `mapsLink`); only client components
 * may call the `useGeolocation` hook.
 *
 * `useGeolocation` wraps the browser Geolocation API in a small state machine:
 *
 *   idle ──(mount / retry)──> locating ──> ready
 *                                     ├──> denied       (user/OS refused permission)
 *                                     ├──> unavailable  (no API, insecure context, no fix)
 *                                     └──> error        (timeout / unknown failure)
 *
 * It never calls `alert()`: pages render the status inline and typically fall back to
 * {@link DEFAULT_COORDS} with a visible "Using default location" notice (see
 * {@link resolveCoords}).
 *
 * Offline: every successful fix is remembered on the device ({@link LAST_FIX_STORAGE_KEY}).
 * When geolocation then fails while the browser is offline (desktop browsers locate through
 * a network service), pages use that last known fix instead of the default location (see
 * {@link offlineFallbackFix}), so their queries find the data the service worker saved for
 * the user's area.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface Coordinates {
  lat: number;
  lon: number;
  /** Accuracy radius in metres (null when unknown, e.g. for the default location). */
  accuracy: number | null;
}

export type GeolocationStatus = "idle" | "locating" | "ready" | "denied" | "unavailable" | "error";

export interface UseGeolocationOptions {
  /** Ask for GPS-level accuracy (slower, more battery). Default `false`. */
  enableHighAccuracy?: boolean;
  /** Give up after this many milliseconds. Default 10 s. */
  timeoutMs?: number;
  /** Accept a cached position up to this old. Default 60 s. */
  maximumAgeMs?: number;
  /** Keep tracking the position (`watchPosition`) instead of a single fix. Default `false`. */
  watch?: boolean;
  /** Start locating on mount. When `false`, call `retry()` to start. Default `true`. */
  auto?: boolean;
}

export interface GeolocationState {
  status: GeolocationStatus;
  coords?: Coordinates;
  /** Human-readable reason for `denied` / `unavailable` / `error`. */
  error?: string;
  /** When the current fix was taken (ms since epoch). */
  timestamp?: number;
  /** (Re)request the position, e.g. from a "Try again" button. */
  retry: () => void;
}

function parseCoordinate(value: string | undefined, fallback: number, limit: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : fallback;
}

/**
 * Fallback map centre used when the user's location is unknown. Configurable at build time
 * with `NEXT_PUBLIC_DEFAULT_LAT` / `NEXT_PUBLIC_DEFAULT_LON` (default: New Delhi).
 */
export const DEFAULT_COORDS: Readonly<Coordinates> = Object.freeze({
  lat: parseCoordinate(process.env.NEXT_PUBLIC_DEFAULT_LAT, 28.6139, 90),
  lon: parseCoordinate(process.env.NEXT_PUBLIC_DEFAULT_LON, 77.209, 180),
  accuracy: null,
});

/** localStorage key of the last successful fix (`{lat, lon, accuracy, at}`, device-local). */
export const LAST_FIX_STORAGE_KEY = "resq_last_fix";
/** A remembered fix older than this is ignored. */
export const LAST_FIX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface LastKnownFix extends Coordinates {
  /** When the fix was taken (ms since epoch). */
  at: number;
}

/** Remembers a fix for offline use. Storage errors (private mode, quota) are ignored. */
export function rememberLastFix(coords: Coordinates, at: number = Date.now()): void {
  try {
    window.localStorage.setItem(
      LAST_FIX_STORAGE_KEY,
      JSON.stringify({ lat: coords.lat, lon: coords.lon, accuracy: coords.accuracy, at }),
    );
  } catch {
    // Not fatal: offline pages fall back to the default location instead.
  }
}

/** The remembered fix, or `null` when missing, malformed or older than `maxAgeMs`. */
export function readLastFix(now: number = Date.now(), maxAgeMs: number = LAST_FIX_MAX_AGE_MS): LastKnownFix | null {
  let raw: string | null = null;
  try {
    raw = typeof window === "undefined" ? null : window.localStorage.getItem(LAST_FIX_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { lat, lon, accuracy, at } = value as Record<string, unknown>;
    if (typeof lat !== "number" || typeof lon !== "number" || typeof at !== "number") return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (!Number.isFinite(at) || now - at > maxAgeMs || at - now > 60_000) return null;
    return {
      lat,
      lon,
      accuracy: typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
      at,
    };
  } catch {
    return null;
  }
}

/** `true` when the browser reports no network connection. */
export function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * The last known fix to query with instead of {@link DEFAULT_COORDS}: only while offline,
 * only when there is no current fix and geolocation could not get one (unavailable / error,
 * or `waitedEnough`), never after the user *denied* location access.
 */
export function offlineFallbackFix(
  state: Pick<GeolocationState, "status" | "coords">,
  waitedEnough = false,
): LastKnownFix | null {
  if (state.coords || state.status === "denied") return null;
  const failed = state.status === "unavailable" || state.status === "error";
  if (!failed && !waitedEnough) return null;
  if (!isBrowserOffline()) return null;
  return readLastFix();
}

// Numeric codes from the GeolocationPositionError interface (constants are not available
// on the server / in every test environment).
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

type Outcome = Omit<GeolocationState, "retry">;

export function describePositionError(error: { code: number; message?: string }): Outcome {
  switch (error.code) {
    case PERMISSION_DENIED:
      return {
        status: "denied",
        error: "Location permission was denied. Enable it in your browser settings for local results.",
      };
    case POSITION_UNAVAILABLE:
      return {
        status: "unavailable",
        error: "Your location is currently unavailable. Check that location services are on.",
      };
    case TIMEOUT:
      return { status: "error", error: "Finding your location took too long. Please try again." };
    default:
      return { status: "error", error: error.message || "Could not determine your location." };
  }
}

function isGeolocationSupported(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator && !!navigator.geolocation;
}

/**
 * React hook exposing the device location. SSR-safe: the first render is always `idle`
 * (identical on server and client), locating starts in an effect after mount.
 */
export function useGeolocation(options: UseGeolocationOptions = {}): GeolocationState {
  const {
    enableHighAccuracy = false,
    timeoutMs = 10_000,
    maximumAgeMs = 60_000,
    watch = false,
    auto = true,
  } = options;

  const [state, setState] = useState<Outcome>({ status: "idle" });
  // Incrementing `attempt` re-runs the effect; 0 means "not started" when auto is false.
  const [attempt, setAttempt] = useState(auto ? 1 : 0);
  const lastCoords = useRef<Coordinates | undefined>(undefined);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (attempt === 0) return;

    if (!isGeolocationSupported()) {
      setState({ status: "unavailable", error: "This device or browser does not support location." });
      return;
    }

    let cancelled = false;
    // Keep showing the previous fix while re-locating, so maps do not jump back to default.
    setState((prev) => ({ status: "locating", coords: prev.coords ?? lastCoords.current }));

    const onSuccess = (position: GeolocationPosition) => {
      if (cancelled) return;
      const coords: Coordinates = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
      };
      lastCoords.current = coords;
      rememberLastFix(coords, Number.isFinite(position.timestamp) ? position.timestamp : Date.now());
      setState({ status: "ready", coords, timestamp: position.timestamp });
    };

    const onError = (error: GeolocationPositionError) => {
      if (cancelled) return;
      // While watching, a transient error after a good fix keeps the last known position.
      setState((prev) => ({ ...describePositionError(error), coords: prev.coords }));
    };

    const positionOptions: PositionOptions = {
      enableHighAccuracy,
      timeout: timeoutMs,
      maximumAge: maximumAgeMs,
    };

    let watchId: number | null = null;
    try {
      if (watch) {
        watchId = navigator.geolocation.watchPosition(onSuccess, onError, positionOptions);
      } else {
        navigator.geolocation.getCurrentPosition(onSuccess, onError, positionOptions);
      }
    } catch (error) {
      // Some embedded browsers throw synchronously (e.g. blocked by a permissions policy).
      setState({
        status: "unavailable",
        error: error instanceof Error ? error.message : "Location is not available here.",
      });
    }

    return () => {
      cancelled = true;
      // Guard: the Geolocation API can disappear before unmount (tests removing a mock,
      // privacy extensions); cleanup must never throw.
      if (watchId !== null) navigator.geolocation?.clearWatch?.(watchId);
    };
  }, [attempt, enableHighAccuracy, timeoutMs, maximumAgeMs, watch]);

  return { ...state, retry };
}

export interface ResolvedCoords {
  lat: number;
  lon: number;
  accuracy: number | null;
  /** True when we fell back to {@link DEFAULT_COORDS} (show the "default location" notice). */
  isDefault: boolean;
  /** True when the remembered last fix is used (offline, see {@link offlineFallbackFix}). */
  isLastKnown?: boolean;
}

/**
 * The coordinates a page should query with: the device fix if any, else `lastKnown` (the
 * offline fallback, see {@link offlineFallbackFix}), else the default.
 */
export function resolveCoords(
  state: Pick<GeolocationState, "coords">,
  lastKnown: LastKnownFix | null = null,
): ResolvedCoords {
  if (state.coords) return { ...state.coords, isDefault: false };
  if (lastKnown) {
    return { lat: lastKnown.lat, lon: lastKnown.lon, accuracy: lastKnown.accuracy, isDefault: false, isLastKnown: true };
  }
  return { ...DEFAULT_COORDS, isDefault: true };
}

/** Great-circle distance between two points in kilometres (haversine formula). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371.0088;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "1.2 km" / "350 m" formatting for distances. */
export function formatDistance(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return "";
  if (km < 1) return `${Math.max(1, Math.round(km * 1000))} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Google Maps link for a coordinate pair (same format the backend uses for SOS). */
export function mapsLink(lat: number, lon: number): string {
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
}
