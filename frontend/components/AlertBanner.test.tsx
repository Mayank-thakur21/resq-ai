import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AlertBanner,
  buildAlertCandidates,
  DISMISSED_ALERTS_STORAGE_KEY,
  loadDismissedAlerts,
} from "@/components/AlertBanner";
import { fetcher } from "@/lib/api";
import type { DisasterEvent, WeatherResponse } from "@/lib/types";

function renderWithSWR(ui: React.ReactElement) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fetcher,
        dedupingInterval: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
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
    title: "M 6.1 earthquake in Nepal",
    description: "",
    alert_level: "orange",
    severity_text: "Magnitude 6.1M, Depth 10km",
    country: "Nepal",
    lat: 28,
    lon: 84,
    from_date: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    to_date: null,
    is_current: true,
    url: "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1",
    distance_km: 300,
    ...overrides,
  };
}

function weather(overrides: Partial<WeatherResponse> = {}): WeatherResponse {
  return {
    weather: {
      temperature: 30,
      feels_like: 31,
      humidity: 50,
      wind_speed_kmh: 10,
      description: "clear sky",
      icon: "01d",
      weather_code: 0,
      city: "New Delhi",
      country: "IN",
      is_day: true,
      observed_at: new Date().toISOString(),
      source: "open-meteo",
    },
    forecast: [],
    alerts: [],
    hazards: [],
    ...overrides,
  };
}

interface Backend {
  events: DisasterEvent[] | null;
  weather: WeatherResponse | null;
}

