import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: auth.signOut }));
// PushToggle has its own tests (owned by the alerts feature); isolate the profile page from it.
vi.mock("@/components/PushToggle", () => ({ PushToggle: () => <div>Push toggle</div> }));

import { CHAT_HISTORY_STORAGE_KEY } from "@/app/chat/chat-helpers";
import ProfileView, { accountProvider } from "@/app/profile/ProfileView";
import { fetcher } from "@/lib/api";

const USER = { id: "github:42", name: "Asha Rao", email: "asha@example.com" };

const EVENTS = [
  {
    id: "e1",
    timestamp: "2026-11-02T09:05:00Z",
    lat: 28.6139,
    lon: 77.209,
    message: "SOS! I'm trapped and can't get out.",
    contacts_count: 2,
    sms_sent: 1,
    sms_failed: 1,
  },
  {
    id: "e2",
    timestamp: "2026-10-30T18:00:00Z",
    lat: 19.076,
    lon: 72.8777,
    message: "SOS! I need help!",
    contacts_count: 0,
    sms_sent: 0,
    sms_failed: 0,
  },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Route = (init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

function renderProfile() {
  return render(
    <SWRConfig
      value={{ provider: () => new Map(), fetcher, dedupingInterval: 0, shouldRetryOnError: false, revalidateOnFocus: false }}
    >
      <ProfileView user={USER} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  routes = {
    "/api/backend/sos/history": () => jsonResponse({ events: EVENTS }),
    "/api/backend/push/test": () => jsonResponse({ sent: 2 }),
  };
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://localhost").pathname;
    const route = routes[path];
    return route ? route(init) : jsonResponse({ error: { code: "not_found", message: "nope", request_id: "" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
});

describe("ProfileView", () => {
  it("shows the account and how it signs in", () => {
    renderProfile();
    expect(screen.getByRole("heading", { name: "Asha Rao" })).toBeInTheDocument();
    expect(screen.getByText("asha@example.com")).toBeInTheDocument();
    expect(screen.getByText("Signed in with GitHub")).toBeInTheDocument();
    expect(screen.getByText("Push toggle")).toBeInTheDocument();
    expect(accountProvider("google:1")).toBe("Google");
    expect(accountProvider("0b8f…")).toBe("Email & password");
  });

  it("lists the SOS history with delivery results and map links", async () => {
    renderProfile();
    const history = screen.getByRole("heading", { name: "SOS history" }).closest("section") as HTMLElement;
    expect(within(history).getByRole("status")).toHaveTextContent(/loading sos history/i);

    expect(await within(history).findByText("SOS! I'm trapped and can't get out.")).toBeInTheDocument();
    expect(within(history).getByText("2 contacts")).toBeInTheDocument();
    expect(within(history).getByText("1 delivered")).toBeInTheDocument();
    expect(within(history).getByText("1 failed")).toBeInTheDocument();
    expect(within(history).getByText("No contacts texted")).toBeInTheDocument();
    expect(within(history).getAllByRole("link", { name: /view location/i })[0]).toHaveAttribute(
      "href",
      "https://maps.google.com/?q=28.613900,77.209000",
    );
  });

  it("shows an empty state, and errors with retry", async () => {
    routes["/api/backend/sos/history"] = () => jsonResponse({ events: [] });
    const first = renderProfile();
    expect(await screen.findByText("No SOS alerts yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open SOS" })).toHaveAttribute("href", "/sos");
    first.unmount();

    routes["/api/backend/sos/history"] = () =>
      jsonResponse({ error: { code: "internal_error", message: "Database unavailable", request_id: "r" } }, 500);
    const user = userEvent.setup();
    renderProfile();
    expect(await screen.findByText("SOS history couldn't be loaded")).toBeInTheDocument();
    routes["/api/backend/sos/history"] = () => jsonResponse({ events: EVENTS });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("SOS! I'm trapped and can't get out.")).toBeInTheDocument();
  });

  it("asks to sign in again when the session expired", async () => {
    routes["/api/backend/sos/history"] = () =>
      jsonResponse({ error: { code: "unauthorized", message: "Token expired", request_id: "" } }, 401);
    renderProfile();
    expect(await screen.findByText("Your session has expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?callbackUrl=%2Fprofile");
  });

  it("sends a test notification and reports the outcome inline", async () => {
    const user = userEvent.setup();
    renderProfile();
    await user.click(screen.getByRole("button", { name: /send test notification/i }));
    expect(await screen.findByText(/sent to 2 devices/i)).toBeInTheDocument();

    routes["/api/backend/push/test"] = () => jsonResponse({ sent: 0 });
    await user.click(screen.getByRole("button", { name: /send test notification/i }));
    expect(await screen.findByText(/no devices are subscribed yet/i)).toBeInTheDocument();

    routes["/api/backend/push/test"] = () =>
      jsonResponse({ error: { code: "not_configured", message: "Push disabled", request_id: "" } }, 503);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: /send test notification/i }));
    expect(await screen.findByText(/aren't set up on this server/i)).toBeInTheDocument();
  });

  it("signs out and forgets the chat transcript", async () => {
    window.sessionStorage.setItem(CHAT_HISTORY_STORAGE_KEY, "[]");
    auth.signOut.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderProfile();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: "/" }));
    expect(window.sessionStorage.getItem(CHAT_HISTORY_STORAGE_KEY)).toBeNull();
  });
});
