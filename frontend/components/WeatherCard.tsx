"use client";

import { motion } from "framer-motion";
import {
  CircleCheck,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Cloudy,
  Droplets,
  type LucideIcon,
  MapPin,
  Moon,
  RefreshCw,
  Sun,
  ThermometerSnowflake,
  ThermometerSun,
  TriangleAlert,
  Umbrella,
  Wind,
} from "lucide-react";
import * as React from "react";
import useSWR from "swr";

import { OfflineDataNotice } from "@/components/OfflineDataNotice";
import { RelativeTime } from "@/components/DisasterFeed";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage, isApiError, swrKeys } from "@/lib/api";
import {
  formatCoordinates,
  formatDateTime,
  formatHour,
  formatPercent,
  formatTemperature,
  formatWindSpeed,
  humanize,
  toTimestamp,
} from "@/lib/format";
import type {
  ForecastItem,
  Hazard,
  LatLon,
  RiskLevel,
  WeatherAlert,
  WeatherResponse,
  WeatherSource,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Current conditions card for the home page (`GET /api/weather`, real data from
 * OpenWeatherMap or Open-Meteo — never mocked).
 *
 * Shows temperature, feels-like, humidity, wind, place name, the data source, a mini
 * forecast for the next hours, official weather alerts and heuristic hazards.
 *
 * `coords = null` means "location not decided yet" (still locating) and renders the
 * skeleton without fetching. Wrap it in an `ErrorBoundary` at the call site.
 */

/** The backend caches weather for 5 minutes; refreshing every 10 is plenty. */
const WEATHER_REFRESH_MS = 10 * 60_000;
const FORECAST_ITEMS = 6;

const SOURCE_LABELS: Record<WeatherSource, string> = {
  openweathermap: "OpenWeatherMap",
  "open-meteo": "Open-Meteo",
};

export function weatherSourceLabel(source: WeatherSource | string): string {
  return SOURCE_LABELS[source as WeatherSource] ?? source;
}

/** Maps an OpenWeatherMap-style icon code ("10d", "01n", ...) to a lucide icon. */
export function weatherIcon(icon: string | null | undefined): LucideIcon {
  const code = (icon ?? "").slice(0, 2);
  const night = (icon ?? "").endsWith("n");
  switch (code) {
    case "01":
      return night ? Moon : Sun;
    case "02":
      return night ? CloudMoon : CloudSun;
    case "03":
      return Cloud;
    case "04":
      return Cloudy;
    case "09":
      return CloudDrizzle;
    case "10":
      return CloudRain;
    case "11":
      return CloudLightning;
    case "13":
      return CloudSnow;
    case "50":
      return CloudFog;
    default:
      return Cloud;
  }
}

const HAZARD_META: Record<string, { label: string; icon: LucideIcon }> = {
  extreme_heat: { label: "Extreme heat", icon: ThermometerSun },
  extreme_cold: { label: "Extreme cold", icon: ThermometerSnowflake },
  high_wind: { label: "High wind", icon: Wind },
  heavy_rain: { label: "Heavy rain", icon: CloudRain },
  thunderstorm: { label: "Thunderstorm", icon: CloudLightning },
};

/** Display label for a backend hazard type ("extreme_heat" → "Extreme heat"). */
export function hazardLabel(type: string): string {
  return HAZARD_META[type]?.label ?? humanize(type);
}

export function hazardIcon(type: string): LucideIcon {
  return HAZARD_META[type]?.icon ?? TriangleAlert;
}

const RISK_ORDER: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };

/** Forecast steps from (roughly) now on, in time order, at most `count`. */
export function upcomingForecast(
  forecast: readonly ForecastItem[],
  now: number = Date.now(),
  count: number = FORECAST_ITEMS,
): ForecastItem[] {
  return forecast
    .map((item) => ({ item, time: toTimestamp(item.time) }))
    // Keep the current hour's step (up to 59 min old) but nothing older.
    .filter((entry): entry is { item: ForecastItem; time: number } => entry.time !== null && entry.time > now - 60 * 60_000)
    .sort((a, b) => a.time - b.time)
    .slice(0, count)
    .map((entry) => entry.item);
}

function temperatureTone(celsius: number): string {
  if (celsius >= 40) return "text-red-400";
  if (celsius >= 32) return "text-amber-400";
  if (celsius <= 0) return "text-cyan-300";
  return "text-sky-300";
}

