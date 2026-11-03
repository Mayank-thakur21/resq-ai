import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => "/alerts",
}));

import AlertsView, { parseTab } from "@/app/alerts/AlertsView";
import { fetcher } from "@/lib/api";

function renderView() {
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
      <AlertsView />
    </SWRConfig>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigation.search = "";
  window.history.replaceState(null, "", "/alerts");
  fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const now = new Date().toISOString();
    switch (url.pathname) {
      case "/api/backend/alerts/disasters":
        return jsonResponse({ events: [], updated_at: now });
      case "/api/backend/alerts/news":
        return jsonResponse({
          items: [
            {
              id: "rw-1",
              source: "reliefweb",
              title: "Cyclone response update",
              url: "https://reliefweb.int/report/1",
              published_at: now,
              summary: null,
              countries: [],
              disaster_types: [],
              source_name: "OCHA",
            },
          ],
          sources: ["reliefweb"],
          updated_at: now,
        });
      case "/api/backend/push/vapid-public-key":
        return jsonResponse({ enabled: false, public_key: null });
      default:
        return jsonResponse({ error: { code: "not_found", message: "nope", request_id: "" } }, 404);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("AlertsView", () => {
  it("parses the tab parameter", () => {
    expect(parseTab("news")).toBe("news");
    expect(parseTab("disasters")).toBe("disasters");
    expect(parseTab(null)).toBe("disasters");
    expect(parseTab("bogus")).toBe("disasters");
  });

  it("opens the Disasters tab by default and lazily mounts News", async () => {
    renderView();
    expect(screen.getByRole("tab", { name: "Disasters" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("No active disaster events")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("alerts/news"))).toBe(false);
  });

  it("honours ?tab=news and keeps the URL in sync when switching tabs", async () => {
    const user = userEvent.setup();
    navigation.search = "tab=news";
    renderView();

    expect(screen.getByRole("tab", { name: "News" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Cyclone response update")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Disasters" }));
    expect(screen.getByRole("tab", { name: "Disasters" })).toHaveAttribute("aria-selected", "true");
    expect(window.location.search).toBe("");
    expect(await screen.findByText("No active disaster events")).toBeInTheDocument();

    // The News panel stays mounted (hidden) so its state survives.
    const newsPanel = document.getElementById("alerts-panel-news");
    expect(newsPanel).toHaveAttribute("hidden");
    expect(newsPanel).toHaveTextContent("Cyclone response update");

    await user.click(screen.getByRole("tab", { name: "News" }));
    expect(window.location.search).toBe("?tab=news");
  });

  it("supports arrow-key navigation between tabs", async () => {
    const user = userEvent.setup();
    renderView();
    screen.getByRole("tab", { name: "Disasters" }).focus();
    await user.keyboard("{ArrowRight}");
    const news = screen.getByRole("tab", { name: "News" });
    expect(news).toHaveFocus();
    expect(news).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Disasters" })).toHaveFocus();
  });

  it("renders the push toggle and alert-level legend in the side column", async () => {
    renderView();
    expect(screen.getByRole("heading", { name: "About alert levels" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alert notifications" })).toBeInTheDocument());
  });
});
