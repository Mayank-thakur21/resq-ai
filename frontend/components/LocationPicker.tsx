"use client";

/**
 * Location input for incident reports, with three ways to set the point:
 *
 * 1. "My location" — one-shot high-accuracy GPS fix (only requested when the user asks,
 *    so the permission prompt never appears out of nowhere),
 * 2. "Pick on map" — Leaflet mini-map (tap, drag the pin, or "Use map centre"),
 * 3. "Coordinates" — manual latitude/longitude with range validation.
 *
 * Controlled: the parent owns `value` and receives every change via `onChange`.
 */

import { Crosshair, ExternalLink, LocateFixed, MapIcon, Keyboard, X } from "lucide-react";
import dynamic from "next/dynamic";
import * as React from "react";

import { roundTo5 } from "@/components/map/layers";
import { MapPlaceholder } from "@/components/map/MapPlaceholder";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { formatCoordinates } from "@/lib/format";
import { DEFAULT_COORDS, describePositionError, mapsLink } from "@/lib/geo";
import type { LatLon } from "@/lib/types";
import { cn } from "@/lib/utils";

const PickerMap = dynamic(() => import("@/components/map/PickerMap"), {
  ssr: false,
  loading: () => <MapPlaceholder label="Loading map…" />,
});

export type LocationMode = "gps" | "map" | "manual";

export interface LocationPickerProps {
  value: LatLon | null;
  onChange: (value: LatLon | null) => void;
  /** Base id for the controls (labels, error message). */
  id?: string;
  /** Validation message from the parent form. */
  error?: string;
  disabled?: boolean;
  /** Mode shown first. Default: "map" when a value is given, else "gps". */
  initialMode?: LocationMode;
  /** Where the mini-map starts when there is no value yet (default: `DEFAULT_COORDS`). */
  fallbackCenter?: LatLon;
}

const MODES: readonly { id: LocationMode; label: string; icon: typeof LocateFixed }[] = [
  { id: "gps", label: "My location", icon: LocateFixed },
  { id: "map", label: "Pick on map", icon: MapIcon },
  { id: "manual", label: "Coordinates", icon: Keyboard },
];

