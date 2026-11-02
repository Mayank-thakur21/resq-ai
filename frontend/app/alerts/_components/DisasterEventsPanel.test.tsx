import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DisasterEventsPanel } from "@/app/alerts/_components/DisasterEventsPanel";
import { fetcher } from "@/lib/api";
import { DEFAULT_COORDS, type GeolocationState } from "@/lib/geo";
import type { DisasterEvent } from "@/lib/types";

function renderWithSWR(ui: React.ReactElement) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fetcher,
        dedupingInterval: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        keepPreviousData: true,
      }}
    >
      {ui}
    </SWRConfig>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function event(overrides: Partial<DisasterEvent> = {}): DisasterEvent {
  return {
    id: "EQ-1",
    source: "gdacs",
    event_type: "EQ",
    event_type_label: "Earthquake",
    title: "M 6.4 earthquake near Kathmandu",
    description: "Strong shaking reported across the valley.",
    alert_level: "red",
    severity_text: "Magnitude 6.4M, Depth 12km",
    country: "Nepal",
    lat: 27.7,
    lon: 85.3,
    from_date: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    to_date: new Date(Date.now() - 30 * 60_000).toISOString(),
    is_current: true,
    url: "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1",
    distance_km: null,
    ...overrides,
  };
}

function geoState(overrides: Partial<GeolocationState> = {}): GeolocationState {
  return { status: "ready", coords: { lat: 28.6139, lon: 77.209, accuracy: 20 }, retry: vi.fn(), ...overrides };
}

let events: DisasterEvent[] | "error";
let fetchMock: ReturnType<typeof vi.fn>;

function requestedUrls(): URL[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost"));
}

function lastParams(): URLSearchParams {
  const urls = requestedUrls();
  return urls[urls.length - 1].searchParams;
}

