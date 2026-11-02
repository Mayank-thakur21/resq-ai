import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReliefMapProps } from "@/components/map/ReliefMap";

// Leaflet cannot run in jsdom: the dynamically imported ReliefMap is replaced by a stub that
// records its props and exposes "Search this area".
const mapStub = vi.hoisted(() => ({ props: null as null | ReliefMapProps }));
vi.mock("next/dynamic", async () => {
  const ReactModule = await import("react");
  return {
    default: () =>
      function ReliefMapStub(props: ReliefMapProps) {
        mapStub.props = props;
        const markers =
          Object.values(props.places).reduce((sum, list) => sum + (list?.length ?? 0), 0) +
          props.incidents.length +
          props.disasters.length;
        return ReactModule.createElement(
          "div",
          { "data-testid": "relief-map" },
          ReactModule.createElement("span", null, `markers:${markers}`),
          ReactModule.createElement(
            "button",
            { type: "button", onClick: () => props.onSearchHere({ lat: 19.076, lon: 72.8777 }) },
            "stub search here",
          ),
        );
      },
  };
});

import MapView from "@/app/map/MapView";
import { MAP_PREFS_STORAGE_KEY } from "@/components/map/layers";
import {
  jsonResponse,
  makeDisaster,
  makeIncident,
  makePlace,
  mockFetch,
  SWRTestProvider,
  type RecordedCall,
} from "@/components/map/test-fixtures";
import { DEFAULT_COORDS } from "@/lib/geo";

function renderMap(initialCenter: { lat: number; lon: number } | null = null) {
  return render(
    <SWRTestProvider>
      <MapView initialCenter={initialCenter} />
    </SWRTestProvider>,
  );
}

function placeTypes(calls: RecordedCall[]): string[] {
  return [...new Set(calls.filter((call) => call.path === "places").map((call) => call.query.get("type") ?? ""))].sort();
}

function routes(empty = false) {
  return {
    places: (call: RecordedCall) =>
      jsonResponse({
        places: empty ? [] : [makePlace({ id: `node/${call.query.get("type")}`, type: call.query.get("type") as "hospital" })],
      }),
    incidents: () => jsonResponse({ incidents: empty ? [] : [makeIncident()] }),
    "alerts/disasters": () => jsonResponse({ events: empty ? [] : [makeDisaster()], updated_at: new Date().toISOString() }),
  };
}

afterEach(() => {
  window.localStorage.clear();
  mapStub.props = null;
});

describe("MapView", () => {
  it("falls back to the default location with a visible notice and loads the default layers", async () => {
    const { calls } = mockFetch(routes());
    renderMap();

    expect(await screen.findByTestId("relief-map")).toBeInTheDocument();
    expect(screen.getByText(/Using default location — enable location for local results/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("markers:6")).toBeInTheDocument());

    expect(placeTypes(calls)).toEqual(["fire_station", "hospital", "police", "shelter"]);
    expect(mapStub.props?.center).toEqual({ lat: DEFAULT_COORDS.lat, lon: DEFAULT_COORDS.lon });
    // The fallback location is never pre-filled into a report.
    expect(screen.getByRole("link", { name: "Report incident" })).toHaveAttribute("href", "/incidents/new");
    // Desktop panel shows per-layer counts.
    expect(screen.getAllByText("1 hospitals found").length).toBeGreaterThan(0);
  });

  it("toggles layers, remembers the choice and refetches with a new radius", async () => {
    const { calls } = mockFetch(routes());
    const user = userEvent.setup();
    renderMap();
    await screen.findByTestId("relief-map");

    const [pharmacies] = screen.getAllByRole("checkbox", { name: /Pharmacies/ });
    await user.click(pharmacies!);
    await waitFor(() => expect(placeTypes(calls)).toContain("pharmacy"));
    expect(JSON.parse(window.localStorage.getItem(MAP_PREFS_STORAGE_KEY) ?? "{}").layers).toContain("pharmacy");

    const [radius] = screen.getAllByRole("combobox", { name: "Search radius" });
    await user.selectOptions(radius!, "20");
    await waitFor(() =>
      expect(calls.some((call) => call.path === "places" && call.query.get("radius") === "20000")).toBe(true),
    );
    expect(mapStub.props?.radiusKm).toBe(20);
  });

  it("applies stored preferences on load", async () => {
    window.localStorage.setItem(MAP_PREFS_STORAGE_KEY, JSON.stringify({ layers: ["hospital"], radiusKm: 2 }));
    const { calls } = mockFetch(routes());
    renderMap();
    await waitFor(() => expect(screen.getByText("markers:1")).toBeInTheDocument());
    expect(placeTypes(calls)).toEqual(["hospital"]);
    expect(calls.some((call) => call.path === "incidents")).toBe(false);
    expect(calls.find((call) => call.path === "places")?.query.get("radius")).toBe("2000");
  });

  it("offers a wider search when nothing is found", async () => {
    mockFetch(routes(true));
    const user = userEvent.setup();
    renderMap();

    expect(await screen.findByText("Nothing found within 5 km")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Search 10 km" }));
    expect(await screen.findByText("Nothing found within 10 km")).toBeInTheDocument();
  });

  it("searches another area from the map and comes back to the user", async () => {
    const { calls } = mockFetch(routes());
    const user = userEvent.setup();
    renderMap();
    await screen.findByTestId("relief-map");

    await user.click(screen.getByRole("button", { name: "stub search here" }));
    expect(await screen.findByText(/Showing the area around 19\.08°N, 72\.88°E/)).toBeInTheDocument();
    // A deliberately chosen area is pre-filled.
    expect(screen.getByRole("link", { name: "Report incident" })).toHaveAttribute(
      "href",
      "/incidents/new?lat=19.076&lon=72.8777",
    );
    await waitFor(() => expect(calls.some((call) => call.query.get("lat") === "19.076")).toBe(true));

    await user.click(screen.getByRole("button", { name: "Back to my location" }));
    expect(mapStub.props?.center).toEqual({ lat: DEFAULT_COORDS.lat, lon: DEFAULT_COORDS.lon });
  });

  it("centres on the point given in the URL without waiting for a location", async () => {
    mockFetch(routes());
    renderMap({ lat: -1.2921, lon: 36.8219 });
    expect(await screen.findByTestId("relief-map")).toBeInTheDocument();
    expect(mapStub.props?.center).toEqual({ lat: -1.2921, lon: 36.8219 });
    expect(screen.getByRole("button", { name: "Back to my location" })).toBeInTheDocument();
  });
});