export interface WeatherCardProps {
  /** Point to show the weather for; `null` while the location is still being resolved. */
  coords: LatLon | null;
  /** The coords are the app's default location (show that instead of "your location"). */
  isDefaultLocation?: boolean;
  /** Element id (e.g. `"weather"` so the alert banner can link to it). */
  id?: string;
  className?: string;
}

export function WeatherCard({ coords, isDefaultLocation = false, id, className }: WeatherCardProps) {
  const key = coords ? swrKeys.weather(coords) : null;
  const { data, error, isLoading, isValidating, mutate } = useSWR<WeatherResponse>(key, {
    refreshInterval: WEATHER_REFRESH_MS,
  });

  const retry = React.useCallback(() => {
    void mutate();
  }, [mutate]);

  const shell = (children: React.ReactNode, header?: React.ReactNode) => (
    <motion.section
      id={id}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.2 }}
      aria-labelledby="weather-card-title"
      className={cn(
        "scroll-mt-24 rounded-2xl border border-slate-700 bg-slate-800/50 p-6 backdrop-blur-md",
        className,
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2
          id="weather-card-title"
          className="flex items-center gap-2 text-sm font-semibold tracking-wider text-slate-400 uppercase"
        >
          <CloudLightning aria-hidden="true" className="size-4" /> Current Conditions
        </h2>
        {header}
      </div>
      {children}
    </motion.section>
  );

  if (!coords || (!data && !error)) {
    return shell(<WeatherSkeleton label={coords ? "Loading weather…" : "Finding your location…"} />);
  }

  if (!data) {
    return shell(
      <ErrorState
        compact
        title="Weather is unavailable"
        message={getErrorMessage(error, "We couldn't load the weather for your area.")}
        offline={isApiError(error) && error.isNetworkError}
        onRetry={retry}
        className="border-0 bg-transparent p-2"
      />,
    );
  }

  // keepPreviousData: data belongs to the previous coords while the new ones load.
  const stale = isLoading;
  const { weather, forecast, alerts, hazards } = data;
  const Icon = weatherIcon(weather.icon);
  const place = weather.city
    ? `${weather.city}${weather.country ? `, ${weather.country}` : ""}`
    : isDefaultLocation
      ? "Default location"
      : "Your location";
  const coordinateText = formatCoordinates(coords.lat, coords.lon);
  const nextHours = upcomingForecast(forecast);
  const sortedHazards = [...hazards].sort((a, b) => RISK_ORDER[a.severity] - RISK_ORDER[b.severity]);

  return shell(
    <div className={cn("transition-opacity", stale && "opacity-60")} aria-busy={isValidating}>
      {stale && (
        <p role="status" className="mb-2 text-xs text-slate-400">
          Updating for your location…
        </p>
      )}
      {error && !stale && (
        <p role="status" className="mb-2 text-xs text-amber-300">
          Couldn&apos;t refresh — showing the last reading.
        </p>
      )}
      <OfflineDataNotice data={data} className="mb-3" />

      <div className="flex items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <Icon aria-hidden="true" className={cn("size-11 shrink-0", temperatureTone(weather.temperature))} />
          <p className="leading-none">
            <span className="text-5xl font-light">{formatTemperature(weather.temperature, { withUnit: false })}</span>
            <span className="ml-1 text-xl text-slate-400">C</span>
            <span className="sr-only"> ({formatTemperature(weather.temperature)})</span>
          </p>
        </div>
        <div className="min-w-0 text-right">
          <p className={cn("font-medium first-letter:uppercase", temperatureTone(weather.feels_like))}>
            {weather.description}
          </p>
          <p
            className="mt-1 flex items-center justify-end gap-1 text-xs text-slate-400"
            title={coordinateText}
          >
            <MapPin aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">
              {place}
              {isDefaultLocation && weather.city ? " (default)" : ""}
            </span>
          </p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-3 gap-2 border-t border-slate-700/50 pt-4 text-center">
        <Stat icon={Wind} label="Wind" value={formatWindSpeed(weather.wind_speed_kmh)} />
        <Stat
          icon={Droplets}
          label="Humidity"
          value={formatPercent(weather.humidity)}
          className="border-r border-l border-slate-700/50"
        />
        <Stat icon={ThermometerSun} label="Feels like" value={formatTemperature(weather.feels_like)} />
      </dl>

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">Next hours</h3>
        {nextHours.length > 0 ? (
          <ol className="grid grid-cols-6 gap-1 text-center" aria-label="Hourly forecast">
            {nextHours.map((item) => (
              <ForecastCell key={item.time} item={item} />
            ))}
          </ol>
        ) : (
          <EmptyState
            compact
            icon={<Cloud />}
            title="Forecast unavailable"
            message="The provider didn't return upcoming hours."
            className="p-3"
          />
        )}
      </div>

      <WeatherWarnings alerts={alerts} hazards={sortedHazards} />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <RelativeTime value={weather.observed_at} prefix="Observed" />
        <Badge variant="outline" className="text-[10px]" title="Real data source">
          <span className="sr-only">Source: </span>
          {weatherSourceLabel(weather.source)}
        </Badge>
      </div>
    </div>,
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={retry}
        disabled={isValidating}
        aria-label="Refresh weather"
        title="Refresh weather"
        className="inline-flex size-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-700/60 hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none disabled:opacity-60"
      >
        <RefreshCw
          aria-hidden="true"
          className={cn("size-3.5", isValidating && "animate-spin motion-reduce:animate-none")}
        />
      </button>
    </div>,
  );
}

