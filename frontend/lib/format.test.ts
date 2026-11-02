import { describe, expect, it } from "vitest";

import {
  celsiusToFahrenheit,
  formatCoordinates,
  formatDate,
  formatDateTime,
  formatHour,
  formatPercent,
  formatRelativeTime,
  formatTemperature,
  formatTime,
  formatWindSpeed,
  hostnameOf,
  humanize,
  parseDate,
  pluralize,
  safeHttpUrl,
  toIsoString,
  truncate,
} from "@/lib/format";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("parseDate / toIsoString", () => {
  it("accepts ISO strings, epoch ms and Dates", () => {
    expect(parseDate("2026-11-02T12:00:00Z")?.getTime()).toBe(NOW);
    expect(parseDate(NOW)?.getTime()).toBe(NOW);
    expect(parseDate(new Date(NOW))?.getTime()).toBe(NOW);
    expect(toIsoString("2026-11-02T12:00:00+00:00")).toBe("2026-11-02T12:00:00.000Z");
  });

  it("returns null/undefined for missing or invalid input", () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
    expect(toIsoString("nope")).toBeUndefined();
  });
});

describe("formatRelativeTime", () => {
  const opts = { now: NOW, locale: "en" };

  it("says 'just now' for the last 45 seconds (English)", () => {
    expect(formatRelativeTime(ago(10_000), opts)).toBe("just now");
    expect(formatRelativeTime(ahead(10_000), opts)).toBe("just now");
  });

  it("uses minutes, hours, days, weeks, months and years", () => {
    expect(formatRelativeTime(ago(5 * MIN), opts)).toBe("5 minutes ago");
    expect(formatRelativeTime(ago(50 * MIN), opts)).toBe("1 hour ago");
    expect(formatRelativeTime(ago(3 * HOUR), opts)).toBe("3 hours ago");
    expect(formatRelativeTime(ago(DAY), opts)).toBe("yesterday");
    expect(formatRelativeTime(ago(3 * DAY), opts)).toBe("3 days ago");
    expect(formatRelativeTime(ago(14 * DAY), opts)).toBe("2 weeks ago");
    expect(formatRelativeTime(ago(60 * DAY), opts)).toBe("2 months ago");
    expect(formatRelativeTime(ago(800 * DAY), opts)).toBe("2 years ago");
  });

  it("formats future times", () => {
    expect(formatRelativeTime(ahead(2 * HOUR), opts)).toBe("in 2 hours");
    expect(formatRelativeTime(ahead(DAY), opts)).toBe("tomorrow");
  });

  it("supports the short style and other locales", () => {
    expect(formatRelativeTime(ago(5 * MIN), { ...opts, style: "short" })).toMatch(/^5 min\.? ago$/);
    expect(formatRelativeTime(ago(10_000), { now: NOW, locale: "de" })).toBe("jetzt");
  });

  it("returns an empty string for invalid input", () => {
    expect(formatRelativeTime(null, opts)).toBe("");
    expect(formatRelativeTime("garbage", opts)).toBe("");
  });
});

describe("absolute date formatting", () => {
  const utc = { locale: "en-GB", timeZone: "UTC" };

  it("formats time, hour, date and date-time in a given zone", () => {
    expect(formatTime("2026-11-02T15:04:00Z", utc)).toBe("15:04");
    expect(formatHour("2026-11-02T15:00:00Z", utc)).toBe("15");
    expect(formatDate("2026-11-02T15:04:00Z", utc)).toBe("2 Nov 2026");
    expect(formatDateTime("2026-11-02T15:04:00Z", utc)).toBe("2 Nov 2026, 15:04");
  });

  it("returns empty strings for invalid input and survives unknown time zones", () => {
    expect(formatTime(null)).toBe("");
    expect(formatDate("x")).toBe("");
    expect(formatDateTime("2026-11-02T15:04:00Z", { locale: "en-GB", timeZone: "Not/AZone" })).not.toBe("");
  });
});

describe("units", () => {
  it("formats temperatures in °C and °F", () => {
    expect(formatTemperature(32.4)).toBe("32°C");
    expect(formatTemperature(32.6, { withUnit: false })).toBe("33°");
    expect(formatTemperature(-0.2)).toBe("0°C");
    expect(formatTemperature(100, { unit: "F" })).toBe("212°F");
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(formatTemperature(null)).toBe("");
    expect(formatTemperature(Number.NaN)).toBe("");
  });

  it("formats wind speed and percentages", () => {
    expect(formatWindSpeed(12.4)).toBe("12 km/h");
    expect(formatWindSpeed(3.46)).toBe("3.5 km/h");
    expect(formatWindSpeed(-1)).toBe("");
    expect(formatPercent(45.4)).toBe("45%");
    expect(formatPercent(140)).toBe("100%");
    expect(formatPercent(undefined)).toBe("");
  });

  it("pluralizes", () => {
    expect(pluralize(1, "event")).toBe("1 event");
    expect(pluralize(3, "event")).toBe("3 events");
    expect(pluralize(2, "person", "people")).toBe("2 people");
  });
});

describe("coordinates & strings", () => {
  it("formats coordinates with hemispheres", () => {
    expect(formatCoordinates(28.6139, 77.209)).toBe("28.61°N, 77.21°E");
    expect(formatCoordinates(-33.8688, -151.2093, 1)).toBe("33.9°S, 151.2°W");
    expect(formatCoordinates(null, 1)).toBe("");
  });

  it("truncates on word boundaries", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("The quick brown fox jumps over the lazy dog", 20)).toBe("The quick brown fox…");
    expect(truncate("  spaced\n\ttext  ", 50)).toBe("spaced text");
    expect(truncate(null, 5)).toBe("");
  });

  it("humanizes identifiers", () => {
    expect(humanize("extreme_heat")).toBe("Extreme heat");
    expect(humanize("HIGH-WIND")).toBe("High wind");
    expect(humanize("")).toBe("");
  });

  it("only allows http(s) URLs", () => {
    expect(safeHttpUrl("https://www.gdacs.org/report.aspx?eventid=1")).toBe(
      "https://www.gdacs.org/report.aspx?eventid=1",
    );
    expect(safeHttpUrl("http://example.org")).toBe("http://example.org/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("/relative")).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(hostnameOf("https://www.reliefweb.int/report/1")).toBe("reliefweb.int");
    expect(hostnameOf("javascript:void(0)")).toBe("");
  });
});
