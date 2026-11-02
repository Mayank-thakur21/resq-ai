"use client";

import { BellRing, Check, FilterX, Globe, LocateFixed, RefreshCw, Siren } from "lucide-react";
import * as React from "react";
import useSWR from "swr";

import { DisasterEventCard } from "@/app/alerts/_components/DisasterEventCard";
import { ALERT_LEVEL_RANK, disasterEventIcon } from "@/components/AlertBanner";
import { RelativeTime } from "@/components/DisasterFeed";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LOCATION_GRACE_MS, useGraceElapsed } from "@/components/map/hooks";
import { OfflineDataNotice } from "@/components/OfflineDataNotice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage, isApiError, swrKeys } from "@/lib/api";
import { pluralize } from "@/lib/format";
import { DEFAULT_COORDS, haversineKm, type GeolocationState } from "@/lib/geo";
import {
  type AlertLevel,
  DISASTER_EVENT_TYPE_LABELS,
  type DisasterEventsQuery,
  type DisasterEventsResponse,
  type DisasterEventType,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * "Disasters" tab of `/alerts`: GDACS events with type filter chips, a minimum alert level
 * and an optional "near me" radius.
 *
 * - "Anywhere" queries without a location (backend order: level, then most recent); if the
 *   device location is known, distances are computed client-side for display.
 * - A radius sends `lat/lon/radius_km` (backend order: level, then distance). Until the
 *   location settles — at most `LOCATION_GRACE_MS` (6 s), because browsers keep
 *   geolocation pending while the permission prompt is ignored — nothing is fetched; after
 *   that the default location is used with a visible notice, and the list re-queries as
 *   soon as a real fix arrives.
 * - Saved copies served by the service worker while offline are labelled as such.
 * - `focusEventId` (from a push notification link, `/alerts?event=<id>`) pins that event to
 *   the top of the list, highlights it, scrolls to it and moves focus to it once. When the
 *   event is not in the results, a notice explains why (filters, or no longer in the feed).
 */

const EVENTS_REFRESH_MS = 10 * 60_000;
const EVENTS_LIMIT = 100;

export const EVENT_TYPES: readonly DisasterEventType[] = ["EQ", "TC", "FL", "VO", "DR", "WF"];

const LEVEL_OPTIONS: readonly { value: AlertLevel; label: string }[] = [
  { value: "green", label: "All levels" },
  { value: "orange", label: "Orange & red" },
  { value: "red", label: "Red only" },
];

export type RadiusOption = "any" | number;
export const RADIUS_OPTIONS_KM: readonly number[] = [100, 250, 500, 1000, 2500];

function isSettled(status: GeolocationState["status"]): boolean {
  return status !== "idle" && status !== "locating";
}

export interface DisasterEventsPanelProps {
  /** Shared geolocation state from the page (one permission prompt per page). */
  geo: GeolocationState;
  /** GDACS event id to highlight (e.g. "EQ-1234567"), from `/alerts?event=`. */
  focusEventId?: string | null;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

export function DisasterEventsPanel({ geo, focusEventId = null }: DisasterEventsPanelProps) {
  const [types, setTypes] = React.useState<DisasterEventType[]>([]);
  const [minLevel, setMinLevel] = React.useState<AlertLevel>("green");
  const [radius, setRadius] = React.useState<RadiusOption>("any");
  const typesId = React.useId();
  const levelId = React.useId();
  const radiusId = React.useId();

  const near = radius !== "any";
  const graceOver = useGraceElapsed(LOCATION_GRACE_MS);
  const settled = isSettled(geo.status) || graceOver;
  const deviceCoords = geo.coords ? { lat: geo.coords.lat, lon: geo.coords.lon } : null;
  const nearCoords = deviceCoords ?? (settled ? { lat: DEFAULT_COORDS.lat, lon: DEFAULT_COORDS.lon } : null);
  const usingDefault = near && !deviceCoords && settled;
  const waitingForLocation = near && !nearCoords;

  const query: DisasterEventsQuery = {
    min_level: minLevel,
    limit: EVENTS_LIMIT,
    types: types.length ? types : undefined,
    ...(near && nearCoords ? { lat: nearCoords.lat, lon: nearCoords.lon, radius_km: radius } : {}),
  };
  const key = waitingForLocation ? null : swrKeys.disasters(query);
  const { data, error, isLoading, isValidating, mutate } = useSWR<DisasterEventsResponse>(key, {
    refreshInterval: EVENTS_REFRESH_MS,
  });
  const retry = React.useCallback(() => {
    void mutate();
  }, [mutate]);

  const fetchedEvents = React.useMemo(() => data?.events ?? [], [data]);
  const focusedEvent = focusEventId ? fetchedEvents.find((item) => item.id === focusEventId) ?? null : null;
  // The linked event goes first so it is visible without scrolling through the list.
  const events = React.useMemo(
    () => (focusedEvent ? [focusedEvent, ...fetchedEvents.filter((item) => item !== focusedEvent)] : fetchedEvents),
    [fetchedEvents, focusedEvent],
  );
  const focusRef = React.useRef<HTMLLIElement | null>(null);
  const focusedOnceRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!focusedEvent || focusedOnceRef.current === focusedEvent.id) return;
    const node = focusRef.current;
    if (!node) return;
    focusedOnceRef.current = focusedEvent.id;
    try {
      node.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      node.focus({ preventScroll: true });
    } catch {
      // Scrolling is a convenience; the highlighted card is first in the list anyway.
    }
  }, [focusedEvent]);
  const focusMissing = Boolean(focusEventId) && Boolean(data) && !focusedEvent;
  const counts = React.useMemo(() => {
    const result: Record<AlertLevel, number> = { red: 0, orange: 0, green: 0 };
    for (const event of events) result[event.alert_level] = (result[event.alert_level] ?? 0) + 1;
    return result;
  }, [events]);

  const filtersActive = types.length > 0 || minLevel !== "green" || near;

  const toggleType = (type: DisasterEventType) =>
    setTypes((current) =>
      current.includes(type)
        ? current.filter((t) => t !== type)
        : EVENT_TYPES.filter((t) => t === type || current.includes(t)),
    );
  const clearFilters = () => {
    setTypes([]);
    setMinLevel("green");
    setRadius("any");
  };

  // ---- results ------------------------------------------------------------------------
  let results: React.ReactNode;
  if (waitingForLocation || (!data && !error)) {
    results = <EventsSkeleton label={waitingForLocation ? "Finding your location…" : "Loading disaster events…"} />;
  } else if (!data) {
    results = (
      <ErrorState
        title="Disaster events are unavailable"
        message={getErrorMessage(error, "We couldn't load the GDACS disaster feed.")}
        offline={isApiError(error) && error.isNetworkError}
        onRetry={retry}
      />
    );
  } else if (events.length === 0) {
    results = (
      <EmptyState
        icon={<Siren />}
        title={filtersActive ? "No events match these filters" : "No active disaster events"}
        message={
          near
            ? `Nothing ${minLevel === "green" ? "" : `at ${minLevel} level or above `}within ${radius} km. Try a wider area.`
            : filtersActive
              ? "Try including more event types or lowering the minimum alert level."
              : "GDACS isn't reporting any current events right now."
        }
        action={
          filtersActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-1.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            >
              <FilterX aria-hidden="true" className="size-4" /> Clear filters
            </button>
          ) : undefined
        }
      />
    );
  } else {
    results = (
      <ul className={cn("grid gap-3 transition-opacity", isLoading && "opacity-60")} aria-busy={isValidating}>
        {events.map((event) => (
          <li
            key={event.id}
            ref={event === focusedEvent ? focusRef : undefined}
            tabIndex={event === focusedEvent ? -1 : undefined}
            className="scroll-mt-24 rounded-2xl focus-visible:outline-none"
          >
            <ErrorBoundary compact title="This event couldn't be displayed">
              <DisasterEventCard
                event={event}
                highlighted={event === focusedEvent}
                distanceKm={
                  event.distance_km ?? (deviceCoords ? haversineKm(deviceCoords, { lat: event.lat, lon: event.lon }) : null)
                }
              />
            </ErrorBoundary>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="space-y-4 rounded-2xl border border-slate-700 bg-slate-800/40 p-4 backdrop-blur-md">
        <div role="group" aria-labelledby={typesId}>
          <p id={typesId} className="mb-2 text-sm font-medium text-slate-200">
            Event types
          </p>
          <div className="flex flex-wrap gap-2">
            <FilterChip pressed={types.length === 0} onClick={() => setTypes([])} label="All types" />
            {EVENT_TYPES.map((type) => {
              const Icon = disasterEventIcon(type);
              return (
                <FilterChip
                  key={type}
                  pressed={types.includes(type)}
                  onClick={() => toggleType(type)}
                  label={DISASTER_EVENT_TYPE_LABELS[type]}
                  icon={<Icon aria-hidden="true" className="size-3.5" />}
                />
              );
            })}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={levelId}>Minimum alert level</Label>
            <Select id={levelId} value={minLevel} onChange={(event) => setMinLevel(event.target.value as AlertLevel)}>
              {LEVEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={radiusId}>Near me</Label>
            <Select
              id={radiusId}
              value={String(radius)}
              onChange={(event) =>
                setRadius(event.target.value === "any" ? "any" : Number(event.target.value))
              }
            >
              <option value="any">Anywhere in the world</option>
              {RADIUS_OPTIONS_KM.map((km) => (
                <option key={km} value={km}>
                  Within {km.toLocaleString()} km
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {usingDefault && (
        <Alert variant="info" icon={<LocateFixed />}>
          <AlertTitle>Using default location — enable location for local results</AlertTitle>
          <AlertDescription>
            {geo.error ? `${geo.error} ` : ""}
            <button
              type="button"
              onClick={geo.retry}
              className="font-semibold text-blue-200 underline underline-offset-2 hover:text-white"
            >
              Try again
            </button>
          </AlertDescription>
        </Alert>
      )}

      <OfflineDataNotice data={data} />

      {focusMissing && (
        <Alert variant="info" icon={<BellRing />}>
          <AlertTitle>
            {filtersActive
              ? "The alert from your notification is hidden by your filters"
              : "The alert from your notification is no longer in the GDACS feed"}
          </AlertTitle>
          <AlertDescription>
            {filtersActive ? (
              <button
                type="button"
                onClick={clearFilters}
                className="font-semibold text-blue-200 underline underline-offset-2 hover:text-white"
              >
                Clear filters
              </button>
            ) : (
              "It may have ended or been downgraded. Current events are listed below."
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Summary */}
      {data && events.length > 0 && (
        <div className="flex items-start justify-between gap-2 text-xs text-slate-400">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" aria-live="polite">
            <span className="font-medium text-slate-200">{pluralize(events.length, "event")}</span>
            {(["red", "orange", "green"] as const)
              .filter((level) => counts[level] > 0 && ALERT_LEVEL_RANK[level] >= ALERT_LEVEL_RANK[minLevel])
              .map((level) => (
                <span key={level} className="flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-block size-2 rounded-full",
                      level === "red" ? "bg-red-500" : level === "orange" ? "bg-orange-500" : "bg-emerald-500",
                    )}
                  />
                  {counts[level]} {level}
                </span>
              ))}
            <span className="flex items-center gap-1">
              {near ? <LocateFixed aria-hidden="true" className="size-3" /> : <Globe aria-hidden="true" className="size-3" />}
              {near ? `within ${radius} km` : "worldwide"}
            </span>
            <RelativeTime value={data.updated_at} prefix="· Updated" />
          </p>
          <button
            type="button"
            onClick={retry}
            disabled={isValidating}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 font-semibold text-slate-300 transition-colors hover:bg-slate-700/50 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none disabled:opacity-60"
          >
            <RefreshCw aria-hidden="true" className={cn("size-3.5", isValidating && "animate-spin motion-reduce:animate-none")} />
            Refresh
          </button>
        </div>
      )}
      {error && data && (
        <p role="status" className="text-xs text-amber-300">
          Couldn&apos;t refresh the feed — showing the last results.
        </p>
      )}

      {results}
    </div>
  );
}

export default DisasterEventsPanel;

function FilterChip({
  pressed,
  onClick,
  label,
  icon,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none",
        pressed
          ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
          : "border-slate-600 bg-slate-900/40 text-slate-300 hover:border-slate-500 hover:text-white",
      )}
    >
      {pressed ? <Check aria-hidden="true" className="size-3.5" /> : icon}
      {label}
    </button>
  );
}

function EventsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="grid gap-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="space-y-3 rounded-2xl border border-slate-700 bg-slate-800/40 p-5">
          <div className="flex items-start gap-3">
            <Skeleton className="size-10 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
          <Skeleton className="h-4 w-full" />
          <div className="grid grid-cols-4 gap-3">
            {Array.from({ length: 4 }, (__, cell) => (
              <Skeleton key={cell} className="h-8" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