/** Parses a coordinate typed by a person ("28.6139", " -77,21 " with a decimal comma). */
export function parseCoordinateInput(raw: string, limit: 90 | 180): number | null {
  const cleaned = raw.trim().replace(",", ".");
  if (!/^[-+]?\d{1,3}(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function toPoint(lat: number, lon: number): LatLon {
  return { lat: roundTo5(lat), lon: roundTo5(lon) };
}

export function LocationPicker({
  value,
  onChange,
  id = "location",
  error,
  disabled = false,
  initialMode,
  fallbackCenter = DEFAULT_COORDS,
}: LocationPickerProps) {
  const [mode, setMode] = React.useState<LocationMode>(initialMode ?? (value ? "map" : "gps"));
  const [accuracy, setAccuracy] = React.useState<number | null>(null);

  // GPS is a one-shot action, so it is requested directly from the click handler (rather
  // than through the auto-locating `useGeolocation` hook). Each request gets a sequence
  // number; answers to superseded requests, or arriving after unmount, are ignored.
  const [gps, setGps] = React.useState<{ status: "idle" | "locating" | "failed"; error?: string }>({
    status: "idle",
  });
  const requestSeq = React.useRef(0);
  React.useEffect(
    () => () => {
      requestSeq.current += 1;
    },
    [],
  );

  const requestFix = () => {
    const seq = ++requestSeq.current;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGps({ status: "failed", error: "This device or browser does not support location." });
      return;
    }
    setGps({ status: "locating" });
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (seq !== requestSeq.current) return;
          setGps({ status: "idle" });
          setAccuracy(Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null);
          onChange(toPoint(position.coords.latitude, position.coords.longitude));
        },
        (positionError) => {
          if (seq !== requestSeq.current) return;
          setGps({ status: "failed", error: describePositionError(positionError).error });
        },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
      );
    } catch (thrown) {
      // Some embedded browsers throw synchronously (blocked by a permissions policy).
      setGps({
        status: "failed",
        error: thrown instanceof Error ? thrown.message : "Location is not available here.",
      });
    }
  };

  // Manual entry keeps its own text so half-typed values are not overwritten.
  const [latText, setLatText] = React.useState(value ? String(value.lat) : "");
  const [lonText, setLonText] = React.useState(value ? String(value.lon) : "");
  const [manualTouched, setManualTouched] = React.useState(false);
  const parsedLat = parseCoordinateInput(latText, 90);
  const parsedLon = parseCoordinateInput(lonText, 180);
  const latError = manualTouched && latText.trim() !== "" && parsedLat === null;
  const lonError = manualTouched && lonText.trim() !== "" && parsedLon === null;

  const selectMode = (next: LocationMode) => {
    setMode(next);
    if (next === "manual" && value) {
      setLatText(String(value.lat));
      setLonText(String(value.lon));
      setManualTouched(false);
    }
  };

  const updateManual = (nextLat: string, nextLon: string) => {
    setLatText(nextLat);
    setLonText(nextLon);
    const lat = parseCoordinateInput(nextLat, 90);
    const lon = parseCoordinateInput(nextLon, 180);
    if (lat !== null && lon !== null) {
      setAccuracy(null);
      onChange(toPoint(lat, lon));
    }
  };

  const pick = React.useCallback(
    (point: LatLon) => {
      setAccuracy(null);
      onChange(toPoint(point.lat, point.lon));
    },
    [onChange],
  );

  const groupLabelId = `${id}-label`;
  const errorId = `${id}-error`;
  const locating = gps.status === "locating";

  return (
    <div
      role="group"
      aria-labelledby={groupLabelId}
      aria-describedby={error ? errorId : undefined}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={groupLabelId} className="flex items-center gap-1 text-sm font-medium text-slate-200">
          Location
          <span aria-hidden="true" className="text-red-400">
            *
          </span>
        </span>
        <div className="inline-flex rounded-xl border border-slate-700 bg-slate-950/60 p-1" role="toolbar" aria-label="How to set the location">
          {MODES.map(({ id: modeId, label, icon: Icon }) => (
            <button
              key={modeId}
              type="button"
              onClick={() => selectMode(modeId)}
              aria-pressed={mode === modeId}
              disabled={disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none disabled:opacity-60",
                mode === modeId ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-800",
              )}
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "gps" && (
        <div className="space-y-3 rounded-xl border border-slate-700/80 bg-slate-950/40 p-4">
          <p className="text-sm text-slate-400">
            Use your device&apos;s GPS when you are at the incident location.
          </p>
          <button
            type="button"
            onClick={requestFix}
            disabled={disabled || locating}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:ring-3 focus-visible:ring-blue-400/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {locating ? (
              <Spinner size="sm" label="Finding your location…" showLabel className="text-white" />
            ) : (
              <>
                <LocateFixed aria-hidden="true" className="size-4" />
                {value ? "Update to my current location" : "Use my current location"}
              </>
            )}
          </button>
          {gps.status === "failed" && (
            <Alert variant="warning">
              <AlertDescription>
                {gps.error ?? "We couldn't get your location."}{" "}
                <button
                  type="button"
                  onClick={() => selectMode("map")}
                  className="font-semibold text-white underline underline-offset-2"
                >
                  Pick on the map instead
                </button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {mode === "map" && (
        <div className="space-y-2">
          <div className="h-64 overflow-hidden rounded-xl border border-slate-700/80 sm:h-72">
            <PickerMap value={value} fallbackCenter={fallbackCenter} onPick={pick} disabled={disabled} />
          </div>
          <p className="text-xs text-slate-400">
            Tap the map or drag the pin to the exact spot. Keyboard: focus the map, pan with the
            arrow keys, then press &ldquo;Use map centre&rdquo;.
          </p>
        </div>
      )}

      {mode === "manual" && (
        <div className="grid gap-3 rounded-xl border border-slate-700/80 bg-slate-950/40 p-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-lat`}>Latitude</Label>
            <Input
              id={`${id}-lat`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="e.g. 28.6139"
              value={latText}
              disabled={disabled}
              onChange={(event) => updateManual(event.target.value, lonText)}
              onBlur={() => setManualTouched(true)}
              aria-invalid={latError || undefined}
              aria-describedby={latError ? `${id}-lat-error` : `${id}-lat-hint`}
              className="h-10 rounded-lg border-slate-700 bg-slate-950/60 text-white"
            />
            {latError ? (
              <p id={`${id}-lat-error`} className="text-xs text-red-300">
                Enter a latitude between -90 and 90.
              </p>
            ) : (
              <p id={`${id}-lat-hint`} className="text-xs text-slate-500">
                -90 (south) to 90 (north)
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-lon`}>Longitude</Label>
            <Input
              id={`${id}-lon`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="e.g. 77.2090"
              value={lonText}
              disabled={disabled}
              onChange={(event) => updateManual(latText, event.target.value)}
              onBlur={() => setManualTouched(true)}
              aria-invalid={lonError || undefined}
              aria-describedby={lonError ? `${id}-lon-error` : `${id}-lon-hint`}
              className="h-10 rounded-lg border-slate-700 bg-slate-950/60 text-white"
            />
            {lonError ? (
              <p id={`${id}-lon-error`} className="text-xs text-red-300">
                Enter a longitude between -180 and 180.
              </p>
            ) : (
              <p id={`${id}-lon-hint`} className="text-xs text-slate-500">
                -180 (west) to 180 (east)
              </p>
            )}
          </div>
          {parsedLat !== null && parsedLon !== null && (
            <p className="text-xs text-slate-400 sm:col-span-2">
              <Crosshair aria-hidden="true" className="mr-1 inline size-3.5" />
              Location set from these coordinates.
            </p>
          )}
        </div>
      )}

      <div
        aria-live="polite"
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm",
          value ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100" : "border-slate-700 bg-slate-900/40 text-slate-400",
        )}
      >
        {value ? (
          <>
            <span>
              <span className="font-semibold">Selected:</span> {formatCoordinates(value.lat, value.lon, 5)}
              {accuracy !== null && ` (±${Math.round(accuracy)} m)`}
            </span>
            <span className="flex items-center gap-2">
              <a
                href={mapsLink(value.lat, value.lon)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200 hover:underline"
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
                Check in Google Maps
              </a>
              <button
                type="button"
                onClick={() => {
                  setAccuracy(null);
                  onChange(null);
                }}
                disabled={disabled}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
              >
                <X aria-hidden="true" className="size-3.5" />
                Clear<span className="sr-only"> location</span>
              </button>
            </span>
          </>
        ) : (
          <span>No location selected yet.</span>
        )}
      </div>

      {error && (
        <p id={errorId} className="text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export default LocationPicker;
