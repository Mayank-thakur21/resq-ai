/**
 * Client hooks shared by the map and incident pages.
 *
 * Only import from client components ("use client" modules).
 */

import { useEffect, useState } from "react";

import {
  offlineFallbackFix,
  resolveCoords,
  useGeolocation,
  type GeolocationState,
  type ResolvedCoords,
  type UseGeolocationOptions,
} from "@/lib/geo";

export interface SearchLocation {
  /** Raw geolocation state (status, error, retry). */
  geo: GeolocationState;
  /**
   * Device fix when available; offline without one, the last known fix
   * (`isLastKnown: true`); else `DEFAULT_COORDS` (`isDefault: true`).
   */
  coords: ResolvedCoords;
  /**
   * True once it is worth querying: we have a fix, geolocation failed, or the grace period
   * elapsed (browsers keep "locating" forever while a permission prompt is ignored).
   */
  settled: boolean;
}

/** How long pages wait for a first fix before querying around the default location. */
export const LOCATION_GRACE_MS = 6_000;

/**
 * `true` once `ms` have passed since mount. Browsers keep geolocation "locating" for as long
 * as a permission prompt is ignored (the API timeout does not run during the prompt), so
 * anything waiting for a fix needs this upper bound.
 */
export function useGraceElapsed(ms: number = LOCATION_GRACE_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setElapsed(true), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  return elapsed;
}

/**
 * Device location for "near me" queries, with a bounded wait so pages never hang on an
 * unanswered permission prompt.
 */
export function useSearchLocation(
  options: UseGeolocationOptions & { graceMs?: number } = {},
): SearchLocation {
  const { graceMs = LOCATION_GRACE_MS, ...geoOptions } = options;
  const geo = useGeolocation(geoOptions);
  const graceOver = useGraceElapsed(graceMs);

  const pending = geo.status === "idle" || geo.status === "locating";
  const settled = !!geo.coords || !pending || graceOver;
  // Offline and no fix: query around the last known position, whose data the service
  // worker saved, rather than the default location (whose data it does not have).
  return { geo, coords: resolveCoords(geo, offlineFallbackFix(geo, graceOver)), settled };
}

/**
 * Current time that re-renders the component every `intervalMs` (for "5 minutes ago"
 * labels). Starts at `Date.now()` on the client.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
