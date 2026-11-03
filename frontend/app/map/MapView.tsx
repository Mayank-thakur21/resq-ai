"use client";

/**
 * Client view of `/map`: location handling, layer preferences, data fetching and the
 * Leaflet map (loaded lazily, never server-rendered).
 *
 * - Centre: `?lat&lon` from the URL, else the device location, else `DEFAULT_COORDS`
 *   (with a visible "Using default location" notice). "Search this area" in the map's click
 *   popup moves the centre; the recenter button returns to the device location.
 * - Layers + radius are remembered per browser (localStorage, best effort).
 * - Every layer loads independently (see `useMapData`); failures show per layer.
 */

import { Layers, LocateFixed, MapIcon, MapPinOff, Siren } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import * as React from "react";

import { EmptyState } from "@/components/EmptyState";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorState } from "@/components/ErrorState";
import { MapLayers } from "@/components/MapLayers";
import { useSearchLocation } from "@/components/map/hooks";
import {
  MAP_LAYER_IDS,
  MAP_RADIUS_OPTIONS_KM,
  disasterRadiusKm,
  loadMapPrefs,
  parseMapPrefs,
  reportIncidentHref,
  saveMapPrefs,
  type MapLayerId,
  type MapPrefs,
  type MapRadiusKm,
} from "@/components/map/layers";
import { MapPlaceholder } from "@/components/map/MapPlaceholder";
import { layerData, layerResponses, toLayerStatusViews, useMapData } from "@/components/map/useMapData";
import { OfflineDataNotice } from "@/components/OfflineDataNotice";
import { formatCoordinates, pluralize } from "@/lib/format";
import type { GeolocationStatus } from "@/lib/geo";
import type { LatLon } from "@/lib/types";
import { PLACE_TYPES } from "@/lib/types";
import { cn } from "@/lib/utils";

const ReliefMap = dynamic(() => import("@/components/map/ReliefMap"), {
  ssr: false,
  loading: () => <MapPlaceholder label="Loading map…" />,
});

const floatingButton =
  "inline-flex items-center justify-center rounded-lg border border-slate-300/80 bg-white text-slate-800 shadow-md transition-colors hover:bg-slate-100 focus-visible:ring-3 focus-visible:ring-blue-500/60 focus-visible:outline-none disabled:opacity-60";

export interface MapViewProps {
  /** Centre requested through the URL (`/map?lat=..&lon=..`), if any. */
  initialCenter: LatLon | null;
}

