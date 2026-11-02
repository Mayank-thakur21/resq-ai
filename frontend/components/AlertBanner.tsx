"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  CloudRain,
  ExternalLink,
  Flame,
  type LucideIcon,
  Mountain,
  RefreshCw,
  Sun,
  Tornado,
  TriangleAlert,
  Waves,
  X,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";
import useSWR from "swr";

import { OfflineDataNotice } from "@/components/OfflineDataNotice";
import { RelativeTime } from "@/components/DisasterFeed";
import { hazardIcon, hazardLabel } from "@/components/WeatherCard";
import { swrKeys } from "@/lib/api";
import { safeHttpUrl, truncate } from "@/lib/format";
import { formatDistance } from "@/lib/geo";
import type {
  AlertLevel,
  DisasterEvent,
  DisasterEventsResponse,
  LatLon,
  WeatherResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Home-page banner for the single most severe *relevant* alert:
 *
 * - GDACS orange/red disaster events within `radiusKm` of the user (`/api/alerts/disasters`),
 * - official weather alerts and medium/high weather hazards at the user's location
 *   (`/api/weather`, shared SWR cache with the WeatherCard — no extra request).
 *
 * Ranking (most severe first): red GDACS event > high official weather alert > high hazard
 * > orange GDACS event > medium official alert > medium hazard > low official alert. Ties
 * prefer the closer event. Low hazards never raise a banner.
 *
 * Each alert can be dismissed; dismissals are remembered per alert id in `localStorage`
 * (an escalation, e.g. orange → red, has a new id and shows again). After dismissing, the
 * next most severe alert (if any) is shown. The banner renders nothing while loading and
 * when nothing relevant is active — a hidden-by-default banner must not reserve space or
 * flash a skeleton. If the alert sources fail and nothing can be shown, a slim notice with
 * a retry button says so.
 */

export const DISMISSED_ALERTS_STORAGE_KEY = "resq_dismissed_alerts";
/** Forget dismissals after two weeks so the storage entry cannot grow forever. */
const DISMISS_TTL_MS = 14 * 24 * 60 * 60_000;
const ALERTS_REFRESH_MS = 10 * 60_000;
export const DEFAULT_BANNER_RADIUS_KM = 500;

export const ALERT_LEVEL_RANK: Record<AlertLevel, number> = { green: 0, orange: 1, red: 2 };

const EVENT_TYPE_ICONS: Record<string, LucideIcon> = {
  EQ: Activity,
  TC: Tornado,
  FL: Waves,
  VO: Mountain,
  DR: Sun,
  WF: Flame,
};

/** Icon for a GDACS event type code (EQ, TC, FL, VO, DR, WF). */
export function disasterEventIcon(eventType: string): LucideIcon {
  return EVENT_TYPE_ICONS[eventType.toUpperCase()] ?? TriangleAlert;
}

export type BannerTone = "critical" | "high" | "elevated";

export interface AlertCandidate {
  /** Stable id used for dismissal. */
  id: string;
  kind: "disaster" | "weather_alert" | "hazard";
  /** Higher = more severe. */
  score: number;
  tone: BannerTone;
  /** Short category line, e.g. "Red alert · Earthquake". */
  eyebrow: string;
  title: string;
  detail: string;
  /** Primary link (GDACS report for disasters). */
  href: string | null;
  external: boolean;
  icon: LucideIcon;
  /** Relevant timestamp (event start / alert start / observation). */
  time: string | null;
  distanceKm: number | null;
}

const SCORES = {
  disaster: { red: 100, orange: 70 },
  weatherAlert: { high: 90, medium: 60, low: 30 },
  hazard: { high: 80, medium: 50 },
} as const;

function toneFor(score: number): BannerTone {
  if (score >= 90) return "critical";
  if (score >= 70) return "high";
  return "elevated";
}

/** Local calendar day ("2026-11-02") so a dismissed daily hazard comes back tomorrow. */
function localDay(value: string | null | undefined): string {
  const date = value ? new Date(value) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = String(safe.getMonth() + 1).padStart(2, "0");
  const day = String(safe.getDate()).padStart(2, "0");
  return `${safe.getFullYear()}-${month}-${day}`;
}

/**
 * Turns the raw feeds into banner candidates, most severe first. Pure (exported for tests).
 */
export function buildAlertCandidates({
  events,
  weather,
}: {
  events?: readonly DisasterEvent[] | null;
  weather?: WeatherResponse | null;
}): AlertCandidate[] {
  const candidates: AlertCandidate[] = [];

  for (const event of events ?? []) {
    if (event.alert_level !== "red" && event.alert_level !== "orange") continue;
    if (event.is_current === false) continue;
    const score = SCORES.disaster[event.alert_level];
    const distance = typeof event.distance_km === "number" ? event.distance_km : null;
    const detailParts = [
      event.country,
      distance !== null ? `${formatDistance(distance)} away` : null,
      event.severity_text,
    ].filter((part): part is string => !!part);
    candidates.push({
      id: `gdacs:${event.id}:${event.alert_level}`,
      kind: "disaster",
      score,
      tone: toneFor(score),
      eyebrow: `${event.alert_level === "red" ? "Red" : "Orange"} alert · ${event.event_type_label || event.event_type}`,
      title: event.title,
      detail: detailParts.join(" · "),
      href: safeHttpUrl(event.url),
      external: true,
      icon: disasterEventIcon(event.event_type),
      time: event.from_date,
      distanceKm: distance,
    });
  }

  if (weather) {
    for (const alert of weather.alerts ?? []) {
      const score = SCORES.weatherAlert[alert.severity] ?? SCORES.weatherAlert.low;
      candidates.push({
        id: `wx-alert:${alert.event}:${alert.start ?? ""}`,
        kind: "weather_alert",
        score,
        tone: toneFor(score),
        eyebrow: `Official weather alert${alert.sender ? ` · ${alert.sender}` : ""}`,
        title: alert.event,
        detail: truncate(alert.description, 160),
        href: null,
        external: false,
        icon: CloudRain,
        time: alert.start,
        distanceKm: null,
      });
    }
    const day = localDay(weather.weather?.observed_at);
    for (const hazard of weather.hazards ?? []) {
      if (hazard.severity !== "high" && hazard.severity !== "medium") continue;
      const score = SCORES.hazard[hazard.severity];
      candidates.push({
        id: `hazard:${hazard.type}:${hazard.severity}:${day}`,
        kind: "hazard",
        score,
        tone: toneFor(score),
        eyebrow: "Weather hazard",
        title: hazardLabel(hazard.type),
        detail: hazard.message,
        href: null,
        external: false,
        icon: hazardIcon(hazard.type),
        time: weather.weather?.observed_at ?? null,
        distanceKm: null,
      });
    }
  }

  // Stable sort: severity, then proximity (unknown distance last), then input order.
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      const da = a.candidate.distanceKm ?? Number.POSITIVE_INFINITY;
      const db = b.candidate.distanceKm ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.index - b.index;
    })
    .map(({ candidate }) => candidate);
}

