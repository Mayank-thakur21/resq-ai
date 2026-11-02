import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DisasterFeed, newsSourceLabel, RelativeTime } from "@/components/DisasterFeed";
import { fetcher } from "@/lib/api";
import type { NewsItem, NewsResponse } from "@/lib/types";

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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function item(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: "reliefweb-1",
    source: "reliefweb",
    title: "Floods displace thousands in Assam",
    url: "https://reliefweb.int/report/india/floods-assam",
    published_at: minutesAgo(5),
    summary: "Heavy monsoon rains have flooded 20 districts.",
    countries: ["India"],
    disaster_types: ["Flood"],
    source_name: "OCHA",
    ...overrides,
  };
}

function news(items: NewsItem[], sources: NewsResponse["sources"] = ["reliefweb"]): NewsResponse {
  return { items, sources, updated_at: minutesAgo(1) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("DisasterFeed (widget)", () => {
  it("lists news with source, relative time and safe external links", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        news([
          item(),
          item({
            id: "gdacs-EQ-1",
            source: "gdacs",
            source_name: null,
            title: "Earthquake in Japan",
            url: "https://www.gdacs.org/report.aspx?eventid=1",
            published_at: minutesAgo(120),
            countries: [],
          }),
        ]),
      ),
    );

    renderWithSWR(<DisasterFeed />);

    const link = await screen.findByRole("link", { name: /Floods displace thousands in Assam/ });
    expect(link).toHaveAttribute("href", "https://reliefweb.int/report/india/floods-assam");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    expect(screen.getByText("OCHA")).toBeInTheDocument();
    expect(screen.getByText("5 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("GDACS")).toBeInTheDocument(); // fallback when source_name is null
    expect(screen.getByText("2 hours ago")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All alerts & news/ })).toHaveAttribute("href", "/alerts?tab=news");

    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/backend/alerts/news?limit=5");
  });

  it("never renders unsafe URLs as links", async () => {
    fetchMock.mockResolvedValue(jsonResponse(news([item({ title: "Sketchy item", url: "javascript:alert(1)" })])));
    renderWithSWR(<DisasterFeed />);
    expect(await screen.findByText("Sketchy item")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Sketchy item/ })).not.toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    fetchMock.mockResolvedValue(jsonResponse(news([])));
    renderWithSWR(<DisasterFeed />);
    expect(await screen.findByText("No recent disaster news")).toBeInTheDocument();
  });

  it("shows an ErrorState and recovers on retry", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(news([item()])));

    renderWithSWR(<DisasterFeed />);
    expect(await screen.findByText("News is unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Can't reach ResQ AI right now/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("Floods displace thousands in Assam")).toBeInTheDocument();
  });
});

describe("DisasterFeed (list)", () => {
  it("passes the search query and shows summaries, tags and sources", async () => {
    fetchMock.mockResolvedValue(jsonResponse(news([item()], ["reliefweb", "gdacs"])));
    renderWithSWR(<DisasterFeed variant="list" query="  flood  " limit={30} />);

    expect(await screen.findByText("Heavy monsoon rains have flooded 20 districts.")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/backend/alerts/news?limit=30&query=flood");

    const section = screen.getByRole("region", { name: "Disaster news" });
    expect(within(section).getByText("1 item")).toBeInTheDocument();
    expect(within(section).getAllByText("ReliefWeb").length).toBeGreaterThan(0);
    expect(within(section).getByText("India")).toBeInTheDocument();
    expect(within(section).getByText("Flood")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: /Read on reliefweb.int/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });

  it("explains an empty search", async () => {
    fetchMock.mockResolvedValue(jsonResponse(news([])));
    renderWithSWR(<DisasterFeed variant="list" query="volcano" />);
    expect(await screen.findByText("No news matches your search")).toBeInTheDocument();
  });
});

describe("RelativeTime / labels", () => {
  it("renders a <time> element with ISO dateTime and nothing for invalid dates", () => {
    const iso = minutesAgo(10);
    const { container, rerender } = render(<RelativeTime value={iso} prefix="Updated" />);
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("dateTime", new Date(iso).toISOString());
    expect(time).toHaveTextContent("Updated 10 minutes ago");

    rerender(<RelativeTime value="not a date" />);
    expect(container.querySelector("time")).toBeNull();
  });

  it("labels sources", () => {
    expect(newsSourceLabel("reliefweb")).toBe("ReliefWeb");
    expect(newsSourceLabel("gdacs")).toBe("GDACS");
    expect(newsSourceLabel("other")).toBe("other");
  });
});

describe("DisasterFeed (saved copies)", () => {
  it("labels news served from the service worker cache in both layouts", async () => {
    // Regression: hours-old headlines from the offline cache looked live.
    const cachedAt = minutesAgo(180);
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(news([item()])), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-ResQ-Offline": "1", "X-ResQ-Cached-At": cachedAt },
      }),
    );
    const { unmount } = renderWithSWR(<DisasterFeed />);
    expect(await screen.findByText(/Showing saved data from 3 hours ago/)).toBeInTheDocument();
    unmount();

    renderWithSWR(<DisasterFeed variant="list" />);
    expect(await screen.findByText(/Showing saved data from 3 hours ago/)).toBeInTheDocument();
  });

  it("shows no label for live news", async () => {
    fetchMock.mockResolvedValue(jsonResponse(news([item()])));
    renderWithSWR(<DisasterFeed />);
    expect(await screen.findByText("Floods displace thousands in Assam")).toBeInTheDocument();
    expect(screen.queryByText(/Showing saved data/)).not.toBeInTheDocument();
  });
});
