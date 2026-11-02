import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string; name?: string } },
  status: "unauthenticated" as "loading" | "authenticated" | "unauthenticated",
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: auth.session, status: auth.status }) }));

import { IncidentsView } from "@/app/incidents/IncidentsView";
import {
  errorResponse,
  jsonResponse,
  makeIncident,
  mockFetch,
  SWRTestProvider,
} from "@/components/map/test-fixtures";
import { DEFAULT_COORDS } from "@/lib/geo";

function renderView(focusId: string | null = null) {
  return render(
    <SWRTestProvider>
      <IncidentsView focusId={focusId} />
    </SWRTestProvider>,
  );
}

const incidents = [
  makeIncident({ id: "a", disaster_type: "flood", severity: "critical", description: "Bridge flooded, cars stuck." }),
  makeIncident({ id: "b", disaster_type: "fire", severity: "low", description: "Small brush fire near the park." }),
];

beforeEach(() => {
  auth.session = null;
  auth.status = "unauthenticated";
});

describe("IncidentsView", () => {
  it("lists incidents near the default location when geolocation is unavailable", async () => {
    const { calls } = mockFetch({ "GET incidents": () => jsonResponse({ incidents }) });
    renderView();

    expect(await screen.findByRole("article", { name: "Flood" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Fire" })).toBeInTheDocument();
    expect(screen.getByText(/Using default location — enable location for local results/)).toBeInTheDocument();
    expect(screen.getByText(/2 incidents within 50 km of the default location/)).toBeInTheDocument();

    const query = calls[0]?.query;
    expect(Number(query?.get("lat"))).toBeCloseTo(DEFAULT_COORDS.lat, 3);
    expect(query?.get("radius_km")).toBe("50");
    expect(query?.get("status")).toBe("open");
    expect(query?.has("type")).toBe(false);
  });

  it("filters severity on the client and type/status/radius on the server", async () => {
    const { calls } = mockFetch({
      "GET incidents": (call) =>
        jsonResponse({
          incidents: call.query.get("type") === "fire" ? incidents.filter((incident) => incident.id === "b") : incidents,
        }),
    });
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("article", { name: "Flood" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Severity" }), "critical");
    expect(screen.getByRole("article", { name: "Flood" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Fire" })).not.toBeInTheDocument();
    const requestsBefore = calls.length;

    await user.selectOptions(screen.getByRole("combobox", { name: "Severity" }), "all");
    expect(calls.length).toBe(requestsBefore);

    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "fire");
    await waitFor(() => expect(screen.queryByRole("article", { name: "Flood" })).not.toBeInTheDocument());
    expect(calls.at(-1)?.query.get("type")).toBe("fire");

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    await user.selectOptions(screen.getByRole("combobox", { name: "Radius" }), "100");
    await waitFor(() => expect(calls.at(-1)?.query.get("radius_km")).toBe("100"));
    expect(calls.at(-1)?.query.get("status")).toBe("all");
  });

  it("shows an empty state with useful actions", async () => {
    mockFetch({ "GET incidents": () => jsonResponse({ incidents: [] }) });
    const user = userEvent.setup();
    renderView();

    expect(await screen.findByText("No open incidents within 50 km")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Report an incident/ })[0]).toHaveAttribute("href", "/incidents/new");
    await user.click(screen.getByRole("button", { name: "Search 100 km" }));
    expect(await screen.findByText("No incidents match these filters")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Reset/ }).length).toBeGreaterThan(0);
  });

  it("shows an error state and retries", async () => {
    let fail = true;
    mockFetch({
      "GET incidents": () =>
        fail ? errorResponse(503, "service_unavailable", "Database unavailable") : jsonResponse({ incidents }),
    });
    const user = userEvent.setup();
    renderView();

    const title = await screen.findByText("Incidents are unavailable");
    const error = title.closest<HTMLElement>("[data-slot=error-state]");
    if (!error) throw new Error("error state not rendered");
    expect(error).toHaveAttribute("role", "alert");
    expect(within(error).getByText("Database unavailable")).toBeInTheDocument();

    fail = false;
    await user.click(within(error).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("article", { name: "Flood" })).toBeInTheDocument();
  });

  it("highlights the focused incident when it is in the list", async () => {
    mockFetch({ "GET incidents": () => jsonResponse({ incidents }) });
    renderView("b");
    const card = await screen.findByRole("article", { name: "Fire" });
    expect(card).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByRole("article", { name: "Flood" })).not.toHaveAttribute("data-highlighted");
    await waitFor(() => expect(card).toHaveFocus());
  });

  it("fetches and pins a focused incident outside the current filters", async () => {
    const linked = makeIncident({ id: "far-away", disaster_type: "cyclone", status: "resolved", distance_km: null });
    const { calls } = mockFetch({
      "GET incidents": () => jsonResponse({ incidents }),
      "GET incidents/far-away": () => jsonResponse(linked),
    });
    renderView("far-away");

    expect(await screen.findByText(/Linked incident/)).toBeInTheDocument();
    const card = await screen.findByRole("article", { name: "Cyclone" });
    expect(card).toHaveAttribute("data-highlighted", "true");
    expect(calls.map((call) => call.path)).toContain("incidents/far-away");
  });

  it("explains when a focused incident no longer exists", async () => {
    mockFetch({
      "GET incidents": () => jsonResponse({ incidents }),
      "GET incidents/gone": () => errorResponse(404, "not_found", "Incident not found"),
    });
    renderView("gone");
    expect(await screen.findByText("The linked incident no longer exists.")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Flood" })).toBeInTheDocument();
  });

  it("writes an upvote back into the list", async () => {
    auth.session = { user: { id: "u-viewer" } };
    auth.status = "authenticated";
    mockFetch({
      "GET incidents": () => jsonResponse({ incidents }),
      "POST incidents/a/upvote": () =>
        jsonResponse({ ...incidents[0], upvotes: 3, upvoted_by_me: true, verified: true }),
    });
    const user = userEvent.setup();
    renderView();

    const card = await screen.findByRole("article", { name: "Flood" });
    await user.click(within(card).getByRole("button", { name: /Confirm this incident/ }));
    expect(await within(card).findByText("Verified")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /You confirmed this incident, 3 confirmations/ })).toBeInTheDocument();
  });
});
