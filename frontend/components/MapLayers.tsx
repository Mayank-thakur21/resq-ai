"use client";

/**
 * Layer panel for the relief map: one toggle per layer (with its marker colour, result
 * count, loading spinner and per-layer error + retry), the search-radius select and a
 * recenter button. Doubles as the map legend.
 *
 * Purely presentational: the page owns the state and the data (see `useMapData`).
 */

import { CircleAlert, Layers, LocateFixed, RefreshCw, X } from "lucide-react";
import * as React from "react";

import {
  MAP_LAYERS,
  MAP_RADIUS_OPTIONS_KM,
  isMapRadius,
  type MapLayerDef,
  type MapLayerId,
  type MapRadiusKm,
} from "@/components/map/layers";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface LayerStatusView {
  status: "off" | "loading" | "ready" | "error";
  /** Number of results (when `ready`). */
  count?: number;
  /** User-facing error (failed load, or failed refresh while showing older results). */
  error?: string;
  /** Background refresh in flight. */
  refreshing?: boolean;
  onRetry?: () => void;
  /** Extra context under the label, e.g. "within 300 km". */
  note?: string;
}

export interface MapLayersProps {
  enabled: readonly MapLayerId[];
  onToggle: (id: MapLayerId, enabled: boolean) => void;
  status?: Partial<Record<MapLayerId, LayerStatusView>>;
  radiusKm: number;
  onRadiusChange: (radiusKm: MapRadiusKm) => void;
  onRecenter?: () => void;
  recenterLabel?: string;
  recenterDisabled?: boolean;
  /** Shows a close button (mobile sheet). */
  onClose?: () => void;
  layers?: readonly MapLayerDef[];
  /** Prefix for element ids (two panels on one page must differ). */
  idPrefix?: string;
  /** Shown under the title, e.g. the "showing saved data" notice while offline. */
  notice?: React.ReactNode;
  className?: string;
}

function StatusIndicator({ label, view }: { label: string; view?: LayerStatusView }) {
  if (!view || view.status === "off") return null;
  if (view.status === "loading") {
    return <Spinner size="sm" label={`Loading ${label.toLowerCase()}`} className="text-slate-400" />;
  }
  if (view.status === "error") {
    return <CircleAlert aria-label={`${label} failed to load`} role="img" className="size-4 text-red-400" />;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {view.refreshing && (
        <Spinner size="sm" label={`Refreshing ${label.toLowerCase()}`} className="text-slate-500" />
      )}
      <span
        className={cn(
          "min-w-7 rounded-full px-2 py-0.5 text-center text-xs font-semibold tabular-nums",
          view.count ? "bg-slate-700/70 text-slate-100" : "bg-slate-800/70 text-slate-500",
        )}
      >
        <span className="sr-only">{`${view.count ?? 0} ${label.toLowerCase()} found`}</span>
        <span aria-hidden="true">{view.count ?? 0}</span>
      </span>
    </span>
  );
}

export function MapLayers({
  enabled,
  onToggle,
  status = {},
  radiusKm,
  onRadiusChange,
  onRecenter,
  recenterLabel = "Recenter on my location",
  recenterDisabled = false,
  onClose,
  layers = MAP_LAYERS,
  idPrefix = "map-layers",
  notice,
  className,
}: MapLayersProps) {
  const enabledSet = React.useMemo(() => new Set(enabled), [enabled]);
  const titleId = `${idPrefix}-title`;
  const radiusId = `${idPrefix}-radius`;
  const activeCount = layers.filter((layer) => enabledSet.has(layer.id)).length;

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "rounded-2xl border border-slate-700/80 bg-slate-900/90 p-4 text-slate-100 shadow-2xl shadow-black/40 backdrop-blur-md",
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold tracking-wide text-white uppercase">
          <Layers aria-hidden="true" className="size-4 text-blue-300" />
          Map layers
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{activeCount} on</span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close map layers"
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </div>

      {notice}

      <fieldset className="min-w-0">
        <legend className="sr-only">Show on map</legend>
        <ul className="space-y-1">
          {layers.map((layer) => {
            const inputId = `${idPrefix}-${layer.id}`;
            const descriptionId = `${inputId}-description`;
            const view = enabledSet.has(layer.id) ? status[layer.id] : undefined;
            const errorId = view?.error ? `${inputId}-error` : undefined;
            const checked = enabledSet.has(layer.id);
            return (
              <li key={layer.id}>
                <div
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors",
                    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-400",
                    checked ? "bg-slate-800/60" : "hover:bg-slate-800/40",
                  )}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => onToggle(layer.id, event.target.checked)}
                    aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ")}
                    className="size-4 shrink-0 cursor-pointer rounded accent-blue-500 focus-visible:outline-none"
                  />
                  <label htmlFor={inputId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-white/80 text-sm"
                      style={{ backgroundColor: layer.color }}
                    >
                      {layer.glyph}
                    </span>
                    <span className="min-w-0">
                      <span className={cn("block text-sm font-medium", checked ? "text-white" : "text-slate-400")}>
                        {layer.label}
                      </span>
                      <span id={descriptionId} className="block truncate text-[11px] text-slate-500">
                        {view?.note ?? layer.description}
                      </span>
                    </span>
                  </label>
                  <StatusIndicator label={layer.label} view={view} />
                </div>
                {view?.error && (
                  <div
                    id={errorId}
                    className={cn(
                      "mt-1 mb-1 ml-9 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs",
                      view.status === "error" ? "text-red-300" : "text-amber-300",
                    )}
                  >
                    <span>{view.error}</span>
                    {view.onRetry && (
                      <button
                        type="button"
                        onClick={view.onRetry}
                        aria-label={`Retry ${layer.label.toLowerCase()}`}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-white underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
                      >
                        <RefreshCw aria-hidden="true" className="size-3" />
                        Retry
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="mt-4 space-y-2 border-t border-slate-700/60 pt-4">
        <Label htmlFor={radiusId}>Search radius</Label>
        <Select
          id={radiusId}
          value={String(radiusKm)}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (isMapRadius(next)) onRadiusChange(next);
          }}
        >
          {MAP_RADIUS_OPTIONS_KM.map((km) => (
            <option key={km} value={km}>
              {km} km
            </option>
          ))}
        </Select>
      </div>

      {onRecenter && (
        <button
          type="button"
          onClick={onRecenter}
          disabled={recenterDisabled}
          className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:ring-3 focus-visible:ring-blue-400/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          <LocateFixed aria-hidden="true" className="size-4" />
          {recenterLabel}
        </button>
      )}
    </section>
  );
}

export default MapLayers;
