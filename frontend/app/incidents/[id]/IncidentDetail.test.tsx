import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: { user: { id: "u-reporter", name: "Asha Rao" } } as null | { user: { id: string; name?: string } },
  status: "authenticated" as "loading" | "authenticated" | "unauthenticated",
}));

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: auth.session, status: auth.status }) }));
vi.mock("next/dynamic", async () => {
  const ReactModule = await import("react");
  return {
    default: () =>
      function IncidentMapStub() {
        return ReactModule.createElement("div", { "data-testid": "incident-map" });
      },
  };
});

import { IncidentDetail, SAVED_COPY_ACTION_HINT } from "@/app/incidents/[id]/IncidentDetail";
import { jsonResponse, makeIncident, mockFetch, SWRTestProvider } from "@/components/map/test-fixtures";

function renderDetail() {
  return render(
    <SWRTestProvider>
      <IncidentDetail id="inc-1" />
    </SWRTestProvider>,
  );
}

const incident = makeIncident({ reporter: { id: "u-reporter", name: "Asha Rao" } });

beforeEach(() => {
  auth.session = { user: { id: "u-reporter", name: "Asha Rao" } };
  auth.status = "authenticated";
});

describe("IncidentDetail", () => {
  it("shows live data without an offline label and with working actions", async () => {
    mockFetch({ "GET incidents/inc-1": () => jsonResponse(incident) });
    renderDetail();

    expect(await screen.findByRole("button", { name: /Mark resolved/ })).toBeEnabled();
    expect(screen.queryByText(/Showing saved data/)).not.toBeInTheDocument();
    expect(screen.queryByText(SAVED_COPY_ACTION_HINT)).not.toBeInTheDocument();
  });

  it("labels a saved (offline) copy and disables actions that need the server", async () => {
    // Regression: the service worker's cached copy (offline or > 6 s network) looked live.
    const cachedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    mockFetch({
      "GET incidents/inc-1": () =>
        jsonResponse(incident, 200, { "X-ResQ-Offline": "1", "X-ResQ-Cached-At": cachedAt }),
    });
    renderDetail();

    expect(await screen.findByText(/Showing saved data from 2 hours ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mark resolved/ })).toBeDisabled();
    expect(screen.getByText(SAVED_COPY_ACTION_HINT)).toBeInTheDocument();
  });

  it("disables confirming a saved copy for other viewers too", async () => {
    auth.session = { user: { id: "u-viewer", name: "Viewer" } };
    mockFetch({
      "GET incidents/inc-1": () => jsonResponse(incident, 200, { "X-ResQ-Offline": "1" }),
    });
    renderDetail();

    const confirm = await screen.findByRole("button", { name: /Confirm this incident/ });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("title", SAVED_COPY_ACTION_HINT);
    expect(screen.getByText(/Showing saved data — you're offline/)).toBeInTheDocument();
  });
});
