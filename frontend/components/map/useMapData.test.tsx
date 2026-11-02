import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MapLayerId } from "@/components/map/layers";
import {
  errorResponse,
  jsonResponse,
  makeDisaster,
  makeIncident,
  makePlace,
  mockFetch,
  SWRTestProvider,
} from "@/components/map/test-fixtures";
import { toLayerStatusViews, useMapData, type MapDataParams } from "@/components/map/useMapData";

const center = { lat: 28.6139, lon: 77.209 };

function params(enabled: MapLayerId[], overrides: Partial<MapDataParams> = {}): MapDataParams {
  return { center, radiusKm: 5, enabled: new Set(enabled), active: true, ...overrides };
}

describe("useMapData", () => {
  it("loads every enabled layer in parallel with independent failures", async () => {
    let shelterFails = true;
    const { calls } = mockFetch({
      places: (call) => {
        const type = call.query.get("type");
        if (type === "shelter" && shelterFails) return errorResponse(502, "upstream_error", "Overpass timed out");
        return jsonResponse({ places: [makePlace({ id: `node/${type}`, type: type as "hospital" })] });
      },
      incidents: () => jsonResponse({ incidents: [makeIncident()] }),
      "alerts/disasters": () => jsonResponse({ events: [makeDisaster()], updated_at: new Date().toISOString() }),
    });

    const { result } = renderHook(() => useMapData(params(["hospital", "shelter", "incidents", "disasters"])), {
      wrapper: SWRTestProvider,
    });

    expect(result.current.places.hospital.status).toBe("loading");
    expect(result.current.places.police.status).toBe("off");

    await waitFor(() => expect(result.current.places.shelter.status).toBe("error"));
    await waitFor(() => expect(result.current.disasters.status).toBe("ready"));
    expect(result.current.places.hospital.status).toBe("ready");
    expect(result.current.places.hospital.items).toHaveLength(1);
    expect(result.current.incidents.items).toHaveLength(1);

    // Query parameters follow the contract (radius in metres for places, km elsewhere).
    const hospitalCall = calls.find((call) => call.path === "places" && call.query.get("type") === "hospital");
    expect(hospitalCall?.query.get("radius")).toBe("5000");
    const incidentCall = calls.find((call) => call.path === "incidents");
    expect(incidentCall?.query.get("radius_km")).toBe("5");
    expect(incidentCall?.query.get("status")).toBe("open");
    const disasterCall = calls.find((call) => call.path === "alerts/disasters");
    expect(Number(disasterCall?.query.get("radius_km"))).toBeGreaterThanOrEqual(300);
    // Disabled layers are never requested.
    expect(calls.some((call) => call.query.get("type") === "police")).toBe(false);

    const views = toLayerStatusViews(result.current, ["hospital", "shelter"]);
    expect(views.hospital).toMatchObject({ status: "ready", count: 1 });
    expect(views.shelter.status).toBe("error");
    expect(views.shelter.error).toBe("Overpass timed out");

    // Retrying only the failed layer recovers it.
    shelterFails = false;
    await act(async () => {
      result.current.places.shelter.retry();
    });
    await waitFor(() => expect(result.current.places.shelter.status).toBe("ready"));
    expect(result.current.places.shelter.items[0]?.id).toBe("node/shelter");
  });

  it("fetches nothing until active", () => {
    const { fetchMock } = mockFetch({});
    const { result } = renderHook(() => useMapData(params(["hospital", "incidents"], { active: false })), {
      wrapper: SWRTestProvider,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.places.hospital.status).toBe("off");
    expect(result.current.incidents.status).toBe("off");
  });
});