export default WeatherCard;

// ---------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------

function Stat({
  icon: Icon,
  label,
  value,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="flex flex-col items-center gap-1 text-[11px] text-slate-500">
        <Icon aria-hidden="true" className="size-4 text-slate-400" />
        {label}
      </dt>
      <dd className="mt-0.5 text-xs text-slate-300">{value || "—"}</dd>
    </div>
  );
}

function ForecastCell({ item }: { item: ForecastItem }) {
  const Icon = weatherIcon(item.icon);
  const rain = item.precipitation_probability;
  return (
    <li className="flex flex-col items-center gap-1 rounded-lg py-1" title={`${formatDateTime(item.time)}: ${item.description}`}>
      <span className="text-[11px] text-slate-400">{formatHour(item.time)}</span>
      <Icon aria-hidden="true" className="size-4 text-slate-300" />
      <span className="sr-only">{item.description}, </span>
      <span className="text-xs font-medium text-slate-200">{formatTemperature(item.temperature, { withUnit: false })}</span>
      {rain !== null && rain >= 10 ? (
        <span className="flex items-center gap-0.5 text-[10px] text-sky-300">
          <Umbrella aria-hidden="true" className="size-2.5" />
          <span className="sr-only">Chance of rain </span>
          {formatPercent(rain)}
        </span>
      ) : (
        <span aria-hidden="true" className="h-3" />
      )}
    </li>
  );
}

function WeatherWarnings({ alerts, hazards }: { alerts: WeatherAlert[]; hazards: Hazard[] }) {
  if (alerts.length === 0 && hazards.length === 0) {
    return (
      <p className="mt-5 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">
        <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-emerald-300" />
        No weather hazards detected right now.
      </p>
    );
  }

  return (
    <div className="mt-5 space-y-2">
      <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Warnings</h3>
      <ul className="space-y-2">
        {alerts.map((alert, index) => (
          <li
            key={`alert-${alert.event}-${alert.start ?? index}`}
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-100"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-semibold">
                <TriangleAlert aria-hidden="true" className="size-3.5 text-red-300" />
                {alert.event}
              </span>
              <Badge variant={alert.severity} uppercase className="text-[10px]">
                {alert.severity}
              </Badge>
            </div>
            <p className="mt-1 text-red-200/80">
              {alert.sender}
              {alert.end ? ` · until ${formatDateTime(alert.end)}` : ""}
            </p>
          </li>
        ))}
        {hazards.map((hazard, index) => {
          const HazardIcon = hazardIcon(hazard.type);
          return (
            <li
              key={`hazard-${hazard.type}-${index}`}
              className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-semibold">
                  <HazardIcon aria-hidden="true" className="size-3.5 text-amber-300" />
                  {hazardLabel(hazard.type)}
                </span>
                <Badge variant={hazard.severity} uppercase className="text-[10px]">
                  {hazard.severity}
                </Badge>
              </div>
              <p className="mt-1 text-amber-100/80">{hazard.message}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WeatherSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="flex items-end justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 rounded-full" />
          <Skeleton className="h-12 w-24" />
        </div>
        <div className="flex flex-col items-end gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="mt-6 grid grid-cols-3 gap-2 border-t border-slate-700/50 pt-4">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col items-center gap-1.5">
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-6 gap-1">
        {Array.from({ length: FORECAST_ITEMS }, (_, index) => (
          <Skeleton key={index} className="h-14 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
