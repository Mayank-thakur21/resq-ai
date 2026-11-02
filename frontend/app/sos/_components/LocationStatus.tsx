"use client";

import { ExternalLink, LocateFixed, LocateOff, MapPin, RefreshCw } from "lucide-react";

import { formatAccuracy, POOR_ACCURACY_METERS } from "@/app/sos/sos-helpers";
import { Spinner } from "@/components/ui/spinner";
import { formatCoordinates, formatTime } from "@/lib/format";
import { type GeolocationState, mapsLink } from "@/lib/geo";
import { cn } from "@/lib/utils";

/**
 * Live location readout for the SOS page: status, accuracy, coordinates and a map link,
 * or an actionable explanation when the location is unavailable. Never falls back to a
 * default location — an SOS must only ever carry the user's real position.
 */
export function LocationStatus({ geo, className }: { geo: GeolocationState; className?: string }) {
  const { status, coords, error, timestamp, retry } = geo;
  const accuracy = coords?.accuracy ?? null;
  const poor = accuracy !== null && accuracy > POOR_ACCURACY_METERS;
  const stale = !!coords && (status === "denied" || status === "unavailable" || status === "error");

  return (
    <section
      aria-labelledby="sos-location-title"
      className={cn("rounded-2xl border border-slate-700 bg-slate-800/50 p-4 backdrop-blur-md", className)}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex size-10 shrink-0 items-center justify-center rounded-xl",
            coords && !stale ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300",
          )}
        >
          {coords ? <LocateFixed className="size-5" /> : <LocateOff className="size-5" />}
        </span>
        <div className="min-w-0 flex-1" aria-live="polite">
          <h2 id="sos-location-title" className="text-base font-semibold text-white">
            Your location
          </h2>

          {coords ? (
            <>
              <p className="mt-0.5 text-sm text-slate-300">
                <span className={cn("font-semibold", stale ? "text-amber-200" : "text-emerald-200")}>
                  {stale ? "Last known position" : status === "locating" ? "Improving accuracy…" : "Location found"}
                </span>
                {accuracy !== null && <span className="text-slate-400"> · {formatAccuracy(accuracy)}</span>}
                {timestamp && <span className="text-slate-500"> · {formatTime(timestamp)}</span>}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="inline-flex items-center gap-1 font-mono text-slate-200">
                  <MapPin aria-hidden="true" className="size-3.5 text-slate-400" />
                  {formatCoordinates(coords.lat, coords.lon, 5)}
                </span>
                <a
                  href={mapsLink(coords.lat, coords.lon)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded text-cyan-300 hover:text-cyan-200 hover:underline focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none"
                >
                  Check on map
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
              </p>
              {poor && (
                <p className="mt-2 text-xs text-amber-200">
                  This location is approximate. Turn on precise location or move near a window or outdoors.
                </p>
              )}
              {stale && error && <p className="mt-2 text-xs text-amber-200">{error}</p>}
            </>
          ) : status === "idle" || status === "locating" ? (
            <Spinner showLabel label="Finding your location…" size="sm" className="mt-1" />
          ) : (
            <div className="mt-1 space-y-2 text-sm">
              <p className="text-amber-100">
                {error ?? "Your location is unavailable."} An SOS needs your real location — you can still call or
                text for help below.
              </p>
            </div>
          )}
        </div>
        {(status === "denied" || status === "unavailable" || status === "error") && (
          <button
            type="button"
            onClick={retry}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700/60 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Retry
          </button>
        )}
      </div>
    </section>
  );
}

export default LocationStatus;
