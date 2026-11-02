"use client";

/**
 * Mini-map for `LocationPicker`: tap/click to drop the pin, drag the pin to adjust, or use
 * the "Use map centre" button (keyboard users: pan with the arrow keys, then press it).
 *
 * Client-only; load with `next/dynamic(..., { ssr: false })`.
 */

import { Crosshair } from "lucide-react";
import type L from "leaflet";
import * as React from "react";
import { Marker, useMapEvents } from "react-leaflet";

import BaseMap, { KeepInView, toLatLon } from "@/components/map/BaseMap";
import { pinIcon } from "@/components/map/icons";
import type { LatLon } from "@/lib/types";

export interface PickerMapProps {
  value: LatLon | null;
  /** Initial centre when there is no value yet. */
  fallbackCenter: LatLon;
  onPick: (point: LatLon) => void;
  disabled?: boolean;
}

const PICKED_COLOR = "#dc2626";

function ClickToPick({ onPick, disabled }: { onPick: (point: LatLon) => void; disabled?: boolean }) {
  useMapEvents({
    click(event) {
      if (!disabled) onPick(toLatLon(event.latlng));
    },
  });
  return null;
}

export default function PickerMap({ value, fallbackCenter, onPick, disabled = false }: PickerMapProps) {
  const [map, setMap] = React.useState<L.Map | null>(null);
  const initialCenter = value ?? fallbackCenter;

  const markerHandlers = React.useMemo<L.LeafletEventHandlerFnMap>(
    () => ({
      dragend(event) {
        const marker = event.target as L.Marker;
        onPick(toLatLon(marker.getLatLng()));
      },
    }),
    [onPick],
  );

  return (
    <div className="relative h-full w-full">
      <BaseMap
        center={initialCenter}
        zoom={value ? 16 : 13}
        label="Incident location picker map"
        mapRef={setMap}
        scrollWheelZoom={false}
      >
        <ClickToPick onPick={onPick} disabled={disabled} />
        <KeepInView point={value} zoom={15} />
        {value && (
          <Marker
            position={[value.lat, value.lon]}
            icon={pinIcon(PICKED_COLOR, "📍", { large: true })}
            draggable={!disabled}
            autoPan
            title="Incident location (drag to adjust)"
            eventHandlers={markerHandlers}
          />
        )}
      </BaseMap>
      {/* Centre crosshair helps keyboard users aim before pressing "Use map centre". */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 z-[1000] -translate-x-1/2 -translate-y-1/2 text-slate-900/70"
      >
        <Crosshair className="size-6 drop-shadow-[0_0_2px_rgba(255,255,255,.9)]" />
      </span>
      <button
        type="button"
        disabled={!map || disabled}
        onClick={() => {
          if (map) onPick(toLatLon(map.getCenter()));
        }}
        className="absolute top-2 left-2 z-[1000] inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white/95 px-2.5 py-1.5 text-xs font-semibold text-slate-800 shadow-md hover:bg-white focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:opacity-60"
      >
        <Crosshair aria-hidden="true" className="size-3.5" />
        Use map centre
      </button>
    </div>
  );
}
