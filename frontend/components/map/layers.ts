/**
 * Pure configuration and helpers for the relief map's data layers (`/map`).
 *
 * React- and Leaflet-free on purpose: the layer panel, the map, server pages and unit tests
 * all import it. Leaflet-specific marker icons live in `components/map/icons.ts`.
 *
 * Layers:
 * - five OpenStreetMap place layers (`GET /api/places?type=...`), one request per layer,
 * - community incidents (`GET /api/incidents?lat&lon&radius_km`),
 * - GDACS disasters (`GET /api/alerts/disasters?lat&lon&radius_km`).
 */

import type { DisasterEventType, LatLon, PlaceType } from "@/lib/types";

export type MapLayerId = PlaceType | "incidents" | "disasters";

export type MapLayerKind = "place" | "incidents" | "disasters";

export interface MapLayerDef {
  id: MapLayerId;
  kind: MapLayerKind;
  /** Plural label for the layer panel, e.g. "Hospitals". */
  label: string;
  /** Singular label for marker titles / popups, e.g. "Hospital". */
  singular: string;
  /** Marker colour (hex, used inside inline SVG). */
  color: string;
  /** Glyph drawn inside the marker and next to the toggle. */
  glyph: string;
  /** One-line description shown under the label (screen readers + tooltips). */
  description: string;
}

export const MAP_LAYERS: readonly MapLayerDef[] = [
  {
    id: "hospital",
    kind: "place",
    label: "Hospitals",
    singular: "Hospital",
    color: "#dc2626",
    glyph: "🏥",
    description: "Hospitals and clinics (OpenStreetMap)",
  },
  {
    id: "shelter",
    kind: "place",
    label: "Shelters",
    singular: "Shelter",
    color: "#16a34a",
    glyph: "⛺",
    description: "Shelters and emergency assembly points",
  },
  {
    id: "police",
    kind: "place",
    label: "Police",
    singular: "Police station",
    color: "#2563eb",
    glyph: "🚓",
    description: "Police stations",
  },
  {
    id: "fire_station",
    kind: "place",
    label: "Fire stations",
    singular: "Fire station",
    color: "#ea580c",
    glyph: "🚒",
    description: "Fire and rescue stations",
  },
  {
    id: "pharmacy",
    kind: "place",
    label: "Pharmacies",
    singular: "Pharmacy",
    color: "#0d9488",
    glyph: "💊",
    description: "Pharmacies and chemists",
  },
  {
    id: "incidents",
    kind: "incidents",
    label: "Incidents",
    singular: "Incident",
    color: "#f59e0b",
    glyph: "⚠️",
    description: "Open incidents reported by the community",
  },
  {
    id: "disasters",
    kind: "disasters",
    label: "Disasters",
    singular: "Disaster",
    color: "#9333ea",
    glyph: "🌐",
    description: "Live GDACS disaster alerts in the region",
  },
] as const;

export const MAP_LAYER_IDS: readonly MapLayerId[] = MAP_LAYERS.map((layer) => layer.id);

const LAYER_BY_ID: ReadonlyMap<MapLayerId, MapLayerDef> = new Map(
  MAP_LAYERS.map((layer) => [layer.id, layer]),
);

/** Layer definition by id (every id in {@link MapLayerId} is defined). */
export function getLayer(id: MapLayerId): MapLayerDef {
  const layer = LAYER_BY_ID.get(id);
  if (!layer) throw new Error(`Unknown map layer: ${id}`);
  return layer;
}

export function isMapLayerId(value: unknown): value is MapLayerId {
  return typeof value === "string" && LAYER_BY_ID.has(value as MapLayerId);
}

/** Layers enabled on first visit. Pharmacies are opt-in to keep the first load light. */
export const DEFAULT_ENABLED_LAYERS: readonly MapLayerId[] = [
  "hospital",
  "shelter",
  "police",
  "fire_station",
  "incidents",
  "disasters",
];

// ---------------------------------------------------------------------------------------
// Radius
// ---------------------------------------------------------------------------------------

/** Search radius choices offered by the map (kilometres). */
export const MAP_RADIUS_OPTIONS_KM = [1, 2, 5, 10, 20] as const;
export type MapRadiusKm = (typeof MAP_RADIUS_OPTIONS_KM)[number];
export const DEFAULT_MAP_RADIUS_KM: MapRadiusKm = 5;

export function isMapRadius(value: unknown): value is MapRadiusKm {
  return (MAP_RADIUS_OPTIONS_KM as readonly unknown[]).includes(value);
}

/**
 * GDACS events are regional (an earthquake epicentre or cyclone centroid can be hundreds of
 * km from the people affected), so the disasters layer never searches a smaller area than
 * this, whatever the local radius is.
 */
export const DISASTER_MIN_RADIUS_KM = 300;

export function disasterRadiusKm(radiusKm: number): number {
  return Math.max(radiusKm, DISASTER_MIN_RADIUS_KM);
}

/** Overpass radius in metres for a radius in km (backend clamps to 500–20000 m). */
export function placesRadiusMeters(radiusKm: number): number {
  return Math.round(Math.min(20, Math.max(0.5, radiusKm)) * 1000);
}