beforeEach(() => {
  events = [
    event(),
    event({
      id: "TC-2",
      event_type: "TC",
      event_type_label: "Tropical Cyclone",
      title: "Cyclone Dana",
      alert_level: "orange",
      country: "India",
      lat: 20,
      lon: 87,
      url: "javascript:alert(1)",
    }),
  ];
  fetchMock = vi.fn(async () =>
    events === "error"
      ? jsonResponse({ error: { code: "upstream_error", message: "GDACS is unavailable", request_id: "" } }, 502)
      : jsonResponse({ events, updated_at: new Date().toISOString() }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("DisasterEventsPanel", () => {
  it("lists events worldwide with level badges, safe links and client-side distances", async () => {
    renderWithSWR(<DisasterEventsPanel geo={geoState()} />);

    const card = (await screen.findByRole("heading", { name: "M 6.4 earthquake near Kathmandu" })).closest("article")!;
    expect(within(card).getByText("red")).toBeInTheDocument();
    expect(within(card).getByText("Magnitude 6.4M, Depth 12km")).toBeInTheDocument();
    expect(within(card).getByText("Ongoing")).toBeInTheDocument();
    expect(within(card).getByText(/km away/)).toBeInTheDocument();
    const report = within(card).getByRole("link", { name: /GDACS report/ });
    expect(report).toHaveAttribute("rel", "noopener noreferrer");
    expect(report).toHaveAttribute("target", "_blank");

    // Unsafe report URL => no report link (the maps link remains).
    const cyclone = screen.getByRole("heading", { name: "Cyclone Dana" }).closest("article")!;
    expect(within(cyclone).queryByRole("link", { name: /GDACS report/ })).not.toBeInTheDocument();
    expect(within(cyclone).getByRole("link", { name: /Open in Maps/ })).toHaveAttribute(
      "href",
      "https://maps.google.com/?q=20.000000,87.000000",
    );

    expect(screen.getByText("2 events")).toBeInTheDocument();
    const params = lastParams();
    expect(params.get("min_level")).toBe("green");
    expect(params.get("limit")).toBe("100");
    expect(params.has("lat")).toBe(false);
  });

  it("filters by event type chips and minimum level", async () => {
    const user = userEvent.setup();
    renderWithSWR(<DisasterEventsPanel geo={geoState()} />);
    await screen.findByText("Cyclone Dana");

    await user.click(screen.getByRole("button", { name: "Earthquake" }));
    await waitFor(() => expect(lastParams().get("types")).toBe("EQ"));
    expect(screen.getByRole("button", { name: "Earthquake" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All types" })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: "Flood" }));
    await waitFor(() => expect(lastParams().get("types")).toBe("EQ,FL"));

    await user.selectOptions(screen.getByLabelText("Minimum alert level"), "red");
    await waitFor(() => expect(lastParams().get("min_level")).toBe("red"));

    await user.click(screen.getByRole("button", { name: "All types" }));
    await waitFor(() => expect(lastParams().has("types")).toBe(false));
  });

  it("searches near the device location", async () => {
    const user = userEvent.setup();
    renderWithSWR(<DisasterEventsPanel geo={geoState()} />);
    await screen.findByText("Cyclone Dana");

    await user.selectOptions(screen.getByLabelText("Near me"), "500");
    await waitFor(() => expect(lastParams().get("radius_km")).toBe("500"));
    expect(lastParams().get("lat")).toBe("28.6139");
    expect(lastParams().get("lon")).toBe("77.209");
    expect(screen.queryByText(/Using default location/)).not.toBeInTheDocument();
  });

  it("falls back to the default location with a notice when location is denied", async () => {
    const user = userEvent.setup();
    const geo = geoState({ status: "denied", coords: undefined, error: "Location permission was denied." });
    renderWithSWR(<DisasterEventsPanel geo={geo} />);
    await screen.findByText("Cyclone Dana");

    await user.selectOptions(screen.getByLabelText("Near me"), "1000");
    expect(await screen.findByText("Using default location — enable location for local results")).toBeInTheDocument();
    await waitFor(() => expect(lastParams().get("radius_km")).toBe("1000"));
    expect(Number(lastParams().get("lat"))).toBeCloseTo(DEFAULT_COORDS.lat, 3);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(geo.retry).toHaveBeenCalledTimes(1);
  });

  it("waits for the location before searching nearby", async () => {
    const user = userEvent.setup();
    renderWithSWR(<DisasterEventsPanel geo={geoState({ status: "locating", coords: undefined })} />);
    await screen.findByText("Cyclone Dana");
    const before = fetchMock.mock.calls.length;

    await user.selectOptions(screen.getByLabelText("Near me"), "250");
    expect(await screen.findByText("Finding your location…")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("stops waiting for an unanswered location prompt after the grace period", async () => {
    // Regression: "Near me" showed "Finding your location…" forever while the browser's
    // permission prompt stayed unanswered (geolocation remains "locating").
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const view = renderWithSWR(<DisasterEventsPanel geo={geoState({ status: "locating", coords: undefined })} />);
      await screen.findByText("Cyclone Dana");
      await user.selectOptions(screen.getByLabelText("Near me"), "250");
      expect(screen.getByText("Finding your location…")).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(6_500);
      expect(await screen.findByText(/Using default location/)).toBeInTheDocument();
      await waitFor(() => expect(lastParams().get("lat")).toBe(String(DEFAULT_COORDS.lat)));
      expect(lastParams().get("radius_km")).toBe("250");

      // A late fix replaces the default location.
      view.rerender(
        <SWRConfig value={{ provider: () => new Map(), fetcher, dedupingInterval: 0, shouldRetryOnError: false }}>
          <DisasterEventsPanel geo={geoState({ coords: { lat: 19.076, lon: 72.8777, accuracy: 30 } })} />
        </SWRConfig>,
      );
      await waitFor(() => expect(lastParams().get("lat")).toBe("19.076"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels data the service worker served from its cache", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ events, updated_at: new Date().toISOString() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-ResQ-Offline": "1",
          "X-ResQ-Cached-At": new Date(Date.now() - 2 * 3600_000).toISOString(),
        },
      }),
    );
    renderWithSWR(<DisasterEventsPanel geo={geoState()} />);
    expect(await screen.findByText(/Showing saved data from 2 hours ago/)).toBeInTheDocument();
  });

  it("shows an empty state that can clear the filters", async () => {
    const user = userEvent.setup();
    events = [];
    renderWithSWR(<DisasterEventsPanel geo={geoState()} />);
    expect(await screen.findByText("No active disaster events")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Minimum alert level"), "orange");
    expect(await screen.findByText("No events match these filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Clear filters/ }));
    await waitFor(() => expect(lastParams().get("min_level")).toBe("green"));
    expect(screen.getByLabelText("Minimum alert level")).toHaveValue("green");
  });

  it("shows an ErrorState with retry", async () => {
    const user = userEvent.setup();
    events = "error";
    renderWithSWR(<DisasterEventsPanel geo={geoState()} />);
    expect(await screen.findByText("Disaster events are unavailable")).toBeInTheDocument();
    expect(screen.getByText("GDACS is unavailable")).toBeInTheDocument();

    events = [event()];
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("M 6.4 earthquake near Kathmandu")).toBeInTheDocument();
  });

  it("pins, highlights and focuses the event a push notification linked to (?event=)", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderWithSWR(<DisasterEventsPanel geo={geoState()} focusEventId="TC-2" />);

    const label = await screen.findByText("From your notification");
    const cyclone = screen.getByRole("heading", { name: "Cyclone Dana" }).closest("article")!;
    expect(cyclone).toContainElement(label);
    // Pinned first even though the backend sorted the red earthquake first.
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings[0]).toBe("Cyclone Dana");
    await waitFor(() => expect(document.activeElement).toBe(cyclone.closest("li")));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/no longer in the GDACS feed/)).not.toBeInTheDocument();
  });

  it("explains when the linked event is not in the feed", async () => {
    renderWithSWR(<DisasterEventsPanel geo={geoState()} focusEventId="FL-999" />);
    expect(await screen.findByText("The alert from your notification is no longer in the GDACS feed")).toBeInTheDocument();
    expect(screen.queryByText("From your notification")).not.toBeInTheDocument();
  });
});
