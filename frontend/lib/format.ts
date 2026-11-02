/**
 * Pure formatting helpers shared across the UI: relative time, dates, units, coordinates
 * and a couple of safe-string helpers.
 *
 * Deliberately React-free (no hooks, no "use client"): server components, client
 * components and tests can all import it. Every function tolerates `null`/`undefined`/
 * invalid input and returns an empty string (or `null` for parsers) instead of throwing, so
 * a malformed upstream value can never crash a widget.
 *
 * Locale: functions take an optional BCP 47 `locale`; `undefined` means "the user's locale"
 * (the browser default). Tests pass explicit locales / time zones for determinism.
 */

/** Anything we accept as a point in time. */
export type DateInput = string | number | Date | null | undefined;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// ---------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------

/** Parses an ISO string / epoch ms / Date into a valid `Date`, or `null`. */
export function parseDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Milliseconds since epoch for a date input, or `null` when invalid. */
export function toTimestamp(value: DateInput): number | null {
  return parseDate(value)?.getTime() ?? null;
}

export interface RelativeTimeOptions {
  /** Reference time (ms since epoch). Default: `Date.now()`. */
  now?: number;
  locale?: string;
  /** `Intl.RelativeTimeFormat` style. Default `"long"` ("5 minutes ago"). */
  style?: Intl.RelativeTimeFormatStyle;
}

// `Intl.RelativeTimeFormat` construction is comparatively expensive; cache per locale+style.
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(locale: string | undefined, style: Intl.RelativeTimeFormatStyle) {
  const key = `${locale ?? ""}|${style}`;
  let formatter = relativeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style });
    relativeFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Human relative time: "just now", "5 minutes ago", "yesterday", "in 3 days".
 *
 * Unit thresholds round the way people speak (45 s → "1 minute", 45 min → "1 hour",
 * 22 h → "1 day"). Returns `""` for invalid input.
 */
export function formatRelativeTime(value: DateInput, options: RelativeTimeOptions = {}): string {
  const timestamp = toTimestamp(value);
  if (timestamp === null) return "";
  const { now = Date.now(), locale, style = "long" } = options;

  const diff = timestamp - now; // negative = past
  const abs = Math.abs(diff);
  const formatter = relativeFormatter(locale, style);

  if (abs < 45 * SECOND) {
    const resolved = formatter.resolvedOptions().locale;
    return resolved.toLowerCase().startsWith("en") ? "just now" : formatter.format(0, "second");
  }

  const sign = diff < 0 ? -1 : 1;
  const pick = (unitMs: number, unit: Intl.RelativeTimeFormatUnit) =>
    formatter.format(sign * Math.max(1, Math.round(abs / unitMs)), unit);

  if (abs < 45 * MINUTE) return pick(MINUTE, "minute");
  if (abs < 22 * HOUR) return pick(HOUR, "hour");
  if (abs < 6.5 * DAY) return pick(DAY, "day");
  if (abs < 4.5 * WEEK) return pick(WEEK, "week");
  if (abs < 11.5 * MONTH) return pick(MONTH, "month");
  return pick(YEAR, "year");
}