// ---------------------------------------------------------------------------------------
// Persistence (per-viewer convenience only: localStorage may be unavailable)
// ---------------------------------------------------------------------------------------

export const MAP_PREFS_STORAGE_KEY = "resq_map_prefs";

export interface MapPrefs {
  layers: MapLayerId[];
  radiusKm: MapRadiusKm;
}

export const DEFAULT_MAP_PREFS: Readonly<MapPrefs> = Object.freeze({
  layers: [...DEFAULT_ENABLED_LAYERS],
  radiusKm: DEFAULT_MAP_RADIUS_KM,
});

/** Keeps only known layer ids, de-duplicated, in panel order. */
export function sanitizeLayers(value: unknown): MapLayerId[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter(isMapLayerId));
  return MAP_LAYER_IDS.filter((id) => wanted.has(id));
}

/** Parses stored preferences, falling back field-by-field to the defaults. */
export function parseMapPrefs(raw: string | null | undefined): MapPrefs {
  if (!raw) return { ...DEFAULT_MAP_PREFS, layers: [...DEFAULT_MAP_PREFS.layers] };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof MapPrefs, unknown>> | null;
    const layers = Array.isArray(parsed?.layers)
      ? sanitizeLayers(parsed.layers)
      : [...DEFAULT_MAP_PREFS.layers];
    const radiusKm = isMapRadius(parsed?.radiusKm) ? parsed.radiusKm : DEFAULT_MAP_RADIUS_KM;
    return { layers, radiusKm };
  } catch {
    return { ...DEFAULT_MAP_PREFS, layers: [...DEFAULT_MAP_PREFS.layers] };
  }
}

export function loadMapPrefs(): MapPrefs {
  try {
    return parseMapPrefs(window.localStorage.getItem(MAP_PREFS_STORAGE_KEY));
  } catch {
    return parseMapPrefs(null);
  }
}

export function saveMapPrefs(prefs: MapPrefs): void {
  try {
    window.localStorage.setItem(
      MAP_PREFS_STORAGE_KEY,
      JSON.stringify({ layers: sanitizeLayers(prefs.layers), radiusKm: prefs.radiusKm }),
    );
  } catch {
    // Private mode / blocked storage: preferences simply are not remembered.
  }
}

// ---------------------------------------------------------------------------------------
// Coordinates & links
// ---------------------------------------------------------------------------------------

/** Reads a single string value from Next.js `searchParams`. */
export function firstParam(value: string | string[] | null | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? undefined;
}

/**
 * Validates an incident id taken from a URL (`?focus=`, route params) before it is used in
 * an API path: non-empty, at most 64 characters (backend limit), no whitespace or slashes.
 */
export function sanitizeIncidentId(value: string | string[] | null | undefined): string | null {
  const raw = firstParam(value)?.trim();
  if (!raw || raw.length > 64 || /[\s/\\?#]/.test(raw)) return null;
  return raw;
}

export function isValidLatLon(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

/**
 * Parses `?lat=..&lon=..` style values (strings from search params). Returns `null` unless
 * both are present and in range.
 */
export function parseLatLonParams(
  lat: string | string[] | null | undefined,
  lon: string | string[] | null | undefined,
): LatLon | null {
  const first = (value: string | string[] | null | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  const rawLat = first(lat);
  const rawLon = first(lon);
  if (!rawLat || !rawLon) return null;
  const parsedLat = Number(rawLat);
  const parsedLon = Number(rawLon);
  return isValidLatLon(parsedLat, parsedLon) ? { lat: parsedLat, lon: parsedLon } : null;
}

/** Rounds to 5 decimals (≈1 m) for URLs and API bodies. */
export function roundTo5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** Link to the incident report form pre-filled with a location. */
export function reportIncidentHref(point: LatLon): string {
  return `/incidents/new?lat=${roundTo5(point.lat)}&lon=${roundTo5(point.lon)}`;
}

/** Link to the relief map centred on a point. */
export function mapHref(point: LatLon): string {
  return `/map?lat=${roundTo5(point.lat)}&lon=${roundTo5(point.lon)}`;
}

/** Sign-in link that returns to `callbackPath` afterwards. */
export function signInHref(callbackPath: string): string {
  return `/login?callbackUrl=${encodeURIComponent(callbackPath)}`;
}

/** Marker glyphs for GDACS event types. */
export const DISASTER_EVENT_GLYPHS: Record<DisasterEventType, string> = {
  EQ: "🌍",
  TC: "🌀",
  FL: "🌊",
  VO: "🌋",
  DR: "☀️",
  WF: "🔥",
};

export function disasterGlyph(eventType: string): string {
  return DISASTER_EVENT_GLYPHS[eventType as DisasterEventType] ?? "⚠️";
}

/** Colours for GDACS alert levels (marker fill). */
export const ALERT_LEVEL_COLORS = {
  green: "#16a34a",
  orange: "#ea580c",
  red: "#dc2626",
} as const;
