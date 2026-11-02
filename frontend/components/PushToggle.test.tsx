import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => ({
  getPushStatus: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  resyncSubscription: vi.fn(),
}));

// Keep the real constants / PushError; replace only the functions touching browser APIs.
vi.mock("@/lib/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/push")>();
  return { ...actual, ...push };
});

import { SessionContext } from "next-auth/react";

import { PushToggle } from "@/components/PushToggle";
import { ApiError, fetcher } from "@/lib/api";
import { PushError, type PushPreferences } from "@/lib/push";

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

const PREFS_WITH_LOCATION: PushPreferences = {
  radiusKm: 50,
  topics: ["incidents", "disasters"],
  lat: 28.614,
  lon: 77.209,
};

let vapid: { enabled: boolean; public_key: string | null; disaster_alerts?: boolean } | "error";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vapid = { enabled: true, public_key: "VAPID-KEY" };
  fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/backend/push/vapid-public-key") {
      return vapid === "error"
        ? jsonResponse({ error: { code: "internal_error", message: "Server error", request_id: "" } }, 500)
        : jsonResponse(vapid);
    }
    return jsonResponse({ error: { code: "not_found", message: "nope", request_id: "" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  push.getPushStatus.mockResolvedValue({ state: "unsubscribed" });
  // Like the real implementation: the saved preferences echo the requested ones.
  push.subscribe.mockImplementation(async (options: { radiusKm?: number; topics?: PushPreferences["topics"] }) => {
    const prefs: PushPreferences = {
      ...PREFS_WITH_LOCATION,
      radiusKm: options.radiusKm ?? 50,
      topics: options.topics ? [...options.topics] : ["incidents", "disasters"],
    };
    return { subscription: {}, server: { id: "s1", radius_km: prefs.radiusKm, topics: prefs.topics }, prefs };
  });
  push.unsubscribe.mockResolvedValue(true);
  push.resyncSubscription.mockResolvedValue(false);
});

describe("PushToggle", () => {
  it("explains unsupported browsers", async () => {
    push.getPushStatus.mockResolvedValue({
      state: "unsupported",
      support: { supported: false, reason: "no_api", iosNeedsInstall: false },
    });
    renderWithSWR(<PushToggle />);
    expect(await screen.findByText("Not supported in this browser")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("shows the iOS Add-to-Home-Screen hint", async () => {
    push.getPushStatus.mockResolvedValue({
      state: "unsupported",
      support: { supported: false, reason: "no_api", iosNeedsInstall: true },
    });
    renderWithSWR(<PushToggle />);
    expect(await screen.findByText("Install ResQ AI to get notifications")).toBeInTheDocument();
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
  });

  it("explains when push is disabled on the server", async () => {
    vapid = { enabled: false, public_key: null };
    renderWithSWR(<PushToggle />);
    expect(await screen.findByText("Notifications aren't available yet")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("explains blocked notifications", async () => {
    push.getPushStatus.mockResolvedValue({ state: "denied" });
    renderWithSWR(<PushToggle />);
    expect(await screen.findByText("Notifications are blocked")).toBeInTheDocument();
  });

  it("shows an ErrorState with retry when the server can't be reached", async () => {
    const user = userEvent.setup();
    vapid = "error";
    renderWithSWR(<PushToggle />);
    expect(await screen.findByText("Couldn't check notification settings")).toBeInTheDocument();

    vapid = { enabled: true, public_key: "VAPID-KEY" };
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("switch")).toBeInTheDocument();
  });

  it("turns notifications on with the given coordinates", async () => {
    const user = userEvent.setup();
    renderWithSWR(<PushToggle coords={{ lat: 28.6139, lon: 77.209 }} />);

    const toggle = await screen.findByRole("switch", { name: "Alert notifications" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Off on this device")).toBeInTheDocument();

    await user.click(toggle);

    expect(push.subscribe).toHaveBeenCalledTimes(1);
    const options = push.subscribe.mock.calls[0][0];
    expect(options).toMatchObject({ vapidPublicKey: "VAPID-KEY", radiusKm: 50, topics: ["incidents", "disasters"] });
    await expect(options.locate()).resolves.toEqual({ lat: 28.6139, lon: 77.209 });

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText(/alerts within 50 km of your saved location/)).toBeInTheDocument();
  });

  it("warns when no location could be saved", async () => {
    const user = userEvent.setup();
    push.subscribe.mockResolvedValue({
      subscription: {},
      server: { id: "s1", radius_km: 50, topics: ["disasters"] },
      prefs: { radiusKm: 50, topics: ["disasters"] },
    });
    renderWithSWR(<PushToggle />);
    await user.click(await screen.findByRole("switch"));
    expect(await screen.findByText(/red disaster alerts only/)).toBeInTheDocument();
    expect(screen.getByText(/We couldn't get your location/)).toBeInTheDocument();
  });

  it("switches to the blocked state when permission is denied", async () => {
    const user = userEvent.setup();
    push.subscribe.mockRejectedValue(new PushError("denied"));
    renderWithSWR(<PushToggle />);
    await user.click(await screen.findByRole("switch"));
    expect(await screen.findByText("Notifications are blocked")).toBeInTheDocument();
  });

  it("shows inline errors for other failures", async () => {
    const user = userEvent.setup();
    push.subscribe.mockRejectedValueOnce(new PushError("dismissed"));
    renderWithSWR(<PushToggle />);
    await user.click(await screen.findByRole("switch"));
    expect(await screen.findByText(/Notification permission wasn't granted/)).toBeInTheDocument();

    push.subscribe.mockRejectedValueOnce(
      new ApiError(503, "not_configured", "Web push notifications are not configured on the server (VAPID keys)."),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await user.click(screen.getByRole("switch"));
    expect(await screen.findByText("Push notifications aren't set up on this server yet.")).toBeInTheDocument();
  });

  it("re-links the device whenever the signed-in identity changes", async () => {
    push.getPushStatus.mockResolvedValue({ state: "subscribed", subscription: {}, prefs: PREFS_WITH_LOCATION });
    const update = vi.fn();
    const withSession = (value: React.ContextType<typeof SessionContext>) => (
      <SessionContext.Provider value={value}>
        <PushToggle />
      </SessionContext.Provider>
    );
    const view = renderWithSWR(withSession({ data: null, status: "loading", update }));
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true"));
    // Not while the session is still loading (the identity is unknown).
    expect(push.resyncSubscription).not.toHaveBeenCalled();

    view.rerender(
      <SWRConfig value={{ provider: () => new Map(), fetcher, dedupingInterval: 0, shouldRetryOnError: false }}>
        {withSession({ data: { user: { id: "user-a" }, expires: "2099-01-01" }, status: "authenticated", update })}
      </SWRConfig>,
    );
    await waitFor(() => expect(push.resyncSubscription).toHaveBeenLastCalledWith({ identity: "user-a" }));

    view.rerender(
      <SWRConfig value={{ provider: () => new Map(), fetcher, dedupingInterval: 0, shouldRetryOnError: false }}>
        {withSession({ data: null, status: "unauthenticated", update })}
      </SWRConfig>,
    );
    await waitFor(() => expect(push.resyncSubscription).toHaveBeenLastCalledWith({ identity: null }));
  });

  it("passes the signed-in identity when subscribing", async () => {
    const user = userEvent.setup();
    renderWithSWR(
      <SessionContext.Provider
        value={{ data: { user: { id: "user-b" }, expires: "2099-01-01" }, status: "authenticated", update: vi.fn() }}
      >
        <PushToggle coords={{ lat: 1, lon: 2 }} />
      </SessionContext.Provider>,
    );
    await user.click(await screen.findByRole("switch"));
    expect(push.subscribe.mock.calls[0][0].identity).toBe("user-b");
  });

  it("does not offer disaster alerts when the server does not send them", async () => {
    const user = userEvent.setup();
    vapid = { enabled: true, public_key: "VAPID-KEY", disaster_alerts: false };
    renderWithSWR(<PushToggle coords={{ lat: 28.6139, lon: 77.209 }} />);

    const disasters = await screen.findByRole("checkbox", { name: /Disaster alerts/ });
    expect(disasters).toBeDisabled();
    expect(disasters).not.toBeChecked();
    expect(screen.getByText(/disaster alert service is switched off/)).toBeInTheDocument();

    await user.click(screen.getByRole("switch"));
    expect(push.subscribe.mock.calls[0][0].topics).toEqual(["incidents"]);
  });

  it("turns notifications off and updates preferences while on", async () => {
    const user = userEvent.setup();
    push.getPushStatus.mockResolvedValue({ state: "subscribed", subscription: {}, prefs: PREFS_WITH_LOCATION });
    renderWithSWR(<PushToggle />);

    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(push.resyncSubscription).toHaveBeenCalledTimes(1));

    // Changing the radius re-registers with the stored location (no new location prompt).
    await user.selectOptions(screen.getByLabelText("Alert radius"), "100");
    await waitFor(() => expect(push.subscribe).toHaveBeenCalledTimes(1));
    const options = push.subscribe.mock.calls[0][0];
    expect(options.radiusKm).toBe(100);
    await expect(options.locate()).resolves.toEqual({ lat: 28.614, lon: 77.209 });

    // The last remaining topic cannot be unchecked.
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Nearby incidents/ })).toBeEnabled());
    await user.click(screen.getByRole("checkbox", { name: /Nearby incidents/ }));
    await waitFor(() => expect(push.subscribe).toHaveBeenCalledTimes(2));
    expect(push.subscribe.mock.calls[1][0].topics).toEqual(["disasters"]);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Disaster alerts/ })).toBeDisabled());

    await user.click(screen.getByRole("switch"));
    expect(push.unsubscribe).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false"));
  });
});
