"use client";

import { WifiOff } from "lucide-react";

import { useNow } from "@/components/map/hooks";
import { getResponseMeta, type ResponseMeta } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { formatDistance } from "@/lib/geo";
import { cn } from "@/lib/utils";

export interface OfflineDataNoticeProps {
  /**
   * One or more SWR `data` values. The notice shows when any of them is a saved copy served
   * by the service worker (see `getResponseMeta` in `lib/api.ts`); the oldest copy's time
   * is shown.
   */
  data: unknown;
  /** Compact single-line variant for tight spots (map panel, banners). */
  compact?: boolean;
  className?: string;
}

/** Saved copies closer than this to the requested location are not worth mentioning. */
const MENTION_DISTANCE_M = 200;

interface SavedCopySummary {
  cachedAt: string | null;
  /** Largest distance between a copy's location and the requested one (metres). */
  distanceM: number | null;
  /** Every saved copy was served because the server failed (not the connection). */
  serverError: boolean;
}

function oldestSavedCopy(values: unknown[]): SavedCopySummary | null {
  let found: SavedCopySummary | null = null;
  for (const value of values) {
    const meta: ResponseMeta | null = getResponseMeta(value);
    if (!meta?.offline) continue;
    const distanceM = meta.distanceM ?? null;
    const serverError = meta.reason === "server-error";
    if (!found) {
      found = { cachedAt: meta.cachedAt, distanceM, serverError };
      continue;
    }
    if (meta.cachedAt && (!found.cachedAt || Date.parse(meta.cachedAt) < Date.parse(found.cachedAt))) {
      found.cachedAt = meta.cachedAt;
    }
    if (distanceM !== null && (found.distanceM === null || distanceM > found.distanceM)) found.distanceM = distanceM;
    found.serverError = found.serverError && serverError;
  }
  return found;
}

/**
 * "Showing saved data from 2 hours ago — you're offline" label for widgets whose data the
 * service worker served from its cache (network down or slower than 6 s). Emergency data
 * (alert levels, incident status) must never look live when it is not. Renders nothing for
 * live data.
 */
export function OfflineDataNotice({ data, compact = false, className }: OfflineDataNoticeProps) {
  const now = useNow();
  const saved = oldestSavedCopy(Array.isArray(data) ? data : [data]);
  if (!saved) return null;
  const when = saved.cachedAt ? formatRelativeTime(saved.cachedAt, { now }) : null;
  const where =
    saved.distanceM !== null && saved.distanceM >= MENTION_DISTANCE_M
      ? ` for a spot ${formatDistance(saved.distanceM / 1000)} away`
      : "";
  const why = saved.serverError
    ? "the ResQ AI service is having trouble right now."
    : "you're offline or the connection is very slow.";
  const text = `Showing saved data${when ? ` from ${when}` : ""}${where} — ${why}`;
  return (
    <p
      role="status"
      title={saved.cachedAt ? `Saved ${formatDateTime(saved.cachedAt)}` : undefined}
      className={cn(
        "flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-100",
        compact ? "px-2 py-1 text-[11px] leading-snug" : "px-3 py-2 text-xs",
        className,
      )}
    >
      <WifiOff aria-hidden="true" className={cn("mt-0.5 shrink-0", compact ? "size-3" : "size-3.5")} />
      <span>{text}</span>
    </p>
  );
}

export default OfflineDataNotice;
