import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("@/app/map/MapView", () => ({
  default: ({ initialCenter }: { initialCenter: { lat: number; lon: number } | null }) => (
    <div data-testid="map-view">{initialCenter ? `${initialCenter.lat},${initialCenter.lon}` : "device"}</div>
  ),
}));

import MapRoute from "@/app/map/MapRoute";
import MapPage from "@/app/map/page";
import IncidentsRoute from "@/app/incidents/IncidentsRoute";
import IncidentsPage from "@/app/incidents/page";

vi.mock("@/app/incidents/IncidentsView", () => ({
  IncidentsView: ({ focusId }: { focusId: string | null }) => <div data-testid="incidents-view">{focusId ?? "none"}</div>,
}));

beforeEach(() => {
  navigation.search = "";
});

describe("static /map and /incidents shells", () => {
  it("server pages are synchronous and ignore searchParams (so Next.js prerenders them)", () => {
    // Regression: awaiting `searchParams` made both pages dynamic + no-store, so the service
    // worker could never serve them offline.
    for (const page of [MapPage, IncidentsPage]) {
      expect(page.constructor.name).not.toBe("AsyncFunction");
      expect(page.length).toBe(0);
    }
  });

  it("MapRoute reads the centre from the query on the client", () => {
    navigation.search = "lat=19.076&lon=72.8777";
    render(<MapRoute />);
    expect(screen.getByTestId("map-view")).toHaveTextContent("19.076,72.8777");
  });

  it("MapRoute falls back to the device location for missing or invalid coordinates", () => {
    navigation.search = "lat=999&lon=abc";
    render(<MapRoute />);
    expect(screen.getByTestId("map-view")).toHaveTextContent("device");
  });

  it("IncidentsRoute passes a sanitised ?focus id", () => {
    navigation.search = "focus=abc-123";
    const { unmount } = render(<IncidentsRoute />);
    expect(screen.getByTestId("incidents-view")).toHaveTextContent("abc-123");
    unmount();
    navigation.search = "focus=../../etc";
    render(<IncidentsRoute />);
    expect(screen.getByTestId("incidents-view")).toHaveTextContent("none");
  });
});