export default function MapView({ initialCenter }: MapViewProps) {
  const { geo, coords, settled } = useSearchLocation();

  // Defaults on the server and the first client render (no hydration mismatch); stored
  // preferences are applied right after mount.
  const [prefs, setPrefs] = React.useState<MapPrefs>(() => parseMapPrefs(null));
  const prefsLoaded = React.useRef(false);
  // Order matters: the save effect runs before the load effect on mount, so the defaults
  // are never written over the stored preferences.
  React.useEffect(() => {
    if (prefsLoaded.current) saveMapPrefs(prefs);
  }, [prefs]);
  React.useEffect(() => {
    setPrefs(loadMapPrefs());
    prefsLoaded.current = true;
  }, []);

  const [searchCenter, setSearchCenter] = React.useState<LatLon | null>(initialCenter);
  const [viewToken, setViewToken] = React.useState(0);
  const [skippedWait, setSkippedWait] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);

  const centerLat = searchCenter?.lat ?? coords.lat;
  const centerLon = searchCenter?.lon ?? coords.lon;
  const center = React.useMemo<LatLon>(() => ({ lat: centerLat, lon: centerLon }), [centerLat, centerLon]);

  const enabled = React.useMemo(() => new Set<MapLayerId>(prefs.layers), [prefs.layers]);
  const ready = settled || skippedWait || searchCenter !== null;
  const data = useMapData({ center, radiusKm: prefs.radiusKm, enabled, active: ready });
  const statusViews = toLayerStatusViews(data, MAP_LAYER_IDS, {
    disasters: `GDACS alerts within ${disasterRadiusKm(prefs.radiusKm)} km`,
  });

  const toggleLayer = React.useCallback((id: MapLayerId, on: boolean) => {
    setPrefs((prev) => {
      const next = new Set(prev.layers);
      if (on) next.add(id);
      else next.delete(id);
      return { ...prev, layers: MAP_LAYER_IDS.filter((layer) => next.has(layer)) };
    });
  }, []);

  const changeRadius = React.useCallback((radiusKm: MapRadiusKm) => {
    setPrefs((prev) => ({ ...prev, radiusKm }));
  }, []);

  const { retry: retryLocation, status: geoStatus } = geo;
  const recenter = React.useCallback(() => {
    setSearchCenter(null);
    setViewToken((token) => token + 1);
    if (geoStatus !== "ready" && geoStatus !== "locating") retryLocation();
  }, [geoStatus, retryLocation]);

  const searchHere = React.useCallback((point: LatLon) => {
    setSearchCenter(point);
    setViewToken((token) => token + 1);
  }, []);

  const userLocation = geo.coords ?? null;
  const usingDefault = !searchCenter && coords.isDefault;

  // Overall empty state: every enabled layer loaded and nothing matched.
  const enabledViews = MAP_LAYER_IDS.filter((id) => enabled.has(id)).map((id) => layerData(data, id));
  const allLoaded = enabledViews.length > 0 && enabledViews.every((layer) => layer.status === "ready");
  const total = enabledViews.reduce((sum, layer) => sum + layer.items.length, 0);
  const nextRadius = MAP_RADIUS_OPTIONS_KM.find((km) => km > prefs.radiusKm);

  const places = {
    hospital: data.places.hospital.items,
    shelter: data.places.shelter.items,
    police: data.places.police.items,
    fire_station: data.places.fire_station.items,
    pharmacy: data.places.pharmacy.items,
  };
  const placeCount = PLACE_TYPES.reduce((sum, type) => sum + places[type].length, 0);

  const panelProps = {
    // Labels layers the service worker answered from its cache (offline / very slow network).
    notice: <OfflineDataNotice compact data={layerResponses(data)} className="mb-3" />,
    enabled: prefs.layers,
    onToggle: toggleLayer,
    status: statusViews,
    radiusKm: prefs.radiusKm,
    onRadiusChange: changeRadius,
    onRecenter: recenter,
    recenterLabel: geo.coords ? "Recenter on my location" : "Find my location",
  };

  // Exactly fills the viewport between the navbar (and its 1px border) and the mobile tab
  // bar, minus the offline banner while it is shown (`OFFLINE_BANNER_HEIGHT_VAR`), so the
  // map's bottom controls and attribution stay visible.
  return (
    <div className="flex h-[calc(100dvh-7.5rem-1px-env(safe-area-inset-bottom)-var(--offline-banner-h))] min-h-[30rem] flex-col bg-slate-950 lg:h-[calc(100dvh-4rem-1px-var(--offline-banner-h))]">
      <header className="relative z-10 flex flex-col gap-3 border-b border-white/10 bg-gradient-to-r from-slate-900 via-slate-900 to-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-6">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-bold text-white sm:text-xl">
            <MapIcon aria-hidden="true" className="size-5 text-blue-400" />
            Live Relief Map
          </h1>
          <LocationStatus
            status={geo.status}
            accuracy={geo.coords?.accuracy ?? null}
            usingDefault={usingDefault}
            usingLastKnown={!searchCenter && !!coords.isLastKnown}
            searchCenter={searchCenter}
            onRetry={geo.retry}
            onBackToMe={recenter}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ready && (
            <p className="hidden text-xs text-slate-400 xl:block" aria-live="polite">
              {pluralize(placeCount, "place")} · {pluralize(data.incidents.items.length, "incident")} ·{" "}
              {pluralize(data.disasters.items.length, "disaster")}
            </p>
          )}
          <Link
            // Never pre-fill the fallback location: a report must not land in the wrong city.
            href={usingDefault ? "/incidents/new" : reportIncidentHref(center)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white shadow-lg shadow-red-900/30 transition-colors hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none"
          >
            <Siren aria-hidden="true" className="size-4" />
            Report incident
          </Link>
          <button
            type="button"
            onClick={() => setPanelOpen((open) => !open)}
            aria-expanded={panelOpen}
            aria-controls="map-layers-sheet"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none lg:hidden"
          >
            <Layers aria-hidden="true" className="size-4" />
            Layers
            <span className="rounded-full bg-slate-700 px-1.5 text-xs tabular-nums">{prefs.layers.length}</span>
          </button>
        </div>
      </header>

      {/* Below lg the tab bar's raised SOS button overlaps the map's bottom edge: keep
          Leaflet's bottom controls (the attribution the OSM tile policy requires) above it.
          `!` because leaflet.css is unlayered and would beat a layered utility. */}
      <div className="relative isolate min-h-0 flex-1 bg-slate-900 max-lg:[&_.leaflet-bottom]:bottom-6!">
        {ready ? (
          <ErrorBoundary
            resetKeys={[viewToken]}
            fallback={(_error, reset) => (
              <div className="flex h-full items-center justify-center p-6">
                <ErrorState
                  title="The map failed to load"
                  message="Something went wrong while drawing the map. Try again, or use the incident list instead."
                  onRetry={reset}
                >
                  <Link
                    href="/incidents"
                    className="inline-flex items-center rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                  >
                    View incidents list
                  </Link>
                </ErrorState>
              </div>
            )}
          >
            <ReliefMap
              center={center}
              radiusKm={prefs.radiusKm}
              userLocation={userLocation}
              viewToken={viewToken}
              places={places}
              incidents={data.incidents.items}
              disasters={data.disasters.items}
              onSearchHere={searchHere}
              centerIsFallback={usingDefault}
            />
          </ErrorBoundary>
        ) : (
          <MapPlaceholder label="Finding your location…">
            <button
              type="button"
              onClick={() => setSkippedWait(true)}
              className="mt-1 rounded-lg border border-slate-600 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none"
            >
              Skip and use the default location
            </button>
          </MapPlaceholder>
        )}

        {/* Desktop: floating panel (doubles as the legend). */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-[1000] hidden w-80 p-4 lg:block">
          <ErrorBoundary compact title="Layer controls are unavailable">
            <MapLayers {...panelProps} idPrefix="map-layers" className="pointer-events-auto max-h-full overflow-y-auto" />
          </ErrorBoundary>
        </div>

        {/* Mobile: bottom sheet toggled from the header. */}
        {panelOpen && (
          <div id="map-layers-sheet" className="absolute inset-x-3 top-3 bottom-20 z-[1010] overflow-y-auto overscroll-contain lg:hidden">
            <ErrorBoundary compact title="Layer controls are unavailable">
              <MapLayers {...panelProps} idPrefix="map-layers-mobile" onClose={() => setPanelOpen(false)} />
            </ErrorBoundary>
          </div>
        )}

        {ready && (
          <button
            type="button"
            onClick={recenter}
            aria-label={geo.coords ? "Recenter on my location" : "Find my location"}
            title={geo.coords ? "Recenter on my location" : "Find my location"}
            className={cn(floatingButton, "absolute top-[84px] right-[10px] z-[1000] size-[34px]")}
          >
            <LocateFixed aria-hidden="true" className="size-4" />
          </button>
        )}

        {ready && !panelOpen && (enabled.size === 0 || (allLoaded && total === 0)) && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-[1000] flex justify-center px-16 lg:left-80">
            <EmptyState
              compact
              icon={<MapPinOff />}
              title={enabled.size === 0 ? "All layers are hidden" : `Nothing found within ${prefs.radiusKm} km`}
              message={
                enabled.size === 0
                  ? "Turn on a layer to see hospitals, shelters, incidents and more."
                  : "OpenStreetMap has no matching places here and nothing has been reported nearby."
              }
              action={
                enabled.size > 0 && nextRadius ? (
                  <button
                    type="button"
                    onClick={() => changeRadius(nextRadius)}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 focus-visible:ring-3 focus-visible:ring-blue-400/60 focus-visible:outline-none"
                  >
                    Search {nextRadius} km
                  </button>
                ) : null
              }
              className="pointer-events-auto max-w-sm bg-slate-900/90 backdrop-blur-md"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LocationStatus({
  status,
  accuracy,
  usingDefault,
  usingLastKnown = false,
  searchCenter,
  onRetry,
  onBackToMe,
}: {
  status: GeolocationStatus;
  accuracy: number | null;
  usingDefault: boolean;
  usingLastKnown?: boolean;
  searchCenter: LatLon | null;
  onRetry: () => void;
  onBackToMe: () => void;
}) {
  const linkButton =
    "font-semibold text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none rounded";

  if (searchCenter) {
    return (
      <p className="mt-0.5 text-xs text-slate-400" role="status">
        Showing the area around {formatCoordinates(searchCenter.lat, searchCenter.lon)} ·{" "}
        <button type="button" onClick={onBackToMe} className={linkButton}>
          Back to my location
        </button>
      </p>
    );
  }
  if (usingLastKnown) {
    return (
      <p className="mt-0.5 text-xs text-amber-300" role="status">
        You&apos;re offline — showing your last known location.{" "}
        <button type="button" onClick={onRetry} className={linkButton}>
          Try again
        </button>
      </p>
    );
  }
  if (usingDefault) {
    const locating = status === "idle" || status === "locating";
    return (
      <p className="mt-0.5 text-xs text-amber-300" role="status">
        {locating
          ? "Finding your location…"
          : "Using default location — enable location for local results."}{" "}
        {!locating && (
          <button type="button" onClick={onRetry} className={linkButton}>
            Try again
          </button>
        )}
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-xs text-slate-400" role="status">
      Hospitals, shelters, police, incidents and disasters near you
      {accuracy !== null && ` · location ±${Math.round(accuracy)} m`}
    </p>
  );
}
