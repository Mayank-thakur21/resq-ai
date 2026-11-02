import { render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Home from "@/app/page";
import { fetcher } from "@/lib/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  const now = new Date().toISOString();
  fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    switch (url.pathname) {
      case "/api/backend/weather":
        return jsonResponse({
          weather: {
            temperature: 24,
            feels_like: 24,
            humidity: 60,
            wind_speed_kmh: 8,
            description: "partly cloudy",
            icon: "02d",
            weather_code: 2,
            city: null,
            country: null,
            is_day: true,
            observed_at: now,
            source: "open-meteo",
          },
          forecast: [],
          alerts: [],
          hazards: [],
        });
      case "/api/backend/alerts/disasters":
        return jsonResponse({
          events: [
            {
              id: "FL-7",
              source: "gdacs",
              event_type: "FL",
              event_type_label: "Flood",
              title: "Flood in Uttar Pradesh",
              description: "",
              alert_level: "red",
              severity_text: null,
              country: "India",
              lat: 27,
              lon: 80,
              from_date: now,
              to_date: null,
              is_current: true,
              url: "https://www.gdacs.org/report.aspx?eventtype=FL&eventid=7",
              distance_km: 380,
            },
          ],
          updated_at: now,
        });
      case "/api/backend/alerts/news":
        return jsonResponse({ items: [], sources: ["gdacs"], updated_at: now });
      default:
        return jsonResponse({ error: { code: "not_found", message: "nope", request_id: "" } }, 404);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
});

function renderHome() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), fetcher, dedupingInterval: 0, shouldRetryOnError: false }}>
      <Home />
    </SWRConfig>,
  );
}

describe("Home page", () => {
  it("keeps the hero and links every feature, including SOS, Alerts and Incidents", () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1, name: "ResQ AI" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Send SOS/ })).toHaveAttribute("href", "/sos");
    expect(screen.getByRole("link", { name: /Call 112/ })).toHaveAttribute("href", "tel:112");
    for (const [name, href] of [
      [/Emergency AI Chat/, "/chat"],
      [/Live Relief Map/, "/map"],
      [/Disaster Alerts/, "/alerts"],
      [/Community Incidents/, "/incidents"],
      [/Smart Checklists/, "/checklist"],
      [/Emergency Contacts/, "/contacts"],
    ] as const) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("falls back to the default location with a notice and shows live widgets", async () => {
    // jsdom has no geolocation API => "unavailable" => default location.
    renderHome();

    expect(
      await screen.findByText("Using default location — enable location for local results"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use my location" })).toBeInTheDocument();

    expect(await screen.findByText("partly cloudy")).toBeInTheDocument();
    expect(screen.getByText("Default location")).toBeInTheDocument();
    expect(await screen.findByText("Flood in Uttar Pradesh")).toBeInTheDocument();
    expect(screen.getByText("Near the default location")).toBeInTheDocument();
    expect(await screen.findByText("No recent disaster news")).toBeInTheDocument();

    await waitFor(() => {
      const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost").pathname);
      expect(paths).toEqual(
        expect.arrayContaining(["/api/backend/weather", "/api/backend/alerts/disasters", "/api/backend/alerts/news"]),
      );
    });
  });
});