let backend: Backend;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  // framer-motion's AnimatePresence calls scrollTo during transitions; jsdom doesn't implement it.
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  backend = { events: [], weather: weather() };
  fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/backend/alerts/disasters") {
      return backend.events
        ? jsonResponse({ events: backend.events, updated_at: new Date().toISOString() })
        : jsonResponse({ error: { code: "upstream_error", message: "GDACS unavailable", request_id: "" } }, 502);
    }
    if (url.pathname === "/api/backend/weather") {
      return backend.weather
        ? jsonResponse(backend.weather)
        : jsonResponse({ error: { code: "upstream_error", message: "Weather down", request_id: "" } }, 502);
    }
    return jsonResponse({ error: { code: "not_found", message: "nope", request_id: "" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("buildAlertCandidates", () => {
  it("ranks red events > high alerts > high hazards > orange events > medium items", () => {
    const candidates = buildAlertCandidates({
      events: [
        event({ id: "EQ-far", alert_level: "orange", distance_km: 450, title: "Orange far" }),
        event({ id: "EQ-near", alert_level: "orange", distance_km: 50, title: "Orange near" }),
        event({ id: "TC-1", event_type: "TC", event_type_label: "Tropical Cyclone", alert_level: "red", title: "Red cyclone" }),
        event({ id: "FL-g", alert_level: "green", title: "Green flood" }),
        event({ id: "EQ-old", alert_level: "red", is_current: false, title: "Past quake" }),
      ],
      weather: weather({
        alerts: [
          { event: "Heat advisory", description: "Hot", sender: "IMD", start: null, end: null, severity: "medium" },
          { event: "Cyclone warning", description: "Storm", sender: "IMD", start: null, end: null, severity: "high" },
        ],
        hazards: [
          { type: "high_wind", severity: "high", message: "Gusts 70 km/h" },
          { type: "heavy_rain", severity: "medium", message: "Rain likely" },
          { type: "extreme_cold", severity: "low", message: "Chilly" },
        ],
      }),
    });

    expect(candidates.map((c) => c.title)).toEqual([
      "Red cyclone",
      "Cyclone warning",
      "High wind",
      "Orange near",
      "Orange far",
      "Heat advisory",
      "Heavy rain",
    ]);
    expect(candidates[0]).toMatchObject({ tone: "critical", eyebrow: "Red alert · Tropical Cyclone" });
    expect(candidates[3]).toMatchObject({ tone: "high", id: "gdacs:EQ-near:orange", external: true });
    expect(candidates[6]).toMatchObject({ tone: "elevated", kind: "hazard" });
  });

  it("rejects unsafe report URLs and handles missing data", () => {
    const [candidate] = buildAlertCandidates({ events: [event({ url: "javascript:alert(1)" })] });
    expect(candidate.href).toBeNull();
    expect(buildAlertCandidates({})).toEqual([]);
    expect(buildAlertCandidates({ events: null, weather: null })).toEqual([]);
  });
});

describe("AlertBanner", () => {
  it("renders nothing and fetches nothing without coordinates", () => {
    const { container } = renderWithSWR(<AlertBanner coords={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for nearby orange+ events and stays hidden when nothing is relevant", async () => {
    const { container } = renderWithSWR(<AlertBanner coords={{ lat: 28.6, lon: 77.2 }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const disastersUrl = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), "http://localhost"))
      .find((url) => url.pathname === "/api/backend/alerts/disasters");
    expect(disastersUrl?.searchParams.get("min_level")).toBe("orange");
    expect(disastersUrl?.searchParams.get("radius_km")).toBe("500");
    expect(disastersUrl?.searchParams.get("lat")).toBe("28.6");

    // Give SWR a tick to settle; nothing relevant => no banner.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the most severe alert with a safe external report link", async () => {
    backend.events = [event({ alert_level: "red", title: "M 7.2 earthquake in Nepal", distance_km: 120 })];
    backend.weather = weather({ hazards: [{ type: "heavy_rain", severity: "medium", message: "Rain" }] });

    renderWithSWR(<AlertBanner coords={{ lat: 28.6, lon: 77.2 }} isDefaultLocation />);

    expect(await screen.findByText("M 7.2 earthquake in Nepal")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Red alert · Earthquake/);
    expect(screen.getByText(/Nepal · 120 km away/)).toBeInTheDocument();
    expect(screen.getByText("Near the default location")).toBeInTheDocument();
    const report = screen.getByRole("link", { name: /GDACS report/ });
    expect(report).toHaveAttribute("href", "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1");
    expect(report).toHaveAttribute("target", "_blank");
    expect(report).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: /All alerts \(\+1 more\)/ })).toHaveAttribute("href", "/alerts");
  });

  it("remembers dismissals per alert id and then shows the next alert", async () => {
    const user = userEvent.setup();
    backend.events = [event({ id: "EQ-9", alert_level: "red", title: "Big quake" })];
    backend.weather = weather({ hazards: [{ type: "high_wind", severity: "high", message: "Gusts of 75 km/h" }] });

    const { unmount } = renderWithSWR(<AlertBanner coords={{ lat: 1, lon: 2 }} />);
    await user.click(await screen.findByRole("button", { name: "Dismiss alert: Big quake" }));

    expect(await screen.findByText("High wind")).toBeInTheDocument();
    expect(Object.keys(loadDismissedAlerts())).toEqual(["gdacs:EQ-9:red"]);
    unmount();

    // A fresh mount keeps the dismissal.
    renderWithSWR(<AlertBanner coords={{ lat: 1, lon: 2 }} />);
    expect(await screen.findByText("High wind")).toBeInTheDocument();
    expect(screen.queryByText("Big quake")).not.toBeInTheDocument();
  });

  it("shows an escalated event again even if the lower level was dismissed", async () => {
    window.localStorage.setItem(DISMISSED_ALERTS_STORAGE_KEY, JSON.stringify({ "gdacs:EQ-1:orange": Date.now() }));
    backend.events = [event({ id: "EQ-1", alert_level: "red", title: "Escalated quake" })];
    renderWithSWR(<AlertBanner coords={{ lat: 1, lon: 2 }} />);
    expect(await screen.findByText("Escalated quake")).toBeInTheDocument();
  });

  it("hides the banner after dismissing the only alert", async () => {
    const user = userEvent.setup();
    backend.events = [event({ title: "Only quake" })];
    renderWithSWR(<AlertBanner coords={{ lat: 1, lon: 2 }} />);
    await user.click(await screen.findByRole("button", { name: "Dismiss alert: Only quake" }));
    await waitFor(() => expect(screen.queryByText("Only quake")).not.toBeInTheDocument());
  });

  it("shows a slim retry notice when the alert sources fail", async () => {
    const user = userEvent.setup();
    backend.events = null;
    backend.weather = null;
    renderWithSWR(<AlertBanner coords={{ lat: 1, lon: 2 }} />);

    expect(await screen.findByText(/Live alerts couldn.t be checked/)).toBeInTheDocument();

    backend.events = [event({ alert_level: "red", title: "Recovered quake" })];
    backend.weather = weather();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered quake")).toBeInTheDocument();
  });

  it("drops expired or corrupt dismissal records", () => {
    const old = Date.now() - 30 * 24 * 60 * 60_000;
    window.localStorage.setItem(DISMISSED_ALERTS_STORAGE_KEY, JSON.stringify({ a: old, b: Date.now(), c: "x" }));
    expect(Object.keys(loadDismissedAlerts())).toEqual(["b"]);
    window.localStorage.setItem(DISMISSED_ALERTS_STORAGE_KEY, "[not json");
    expect(loadDismissedAlerts()).toEqual({});
  });
});
