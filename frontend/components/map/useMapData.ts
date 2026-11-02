/**
 * Data for the relief map: one SWR request per enabled layer, all in parallel, each with its
 * own loading / error / retry state, so a failing layer (e.g. Overpass timing out for
 * shelters) never blanks the others.
 *
 * Client-only hook.
 */

import useSWR, { type SWRResponse } from "swr";

import type { LayerStatusView } from "@/components/MapLayers";
import {
  disasterRadiusKm,
  placesRadiusMeters,
  type MapLayerId,
} from "@/components/map/layers";
import { getErrorMessage, swrKeys } from "@/lib/api";
import type {
  DisasterEvent,
  DisasterEventsResponse,
  Incident,
  IncidentsResponse,
  LatLon,
  Place,
  PlacesResponse,
  PlaceType,
} from "@/lib/types";

export type LayerStatus = "off" | "loading" | "ready" | "error";

export interface LayerData<T> {
  status: LayerStatus;
  /** Current items (empty unless `ready`; stale items are kept while refreshing). */
  items: T[];
  error: unknown;
  /** A background refresh (or a new radius) is in flight while items are shown. */
  refreshing: boolean;
  retry: () => void;
  /**
   * The raw response body (`undefined` until loaded). Carries the service worker's "saved
   * copy" marker, read by `OfflineDataNotice` / `getResponseMeta`.
   */
  response?: unknown;
}

export interface MapDataParams {
  center: LatLon;
  radiusKm: number;
  enabled: ReadonlySet<MapLayerId>;
  /** False while the page is still waiting for a location: nothing is fetched. */
  active: boolean;
}

export interface MapData {
  places: Record<PlaceType, LayerData<Place>>;
  incidents: LayerData<Incident>;
  disasters: LayerData<DisasterEvent>;
}

/** Incidents change quickly; refresh them every minute while the map is open. */
const INCIDENTS_REFRESH_MS = 60_000;
/** The backend caches GDACS for 10 minutes. */
const DISASTERS_REFRESH_MS = 10 * 60_000;

const EMPTY: never[] = [];

function toLayerData<R, T>(
  enabled: boolean,
  swr: SWRResponse<R>,
  select: (data: R) => T[] | undefined,
): LayerData<T> {
  const retry = () => {
    void swr.mutate();
  };
  if (!enabled) {
    return { status: "off", items: EMPTY, error: undefined, refreshing: false, retry };
  }
  const items = swr.data === undefined ? undefined : (select(swr.data) ?? EMPTY);
  if (items === undefined) {
    return {
      status: swr.error ? "error" : "loading",
      items: EMPTY,
      error: swr.error,
      refreshing: false,
      retry,
    };
  }
  return {
    status: "ready",
    items,
    error: swr.error,
    refreshing: swr.isValidating,
    retry,
    response: swr.data,
  };
}

function usePlaceLayer(type: PlaceType, params: MapDataParams): LayerData<Place> {
  const enabled = params.active && params.enabled.has(type);
  const swr = useSWR<PlacesResponse>(
    enabled
      ? swrKeys.places({
          lat: params.center.lat,
          lon: params.center.lon,
          type,
          radius: placesRadiusMeters(params.radiusKm),
        })
      : null,
  );
  return toLayerData(enabled, swr, (data) => data.places);
}

export function useMapData(params: MapDataParams): MapData {
  // One hook call per place type, in a fixed order (rules of hooks).
  const hospital = usePlaceLayer("hospital", params);
  const shelter = usePlaceLayer("shelter", params);
  const police = usePlaceLayer("police", params);
  const fireStation = usePlaceLayer("fire_station", params);
  const pharmacy = usePlaceLayer("pharmacy", params);

  const incidentsEnabled = params.active && params.enabled.has("incidents");
  const incidentsSwr = useSWR<IncidentsResponse>(
    incidentsEnabled
      ? swrKeys.incidents({
          lat: params.center.lat,
          lon: params.center.lon,
          radius_km: params.radiusKm,
          status: "open",
          limit: 200,
        })
      : null,
    { refreshInterval: INCIDENTS_REFRESH_MS },
  );

  const disastersEnabled = params.active && params.enabled.has("disasters");
  const disastersSwr = useSWR<DisasterEventsResponse>(
    disastersEnabled
      ? swrKeys.disasters({
          lat: params.center.lat,
          lon: params.center.lon,
          radius_km: disasterRadiusKm(params.radiusKm),
          limit: 100,
        })
      : null,
    { refreshInterval: DISASTERS_REFRESH_MS },
  );

  return {
    places: {
      hospital,
      shelter,
      police,
      fire_station: fireStation,
      pharmacy,
    },
    incidents: toLayerData(incidentsEnabled, incidentsSwr, (data) => data.incidents),
    disasters: toLayerData(disastersEnabled, disastersSwr, (data) => data.events),
  };
}

/** Raw responses of every layer (for the "showing saved data" notice). */
export function layerResponses(data: MapData): unknown[] {
  return [...Object.values(data.places), data.incidents, data.disasters].map((layer) => layer.response);
}

/** The layer's data by panel id. */
export function layerData(data: MapData, id: MapLayerId): LayerData<unknown> {
  if (id === "incidents") return data.incidents;
  if (id === "disasters") return data.disasters;
  return data.places[id];
}

/** Converts hook state into what the `MapLayers` panel renders for each layer. */
export function toLayerStatusViews(
  data: MapData,
  ids: readonly MapLayerId[],
  notes: Partial<Record<MapLayerId, string>> = {},
): Record<MapLayerId, LayerStatusView> {
  const views = {} as Record<MapLayerId, LayerStatusView>;
  for (const id of ids) {
    const layer = layerData(data, id);
    views[id] = {
      status: layer.status,
      count: layer.status === "ready" ? layer.items.length : undefined,
      refreshing: layer.refreshing,
      error:
        layer.status === "error"
          ? getErrorMessage(layer.error, "Couldn't load this layer.")
          : layer.status === "ready" && layer.error
            ? "Couldn't refresh — showing earlier results."
            : undefined,
      onRetry: layer.status === "error" || layer.error ? layer.retry : undefined,
      note: notes[id],
    };
  }
  return views;
}
