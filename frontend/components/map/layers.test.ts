import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ENABLED_LAYERS,
  DEFAULT_MAP_RADIUS_KM,
  DISASTER_MIN_RADIUS_KM,
  MAP_LAYER_IDS,
  MAP_LAYERS,
  MAP_PREFS_STORAGE_KEY,
  disasterGlyph,
  disasterRadiusKm,
  getLayer,
  loadMapPrefs,
  mapHref,
  parseLatLonParams,
  parseMapPrefs,
  placesRadiusMeters,
  reportIncidentHref,
  sanitizeIncidentId,
  sanitizeLayers,
  saveMapPrefs,
  signInHref,
} from "@/components/map/layers";
import { PLACE_TYPES } from "@/lib/types";

afterEach(() => {
  window.localStorage.clear();
});

describe("layer definitions", () => {
  it("defines every place type plus incidents and disasters, each with a hex colour", () => {
    expect(MAP_LAYER_IDS).toEqual([...PLACE_TYPES, "incidents", "disasters"]);
    for (const layer of MAP_LAYERS) {
      expect(layer.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(layer.glyph).not.toBe("");
      expect(getLayer(layer.id)).toBe(layer);
    }
  });

  it("falls back to a warning glyph for unknown GDACS types", () => {
    expect(disasterGlyph("TC")).toBe("🌀");
    expect(disasterGlyph("XX")).toBe("⚠️");
  });
});

describe("sanitizeLayers", () => {
  it("drops unknown ids, removes duplicates and keeps panel order", () => {
    expect(sanitizeLayers(["disasters", "nope", "hospital", "hospital", 3])).toEqual(["hospital", "disasters"]);
  });

  it("returns an empty list for non-arrays", () => {
    expect(sanitizeLayers("hospital")).toEqual([]);
    expect(sanitizeLayers(null)).toEqual([]);
  });
});

describe("map preferences", () => {
  it("uses defaults for missing or corrupt data", () => {
    expect(parseMapPrefs(null)).toEqual({ layers: [...DEFAULT_ENABLED_LAYERS], radiusKm: DEFAULT_MAP_RADIUS_KM });
    expect(parseMapPrefs("{not json")).toEqual({ layers: [...DEFAULT_ENABLED_LAYERS], radiusKm: DEFAULT_MAP_RADIUS_KM });
  });

  it("validates each field independently", () => {
    expect(parseMapPrefs(JSON.stringify({ layers: ["pharmacy"], radiusKm: 7 }))).toEqual({
      layers: ["pharmacy"],
      radiusKm: DEFAULT_MAP_RADIUS_KM,
    });
    // An empty selection is a valid choice (user hid every layer).
    expect(parseMapPrefs(JSON.stringify({ layers: [], radiusKm: 20 }))).toEqual({ layers: [], radiusKm: 20 });
  });

  it("round-trips through localStorage", () => {
    saveMapPrefs({ layers: ["incidents", "hospital"], radiusKm: 10 });
    expect(JSON.parse(window.localStorage.getItem(MAP_PREFS_STORAGE_KEY) ?? "{}")).toEqual({
      layers: ["hospital", "incidents"],
      radiusKm: 10,
    });
    expect(loadMapPrefs()).toEqual({ layers: ["hospital", "incidents"], radiusKm: 10 });
  });

  it("never throws when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    expect(() => saveMapPrefs({ layers: ["hospital"], radiusKm: 5 })).not.toThrow();
    expect(loadMapPrefs().radiusKm).toBe(DEFAULT_MAP_RADIUS_KM);
  });
});

describe("radius helpers", () => {
  it("never searches disasters in less than the regional minimum", () => {
    expect(disasterRadiusKm(5)).toBe(DISASTER_MIN_RADIUS_KM);
    expect(disasterRadiusKm(1000)).toBe(1000);
  });

  it("converts km to the metres the places API accepts (500–20000)", () => {
    expect(placesRadiusMeters(5)).toBe(5000);
    expect(placesRadiusMeters(0.1)).toBe(500);
    expect(placesRadiusMeters(50)).toBe(20_000);
  });
});

describe("URL helpers", () => {
  it("parses valid lat/lon search params", () => {
    expect(parseLatLonParams("28.6139", "77.209")).toEqual({ lat: 28.6139, lon: 77.209 });
    expect(parseLatLonParams(["10", "11"], ["20"])).toEqual({ lat: 10, lon: 20 });
  });

  it("rejects missing, malformed and out-of-range values", () => {
    expect(parseLatLonParams(undefined, "77")).toBeNull();
    expect(parseLatLonParams("abc", "77")).toBeNull();
    expect(parseLatLonParams("91", "77")).toBeNull();
    expect(parseLatLonParams("28", "-181")).toBeNull();
    expect(parseLatLonParams(" ", "77")).toBeNull();
  });

  it("builds report / map / sign-in links", () => {
    expect(reportIncidentHref({ lat: 28.613912345, lon: 77.20901234 })).toBe("/incidents/new?lat=28.61391&lon=77.20901");
    expect(mapHref({ lat: -1.5, lon: 36.8 })).toBe("/map?lat=-1.5&lon=36.8");
    expect(signInHref("/incidents?focus=a b")).toBe("/login?callbackUrl=%2Fincidents%3Ffocus%3Da%20b");
  });

  it("only accepts plausible incident ids", () => {
    expect(sanitizeIncidentId("3f1c2a9e-1b2c-4d5e-8f90-123456789abc")).toBe("3f1c2a9e-1b2c-4d5e-8f90-123456789abc");
    expect(sanitizeIncidentId(["  abc  "])).toBe("abc");
    expect(sanitizeIncidentId("")).toBeNull();
    expect(sanitizeIncidentId("a/b")).toBeNull();
    expect(sanitizeIncidentId("x".repeat(65))).toBeNull();
    expect(sanitizeIncidentId(undefined)).toBeNull();
  });
});
