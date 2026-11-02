"use client";

/**
 * Shared Leaflet map shell: OpenStreetMap tiles, attribution, zoom control, keyboard
 * panning, and helpers that keep the view in sync with React state.
 *
 * Client-only (Leaflet needs `window`): load map components with
 * `next/dynamic(() => import(...), { ssr: false })`.
 *
 * The Leaflet stylesheet is imported here, once, for every map in the app.
 */

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import * as React from "react";
import { MapContainer, TileLayer, ZoomControl, useMap } from "react-leaflet";

import type { LatLon } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Standard OSM tile server (no subdomains, per the OSM tile usage policy). */
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

export interface BaseMapProps {
  /** Initial centre (later changes are applied by a view controller child). */
  center: LatLon;
  zoom?: number;
  /** Accessible name of the map region. */
  label: string;
  className?: string;
  children?: React.ReactNode;
  scrollWheelZoom?: boolean;
  /** Receives the Leaflet map instance once created (or `null` on unmount). */
  mapRef?: React.Ref<L.Map>;
  zoomControl?: boolean;
  /** Corner of the +/- zoom buttons (top-right keeps them clear of the floating SOS button). */
  zoomPosition?: L.ControlPosition;
}

/**
 * The map container sits in its own stacking context (`isolate`) so Leaflet's internal
 * z-indexes (panes 400, controls 1000) can never cover the sticky navbar or dialogs.
 */
export default function BaseMap({
  center,
  zoom = 13,
  label,
  className,
  children,
  scrollWheelZoom = true,
  mapRef,
  zoomControl = true,
  zoomPosition = "bottomright",
}: BaseMapProps) {
  return (
    <div role="region" aria-label={label} className={cn("relative isolate h-full w-full", className)}>
      <MapContainer
        ref={mapRef}
        center={[center.lat, center.lon]}
        zoom={zoom}
        minZoom={3}
        maxZoom={19}
        zoomControl={false}
        scrollWheelZoom={scrollWheelZoom}
        worldCopyJump
        keyboard
        className="h-full w-full bg-slate-800"
        style={{ zIndex: 0 }}
      >
        <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} maxZoom={19} />
        {zoomControl && <ZoomControl position={zoomPosition} />}
        <ResizeWatcher />
        {children}
      </MapContainer>
    </div>
  );
}

/**
 * Leaflet only listens to window resizes; panels opening/closing or layout shifts change
 * the container size too. Without `invalidateSize` the map shows grey, unloaded areas.
 */
function ResizeWatcher() {
  const map = useMap();
  React.useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => map.invalidateSize({ debounceMoveend: true }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export interface FitRadiusProps {
  center: LatLon;
  radiusKm: number;
  /** Change to force a re-fit even when centre/radius are unchanged (recenter button). */
  token?: number;
}

/**
 * Fits the view to a circle of `radiusKm` around `center` whenever any input changes.
 * The first fit is instant; later ones animate unless the user prefers reduced motion.
 */
export function FitRadius({ center, radiusKm, token = 0 }: FitRadiusProps) {
  const map = useMap();
  const first = React.useRef(true);
  React.useEffect(() => {
    const bounds = L.latLng(center.lat, center.lon).toBounds(Math.max(200, radiusKm * 2000));
    const animate = !first.current && !prefersReducedMotion();
    first.current = false;
    if (animate) {
      map.flyToBounds(bounds, { padding: [24, 24], duration: 0.8 });
    } else {
      map.fitBounds(bounds, { padding: [24, 24], animate: false });
    }
  }, [map, center.lat, center.lon, radiusKm, token]);
  return null;
}

/** Pans to `point` when it changes and is not already comfortably in view. */
export function KeepInView({ point, zoom }: { point: LatLon | null; zoom?: number }) {
  const map = useMap();
  const lat = point?.lat;
  const lon = point?.lon;
  React.useEffect(() => {
    if (lat === undefined || lon === undefined) return;
    const latLng = L.latLng(lat, lon);
    if (map.getBounds().pad(-0.15).contains(latLng)) return;
    map.setView(latLng, Math.max(map.getZoom(), zoom ?? map.getZoom()), {
      animate: !prefersReducedMotion(),
    });
  }, [map, lat, lon, zoom]);
  return null;
}

/** `L.LatLng` → `{lat, lon}` (wrapped into [-180, 180]). */
export function toLatLon(latLng: L.LatLng): LatLon {
  const wrapped = latLng.wrap();
  return { lat: wrapped.lat, lon: wrapped.lng };
}
