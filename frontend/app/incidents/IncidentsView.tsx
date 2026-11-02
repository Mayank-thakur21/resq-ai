"use client";

/**
 * Client view of `/incidents`: nearby community reports with filters.
 *
 * - Type, status and radius are sent to the backend; severity is filtered client-side
 *   (the API has no severity filter).
 * - `?focus=<id>` (push notifications link here) highlights that incident and scrolls to
 *   it; if it is outside the current filters it is fetched on its own and pinned on top.
 * - Upvotes update the SWR cache in place with the server's copy (no refetch storm).
 */

import { ListFilter, MapIcon, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import useSWR, { useSWRConfig } from "swr";

import { EmptyState } from "@/components/EmptyState";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorState } from "@/components/ErrorState";
import { IncidentCard } from "@/components/IncidentCard";
import { OfflineDataNotice } from "@/components/OfflineDataNotice";
import { useSearchLocation } from "@/components/map/hooks";
import {
  DEFAULT_INCIDENT_RADIUS_KM,
  DISASTER_TYPE_OPTIONS,
  INCIDENT_RADIUS_OPTIONS_KM,
  SEVERITY_OPTIONS,
  STATUS_FILTER_OPTIONS,
  filterIncidents,
  isDisasterType,
  isSeverity,
  isStatusFilter,
  replaceIncident,
  type StatusFilter,
} from "@/components/map/incident-meta";
import { mapHref, reportIncidentHref } from "@/components/map/layers";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage, isApiError, swrKeys } from "@/lib/api";
import { haversineKm } from "@/lib/geo";
import type { DisasterType, Incident, IncidentsResponse, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";

const LIST_REFRESH_MS = 60_000;
const LIST_LIMIT = 100;

export interface IncidentsViewProps {
  /** Incident to highlight (from `?focus=`), already sanitised. */
  focusId: string | null;
}

export function IncidentsView({ focusId }: IncidentsViewProps) {
  const { geo, coords, settled } = useSearchLocation();
  const { mutate: globalMutate } = useSWRConfig();

  const [type, setType] = React.useState<DisasterType | "all">("all");
  const [severity, setSeverity] = React.useState<Severity | "all">("all");
  const [status, setStatus] = React.useState<StatusFilter>("open");
  const [radiusKm, setRadiusKm] = React.useState<number>(DEFAULT_INCIDENT_RADIUS_KM);

  const listKey = settled
    ? swrKeys.incidents({
        lat: coords.lat,
        lon: coords.lon,
        radius_km: radiusKm,
        status,
        type: type === "all" ? undefined : type,
        limit: LIST_LIMIT,
      })
    : null;
  const list = useSWR<IncidentsResponse>(listKey, { refreshInterval: LIST_REFRESH_MS });

  const allIncidents = list.data?.incidents;
  const visible = React.useMemo(
    () => (allIncidents ? filterIncidents(allIncidents, { severity, type }) : undefined),
    [allIncidents, severity, type],
  );

  // The focused incident, fetched separately only when it is not in the current list.
  const focusInList = !!focusId && !!allIncidents?.some((incident) => incident.id === focusId);
  const needFocusFetch = !!focusId && !!list.data && !focusInList;
  const focused = useSWR<Incident>(needFocusFetch && focusId ? swrKeys.incident(focusId) : null);
  const pinned = needFocusFetch ? focused.data : undefined;
  const pinnedDistance = pinned && !coords.isDefault ? haversineKm(coords, pinned) : null;

  // Scroll the focused card into view once, when it first renders.
  const scrolledTo = React.useRef<string | null>(null);
  const focusRendered = focusInList || !!pinned;
  React.useEffect(() => {
    if (!focusId || !focusRendered || scrolledTo.current === focusId) return;
    const element = document.getElementById(`incident-${focusId}`);
    if (!element) return;
    scrolledTo.current = focusId;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
    element.focus({ preventScroll: true });
  }, [focusId, focusRendered]);

  const mutateList = list.mutate;
  const onIncidentChange = React.useCallback(
    (updated: Incident) => {
      void mutateList(
        (current) => (current ? { ...current, incidents: replaceIncident(current.incidents, updated) } : current),
        { revalidate: false },
      );
      void globalMutate(swrKeys.incident(updated.id), updated, { revalidate: false });
    },
    [mutateList, globalMutate],
  );

  const resetFilters = () => {
    setType("all");
    setSeverity("all");
    setStatus("open");
    setRadiusKm(DEFAULT_INCIDENT_RADIUS_KM);
  };
  const filtersActive =
    type !== "all" || severity !== "all" || status !== "open" || radiusKm !== DEFAULT_INCIDENT_RADIUS_KM;
  const largerRadius = INCIDENT_RADIUS_OPTIONS_KM.find((km) => km > radiusKm);

  let body: React.ReactNode;
  if (!list.data && !list.error) {
    body = <IncidentListSkeleton />;
  } else if (!list.data) {
    body = (
      <ErrorState
        title="Incidents are unavailable"
        message={getErrorMessage(list.error, "We couldn't load nearby incidents.")}
        offline={isApiError(list.error) && list.error.isNetworkError}
        onRetry={() => void list.mutate()}
      />
    );
  } else if (!visible || visible.length === 0) {
    body = (
      <EmptyState
        icon={<ShieldAlert />}
        title={filtersActive ? "No incidents match these filters" : `No open incidents within ${radiusKm} km`}
        message={
          filtersActive
            ? "Try another type or severity, or search a wider area."
            : "Nothing has been reported nearby. If you see an emergency, report it so others can stay safe."
        }
        action={
          <>
            {filtersActive && (
              <button
                type="button"
                onClick={resetFilters}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none"
              >
                Reset filters
              </button>
            )}
            {largerRadius && (
              <button
                type="button"
                onClick={() => setRadiusKm(largerRadius)}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none"
              >
                Search {largerRadius} km
              </button>
            )}
            <Link
              href={coords.isDefault ? "/incidents/new" : reportIncidentHref(coords)}
              className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none"
            >
              Report an incident
            </Link>
          </>
        }
      />
    );
  } else {
    body = (
      <ul className={cn("grid gap-4 md:grid-cols-2", list.isLoading && "opacity-60 transition-opacity")} aria-busy={list.isValidating}>
        {visible.map((incident) => (
          <li key={incident.id} className="flex">
            <ErrorBoundary compact title="This report couldn't be displayed">
              <IncidentCard
                incident={incident}
                onChange={onIncidentChange}
                highlighted={incident.id === focusId}
                className="w-full"
              />
            </ErrorBoundary>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] lg:min-h-[calc(100dvh-4rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black text-white">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:py-12">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-amber-300 via-orange-300 to-red-400 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent md:text-4xl">
              Community Incidents
            </h1>
            <p className="mt-2 max-w-2xl text-slate-300">
              Live reports from people near you. Confirm what you can see to help others know it&apos;s real.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={mapHref(coords)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-600 px-4 text-sm font-semibold text-slate-100 transition-colors hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none"
            >
              <MapIcon aria-hidden="true" className="size-4" />
              View map
            </Link>
            <Link
              href={coords.isDefault ? "/incidents/new" : reportIncidentHref(coords)}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white shadow-lg shadow-red-900/30 transition-colors hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none"
            >
              <Plus aria-hidden="true" className="size-4" />
              Report incident
            </Link>
          </div>
        </div>

        {settled && coords.isDefault && (
          <Alert variant="warning" role="status" className="mb-4">
            <AlertDescription>
              Using default location — enable location for local results.{" "}
              <button type="button" onClick={geo.retry} className="font-semibold text-white underline underline-offset-2">
                Try again
              </button>
            </AlertDescription>
          </Alert>
        )}

        {coords.isLastKnown && (
          <p role="status" className="mb-2 text-xs text-amber-200/90">
            You&apos;re offline — using your last known location.
          </p>
        )}
        <OfflineDataNotice data={list.data} className="mb-4" />

        <section
          aria-labelledby="incident-filters-title"
          className="mb-6 rounded-2xl border border-slate-700/80 bg-slate-900/60 p-4 backdrop-blur-md"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id="incident-filters-title" className="flex items-center gap-2 text-sm font-semibold tracking-wide text-slate-200 uppercase">
              <ListFilter aria-hidden="true" className="size-4 text-amber-300" />
              Filters
            </h2>
            {filtersActive && (
              <button
                type="button"
                onClick={resetFilters}
                className="rounded-md px-2 py-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200 hover:underline focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              >
                Reset
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="filter-type">Type</Label>
              <Select
                id="filter-type"
                value={type}
                onChange={(event) => setType(isDisasterType(event.target.value) ? event.target.value : "all")}
              >
                <option value="all">All types</option>
                {DISASTER_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-severity">Severity</Label>
              <Select
                id="filter-severity"
                value={severity}
                onChange={(event) => setSeverity(isSeverity(event.target.value) ? event.target.value : "all")}
              >
                <option value="all">All severities</option>
                {SEVERITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-status">Status</Label>
              <Select
                id="filter-status"
                value={status}
                onChange={(event) => setStatus(isStatusFilter(event.target.value) ? event.target.value : "open")}
              >
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-radius">Radius</Label>
              <Select
                id="filter-radius"
                value={String(radiusKm)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setRadiusKm(Number.isFinite(next) && next > 0 ? next : DEFAULT_INCIDENT_RADIUS_KM);
                }}
              >
                {INCIDENT_RADIUS_OPTIONS_KM.map((km) => (
                  <option key={km} value={km}>
                    Within {km} km
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </section>

        {list.data && visible && visible.length > 0 && (
          <div className="mb-3 flex items-center justify-between gap-2 text-sm text-slate-400">
            <p aria-live="polite">
              {visible.length} {visible.length === 1 ? "incident" : "incidents"} within {radiusKm} km
              {coords.isDefault ? " of the default location" : ""}
            </p>
            <button
              type="button"
              onClick={() => void list.mutate()}
              disabled={list.isValidating}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none disabled:opacity-60"
            >
              {list.isValidating ? (
                <Spinner size="sm" label="Refreshing incidents" className="text-slate-300" />
              ) : (
                <RefreshCw aria-hidden="true" className="size-3.5" />
              )}
              Refresh
            </button>
          </div>
        )}

        {list.data && list.error && (
          <p role="status" className="mb-3 text-xs text-amber-300">
            Couldn&apos;t refresh the list — showing the last results.
          </p>
        )}

        {pinned && (
          <div className="mb-6">
            <p className="mb-2 text-xs font-semibold tracking-wide text-amber-300 uppercase">
              Linked incident (outside your current filters)
            </p>
            <ErrorBoundary compact title="This report couldn't be displayed">
              <IncidentCard
                incident={pinnedDistance === null ? pinned : { ...pinned, distance_km: pinnedDistance }}
                onChange={(updated) => void focused.mutate(updated, { revalidate: false })}
                highlighted
              />
            </ErrorBoundary>
          </div>
        )}
        {needFocusFetch && focused.error && (
          <Alert variant="warning" className="mb-4">
            <AlertDescription>
              {isApiError(focused.error) && focused.error.status === 404
                ? "The linked incident no longer exists."
                : "We couldn't load the linked incident."}
            </AlertDescription>
          </Alert>
        )}

        {body}
      </div>
    </div>
  );
}

function IncidentListSkeleton() {
  return (
    <div role="status" aria-live="polite" className="grid gap-4 md:grid-cols-2">
      <span className="sr-only">Loading incidents…</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="space-y-3 rounded-2xl border border-slate-700/80 bg-slate-900/60 p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-20 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <div className="flex justify-between pt-2">
            <Skeleton className="h-8 w-28 rounded-lg" />
            <Skeleton className="h-8 w-20 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default IncidentsView;