export interface DateFormatOptions {
  locale?: string;
  /** IANA time zone (default: the user's). */
  timeZone?: string;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(options: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat(locale, options);
    } catch {
      // Unknown time zone / locale: fall back to the runtime defaults rather than throwing.
      const { timeZone: _ignored, ...rest } = options;
      formatter = new Intl.DateTimeFormat(undefined, rest);
    }
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

/** Clock time, e.g. "15:00" / "3:00 PM" depending on locale. */
export function formatTime(value: DateInput, options: DateFormatOptions = {}): string {
  const date = parseDate(value);
  if (!date) return "";
  return dateFormatter(
    { hour: "numeric", minute: "2-digit", timeZone: options.timeZone },
    options.locale,
  ).format(date);
}

/** Short hour label for forecasts, e.g. "15:00" / "3 PM". */
export function formatHour(value: DateInput, options: DateFormatOptions = {}): string {
  const date = parseDate(value);
  if (!date) return "";
  return dateFormatter({ hour: "numeric", timeZone: options.timeZone }, options.locale).format(date);
}

/** Date only, e.g. "2 Nov 2026". */
export function formatDate(value: DateInput, options: DateFormatOptions = {}): string {
  const date = parseDate(value);
  if (!date) return "";
  return dateFormatter(
    { day: "numeric", month: "short", year: "numeric", timeZone: options.timeZone },
    options.locale,
  ).format(date);
}

/** Date and time, e.g. "2 Nov 2026, 15:04". */
export function formatDateTime(value: DateInput, options: DateFormatOptions = {}): string {
  const date = parseDate(value);
  if (!date) return "";
  return dateFormatter(
    {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: options.timeZone,
    },
    options.locale,
  ).format(date);
}

/** ISO string suitable for `<time dateTime>`; `undefined` when invalid. */
export function toIsoString(value: DateInput): string | undefined {
  return parseDate(value)?.toISOString();
}

// ---------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export type TemperatureUnit = "C" | "F";

/** Celsius → Fahrenheit. */
export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

/**
 * Rounded temperature with unit, e.g. "32°C". `unit: "F"` converts from Celsius.
 * `withUnit: false` returns just "32°".
 */
export function formatTemperature(
  celsius: number | null | undefined,
  { unit = "C", withUnit = true }: { unit?: TemperatureUnit; withUnit?: boolean } = {},
): string {
  if (!isFiniteNumber(celsius)) return "";
  const value = Math.round(unit === "F" ? celsiusToFahrenheit(celsius) : celsius);
  // Avoid "-0°".
  const display = Object.is(value, -0) ? 0 : value;
  return withUnit ? `${display}°${unit}` : `${display}°`;
}

/** Wind speed, e.g. "12 km/h" (rounded; one decimal below 10 km/h). */
export function formatWindSpeed(kmh: number | null | undefined): string {
  if (!isFiniteNumber(kmh) || kmh < 0) return "";
  const value = kmh < 10 ? Math.round(kmh * 10) / 10 : Math.round(kmh);
  return `${value} km/h`;
}

/** Percentage, e.g. "45%" (clamped to 0–100). */
export function formatPercent(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return "";
  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

/** Compact integer, e.g. 1234 → "1.2K" (locale-aware). */
export function formatCompactNumber(value: number | null | undefined, locale?: string): string {
  if (!isFiniteNumber(value)) return "";
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** "1 event" / "3 events". Pass `plural` for irregular nouns. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------------------

/** "28.61°N, 77.21°E" (two decimals ≈ 1 km — enough for display, avoids over-precision). */
export function formatCoordinates(
  lat: number | null | undefined,
  lon: number | null | undefined,
  decimals = 2,
): string {
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return "";
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(decimals)}°${ns}, ${Math.abs(lon).toFixed(decimals)}°${ew}`;
}

// ---------------------------------------------------------------------------------------
// Strings & URLs
// ---------------------------------------------------------------------------------------

/** Truncates to `max` characters on a word boundary when possible, adding "…". */
export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, Math.max(0, max - 1));
  // The slice already ends at a word boundary when the next character is a space.
  const endsOnBoundary = clean.charAt(slice.length) === " ";
  const lastSpace = slice.lastIndexOf(" ");
  const cut = endsOnBoundary || lastSpace <= max * 0.6 ? slice : slice.slice(0, lastSpace);
  return `${cut.replace(/[\s.,;:!?-]+$/, "")}…`;
}

/** "extreme_heat" → "Extreme heat". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "";
  const spaced = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Returns `url` only when it is an absolute http(s) URL, else `null`. Use before rendering
 * upstream-provided links as `href` so a `javascript:` / `data:` URL can never be clicked.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Host name without "www." for link captions, e.g. "gdacs.org". */
export function hostnameOf(url: string | null | undefined): string {
  const safe = safeHttpUrl(url);
  if (!safe) return "";
  return new URL(safe).hostname.replace(/^www\./, "");
}