// ---------------------------------------------------------------------------------------
// Dismissal storage (guarded: storage may be unavailable in private mode)
// ---------------------------------------------------------------------------------------

type DismissedMap = Record<string, number>;

function prune(map: DismissedMap, now: number): DismissedMap {
  const result: DismissedMap = {};
  for (const [id, at] of Object.entries(map)) {
    if (typeof at === "number" && now - at < DISMISS_TTL_MS) result[id] = at;
  }
  return result;
}

export function loadDismissedAlerts(now: number = Date.now()): DismissedMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DISMISSED_ALERTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return prune(parsed as DismissedMap, now);
  } catch {
    return {};
  }
}

function saveDismissedAlerts(map: DismissedMap): void {
  try {
    window.localStorage.setItem(DISMISSED_ALERTS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: the dismissal still applies for this page view.
  }
}

// ---------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------

const TONE_CLASSES: Record<BannerTone, string> = {
  critical: "bg-red-600/90 border-red-500",
  high: "bg-orange-600/90 border-orange-500",
  elevated: "bg-amber-600/90 border-amber-500",
};

export interface AlertBannerProps {
  /** User location; `null` while still locating (nothing is fetched or shown). */
  coords: LatLon | null;
  /** Coordinates are the app's default location (mentioned in the banner). */
  isDefaultLocation?: boolean;
  /** Only GDACS events within this distance count as "nearby". Default 500 km. */
  radiusKm?: number;
  /** Link target for weather alerts/hazards, e.g. `"#weather"` to scroll to the card. */
  weatherHref?: string;
  className?: string;
}

export function AlertBanner({
  coords,
  isDefaultLocation = false,
  radiusKm = DEFAULT_BANNER_RADIUS_KM,
  weatherHref,
  className,
}: AlertBannerProps) {
  const disasters = useSWR<DisasterEventsResponse>(
    coords
      ? swrKeys.disasters({
          lat: coords.lat,
          lon: coords.lon,
          radius_km: radiusKm,
          min_level: "orange",
          limit: 10,
        })
      : null,
    { refreshInterval: ALERTS_REFRESH_MS },
  );
  const weather = useSWR<WeatherResponse>(coords ? swrKeys.weather(coords) : null, {
    refreshInterval: ALERTS_REFRESH_MS,
  });

  const [dismissed, setDismissed] = React.useState<DismissedMap>(() => loadDismissedAlerts());

  // Ignore data that belongs to a previous location (SWR keepPreviousData) — a banner for
  // the wrong place is worse than a short delay.
  const events = disasters.isLoading ? undefined : disasters.data?.events;
  const weatherData = weather.isLoading ? undefined : weather.data;

  const candidates = React.useMemo(
    () => buildAlertCandidates({ events, weather: weatherData }),
    [events, weatherData],
  );
  const visible = candidates.filter((candidate) => !(candidate.id in dismissed));
  const top = visible[0];

  const dismiss = React.useCallback((id: string) => {
    setDismissed((previous) => {
      const next = prune({ ...previous, [id]: Date.now() }, Date.now());
      saveDismissedAlerts(next);
      return next;
    });
  }, []);

  const { mutate: refreshDisasters } = disasters;
  const { mutate: refreshWeather } = weather;
  const retry = React.useCallback(() => {
    void refreshDisasters();
    void refreshWeather();
  }, [refreshDisasters, refreshWeather]);

  if (!coords) return null;

  const loading = disasters.isLoading || weather.isLoading;
  const failed = (!!disasters.error && !disasters.data) || (!!weather.error && !weather.data);

  if (!top) {
    if (loading || !failed) return null;
    return (
      <div
        role="status"
        className={cn("border-b border-amber-500/30 bg-slate-900/80 backdrop-blur-sm", className)}
      >
        <div className="container mx-auto flex items-center justify-between gap-3 px-4 py-2 text-xs text-amber-100">
          <span className="flex items-center gap-2">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-amber-300" />
            Live alerts couldn&apos;t be checked right now.
          </span>
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-amber-200 transition-colors hover:bg-amber-500/15 focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:outline-none"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  const others = visible.length - 1;
  const Icon = top.icon;
  const primaryHref = top.kind === "disaster" ? top.href : (weatherHref ?? null);

  return (
    <section aria-label="Active alert" className={className}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={top.id}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className={cn("overflow-hidden border-b text-white backdrop-blur-sm", TONE_CLASSES[top.tone])}
        >
          <div
            role={top.tone === "critical" ? "alert" : "status"}
            className="container mx-auto flex items-start justify-between gap-3 px-4 py-3"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span aria-hidden="true" className="relative mt-1.5 flex size-3 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-white opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex size-3 rounded-full bg-white" />
              </span>
              <Icon aria-hidden="true" className="mt-0.5 hidden size-5 shrink-0 sm:block" />
              <div className="min-w-0">
                <p className="text-xs font-bold tracking-wide uppercase">⚠ {top.eyebrow}</p>
                <p className="mt-0.5 line-clamp-2 text-sm font-semibold">{top.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-white/85">
                  {top.detail && <span className="line-clamp-2">{top.detail}</span>}
                  {top.kind === "disaster" && top.time && (
                    <>
                      <span aria-hidden="true">•</span>
                      <RelativeTime value={top.time} prefix="Started" />
                    </>
                  )}
                  {isDefaultLocation && (
                    <>
                      <span aria-hidden="true">•</span>
                      <span>Near the default location</span>
                    </>
                  )}
                </p>
                <OfflineDataNotice
                  compact
                  data={top.kind === "disaster" ? disasters.data : weather.data}
                  className="mt-1.5 inline-flex border-white/30 bg-black/20 text-white"
                />
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold">
                  {primaryHref &&
                    (top.external ? (
                      <a
                        href={primaryHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
                      >
                        GDACS report <ExternalLink aria-hidden="true" className="size-3" />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <a
                        href={primaryHref}
                        className="inline-flex items-center gap-1 rounded underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
                      >
                        Weather details
                      </a>
                    ))}
                  <Link
                    href="/alerts"
                    className="inline-flex items-center gap-1 rounded underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
                  >
                    {others > 0 ? `All alerts (+${others} more)` : "All alerts"}
                    <ArrowRight aria-hidden="true" className="size-3" />
                  </Link>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => dismiss(top.id)}
              aria-label={`Dismiss alert: ${top.title}`}
              className="shrink-0 rounded-full p-1 transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

export default AlertBanner;
