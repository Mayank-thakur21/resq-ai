import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hazardLabel, upcomingForecast, WeatherCard, weatherIcon } from "@/components/WeatherCard";
import { fetcher } from "@/lib/api";
import type { ForecastItem, WeatherResponse } from "@/lib/types";

/** Isolated SWR cache per test, no retries/dedupe so each test controls every request. */
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

const HOUR = 60 * 60_000;

function hoursFromNow(hours: number): string {
  const date = new Date(Date.now() + hours * HOUR);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function makeWeather(overrides: Partial<WeatherResponse> = {}): WeatherResponse {
  return {
    weather: {
      temperature: 32.4,
      feels_like: 41.2,
      humidity: 45,
      wind_speed_kmh: 12.3,
      description: "clear sky",
      icon: "01d",
      weather_code: 0,
      city: "New Delhi",
      country: "IN",
      is_day: true,
      observed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      source: "open-meteo",
    },
    forecast: Array.from({ length: 10 }, (_, index) => ({
      time: hoursFromNow(index - 3),
      temperature: 30 + index,
      description: "light rain",
      icon: "10d",
      precipitation_probability: index * 10,
    })),
    alerts: [],
    hazards: [
      { type: "extreme_heat", severity: "high", message: "Feels like 41°C. Stay hydrated and avoid the midday sun." },
    ],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("WeatherCard", () => {
  it("shows a skeleton and does not fetch while the location is unknown", () => {
    renderWithSWR(<WeatherCard coords={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Finding your location…");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders current conditions, the source, the mini forecast and hazards", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeWeather()));
    renderWithSWR(<WeatherCard coords={{ lat: 28.61391, lon: 77.20902 }} />);

    expect(await screen.findByText("clear sky")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/backend/weather?lat=28.6139&lon=77.209");

    expect(screen.getByText("32°")).toBeInTheDocument();
    expect(screen.getByText("New Delhi, IN")).toBeInTheDocument();
    expect(screen.getByText("12 km/h")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(screen.getByText("41°C")).toBeInTheDocument();
    expect(screen.getByText("Open-Meteo")).toBeInTheDocument(); // source badge
    expect(screen.getByText(/Observed 5 minutes ago/)).toBeInTheDocument();

    // Past steps (older than an hour) are dropped; at most 6 upcoming steps are shown.
    const forecast = screen.getByRole("list", { name: "Hourly forecast" });
    expect(within(forecast).getAllByRole("listitem")).toHaveLength(6);

    expect(screen.getByText("Extreme heat")).toBeInTheDocument();
    expect(screen.getByText(/Stay hydrated/)).toBeInTheDocument();
  });

  it("shows an ErrorState with a working retry", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "upstream_error", message: "Weather providers unavailable", request_id: "r" } }, 502),
      )
      .mockResolvedValueOnce(jsonResponse(makeWeather()));

    renderWithSWR(<WeatherCard coords={{ lat: 1, lon: 2 }} />);

    expect(await screen.findByText("Weather is unavailable")).toBeInTheDocument();
    expect(screen.getByText("Weather providers unavailable")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("clear sky")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles an empty forecast, no hazards and an unknown city", async () => {
    const base = makeWeather();
    fetchMock.mockResolvedValue(
      jsonResponse({ ...base, weather: { ...base.weather, city: null, country: null }, forecast: [], hazards: [] }),
    );
    renderWithSWR(<WeatherCard coords={{ lat: 1, lon: 2 }} isDefaultLocation />);

    expect(await screen.findByText("Forecast unavailable")).toBeInTheDocument();
    expect(screen.getByText("No weather hazards detected right now.")).toBeInTheDocument();
    expect(screen.getByText("Default location")).toBeInTheDocument();
  });

  it("lists official weather alerts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        makeWeather({
          hazards: [],
          alerts: [
            {
              event: "Cyclone warning",
              description: "Severe cyclonic storm approaching the coast.",
              sender: "IMD",
              start: hoursFromNow(-1),
              end: hoursFromNow(12),
              severity: "high",
            },
          ],
        }),
      ),
    );
    renderWithSWR(<WeatherCard coords={{ lat: 1, lon: 2 }} />);
    expect(await screen.findByText("Cyclone warning")).toBeInTheDocument();
    expect(screen.getByText(/IMD/)).toBeInTheDocument();
  });
});

describe("weather helpers", () => {
  it("picks upcoming forecast steps in time order", () => {
    const now = Date.parse("2026-11-02T12:20:00Z");
    const items: ForecastItem[] = [
      { time: "2026-11-02T14:00:00Z", temperature: 3, description: "", icon: "01d", precipitation_probability: null },
      { time: "2026-11-02T10:00:00Z", temperature: 1, description: "", icon: "01d", precipitation_probability: null },
      { time: "2026-11-02T12:00:00Z", temperature: 2, description: "", icon: "01d", precipitation_probability: null },
      { time: "invalid", temperature: 9, description: "", icon: "01d", precipitation_probability: null },
    ];
    expect(upcomingForecast(items, now).map((item) => item.temperature)).toEqual([2, 3]);
    expect(upcomingForecast(items, now, 1)).toHaveLength(1);
  });

  it("maps icon codes and hazard types", () => {
    expect(weatherIcon("01d")).not.toBe(weatherIcon("01n"));
    expect(weatherIcon("11d")).toBe(weatherIcon("11n"));
    expect(weatherIcon(undefined)).toBe(weatherIcon("03d"));
    expect(hazardLabel("high_wind")).toBe("High wind");
    expect(hazardLabel("dust_storm")).toBe("Dust storm");
  });
});

describe("WeatherCard coordinate changes", () => {
  function Harness() {
    const [coords, setCoords] = React.useState({ lat: 1, lon: 2 });
    return (
      <>
        <button type="button" onClick={() => setCoords({ lat: 3, lon: 4 })}>
          Move
        </button>
        <WeatherCard coords={coords} />
      </>
    );
  }

  it("refetches when the coordinates change", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => jsonResponse(makeWeather()));
    renderWithSWR(<Harness />);
    await screen.findByText("clear sky");

    await user.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/backend/weather?lat=3&lon=4")).toBe(true),
    );
    expect(await screen.findByText("clear sky")).toBeInTheDocument();
  });
});
