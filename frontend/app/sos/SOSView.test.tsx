import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string; name?: string } },
  status: "unauthenticated" as "authenticated" | "unauthenticated" | "loading",
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: auth.session, status: auth.status }) }));

import SOSView, { SOS_NAME_STORAGE_KEY } from "@/app/sos/SOSView";
import { CONTACTS_STORAGE_KEY, resetContactsMemoryForTests } from "@/lib/contacts";
import { identityTag } from "@/lib/identity";
import { forgetUserData } from "@/lib/sign-out";
import { readSosName } from "@/lib/sos-name";

type Geo = "ok" | "denied";

function mockGeolocation(mode: Geo) {
  const position = { coords: { latitude: 28.6139, longitude: 77.209, accuracy: 15 }, timestamp: Date.now() };
  const error = { code: 1, message: "denied" };
  const respond = (success: PositionCallback, failure?: PositionErrorCallback | null) => {
    if (mode === "ok") success(position as unknown as GeolocationPosition);
    else failure?.(error as GeolocationPositionError);
  };
  Object.defineProperty(window.navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: vi.fn((success: PositionCallback, failure?: PositionErrorCallback | null) => {
        respond(success, failure);
        return 1;
      }),
      getCurrentPosition: vi.fn((success: PositionCallback, failure?: PositionErrorCallback | null) =>
        respond(success, failure),
      ),
      clearWatch: vi.fn(),
    },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SOS_RESPONSE = {
  id: "sos-1",
  timestamp: "2026-11-02T09:05:00Z",
  maps_link: "https://maps.google.com/?q=28.6139,77.209",
  message: "SOS! I need help!",
  fallback_sms_uri: "sms:+919876543210?&body=SOS",
};

function renderView() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SOSView />
    </SWRConfig>,
  );
}

async function sendViaTwoStep() {
  fireEvent.click(await screen.findByRole("button", { name: /send in two steps/i }));
  fireEvent.click(screen.getByRole("button", { name: "Send SOS now" }));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  auth.session = null;
  auth.status = "unauthenticated";
  window.localStorage.clear();
  resetContactsMemoryForTests();
  window.localStorage.setItem(
    CONTACTS_STORAGE_KEY,
    JSON.stringify([
      { name: "Mom", phone: "+91 98765 43210", custom: true },
      { name: "Dad", phone: "98765 01234", custom: true },
    ]),
  );
  mockGeolocation("ok");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // Unmount first: the geolocation hook clears its watch on unmount.
  cleanup();
  Reflect.deleteProperty(window.navigator, "geolocation");
  Reflect.deleteProperty(window.navigator, "onLine");
});

describe("SOSView", () => {
  it("lists only E.164 contacts as selectable and explains how to fix the others", async () => {
    renderView();
    const mom = await screen.findByRole("checkbox", { name: /mom/i });
    expect(mom).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /dad/i })).not.toBeInTheDocument();
    expect(screen.getByText(/add the country code/i)).toBeInTheDocument();
    expect(await screen.findByText("Location found")).toBeInTheDocument();
    expect(screen.getByText("±15 m", { exact: false })).toBeInTheDocument();
  });

  it("sends the SOS and offers the SMS app when automatic texting isn't configured", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...SOS_RESPONSE, sms: { configured: false, sent: [], failed: [] } }),
    );
    renderView();
    await screen.findByText("Location found");
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Asha" } });
    await sendViaTwoStep();

    expect(await screen.findByRole("heading", { name: /sos saved — now send it from your phone/i })).toHaveFocus();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/backend/sos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      lat: 28.6139,
      lon: 77.209,
      accuracy_m: 15,
      message: "SOS! I need help!",
      contact_numbers: ["+919876543210"],
      user_name: "Asha",
    });
    expect(screen.getByRole("link", { name: /open sms app/i })).toHaveAttribute("href", SOS_RESPONSE.fallback_sms_uri);
    expect(screen.getByRole("link", { name: /call 112/i })).toHaveAttribute("href", "tel:112");
    expect(readSosName("")).toBe("Asha"); // remembered for anonymous use on this device
  });

  it("shows per-contact delivery results when texts were sent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...SOS_RESPONSE,
        sms: { configured: true, sent: [{ to: "+91******3210", sid: "SM1", status: "queued" }], failed: [] },
      }),
    );
    renderView();
    await screen.findByText("Location found");
    await sendViaTwoStep();

    expect(await screen.findByRole("heading", { name: "SOS sent to 1 contact" })).toBeInTheDocument();
    const delivery = screen.getByRole("heading", { name: "Delivery" }).parentElement as HTMLElement;
    expect(within(delivery).getByText("Mom")).toBeInTheDocument();
    expect(within(delivery).getByText("Queued")).toBeInTheDocument();
    // Everything was delivered: the SMS button is offered, but not as the primary action.
    expect(screen.getByRole("link", { name: /open sms app/i }).className).not.toContain("bg-red-600");

    fireEvent.click(screen.getByRole("button", { name: /done — back to sos/i }));
    expect(await screen.findByRole("button", { name: /hold to send sos/i })).toBeInTheDocument();
  });

  it("falls back to the phone's SMS app with a locally built message when the request fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderView();
    await screen.findByText("Location found");
    await sendViaTwoStep();

    expect(await screen.findByText("Couldn't send your SOS")).toBeInTheDocument();
    const sms = screen.getAllByRole("link", { name: /open sms app/i })[0];
    const href = sms.getAttribute("href") ?? "";
    expect(href.startsWith("sms:+919876543210?&body=")).toBe(true);
    const body = decodeURIComponent(href.split("body=")[1]);
    expect(body).toContain("SOS from Anonymous: SOS! I need help!");
    expect(body).toContain("https://maps.google.com/?q=28.613900,77.209000");
    expect(consoleWarn).toHaveBeenCalledWith("[sos] request failed", expect.anything());

    fetchMock.mockImplementation(async () =>
      jsonResponse({ ...SOS_RESPONSE, sms: { configured: false, sent: [], failed: [] } }),
    );
    fireEvent.click(screen.getByRole("button", { name: /try sending again/i }));
    expect(await screen.findByRole("heading", { name: /sos saved/i })).toBeInTheDocument();
  });

  it("skips the network entirely when the browser is offline", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    renderView();
    await screen.findByText("Location found");
    await sendViaTwoStep();
    expect(await screen.findByText(/you're offline — sos not sent automatically/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends without a real location but keeps the fallbacks available", async () => {
    mockGeolocation("denied");
    renderView();
    expect(await screen.findByText(/location permission was denied/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hold to send sos/i })).toBeDisabled();
    const other = screen.getByRole("heading", { name: "Other ways to get help" }).parentElement as HTMLElement;
    const href = within(other).getByRole("link", { name: /open sms app/i }).getAttribute("href") ?? "";
    expect(decodeURIComponent(href)).not.toContain("Location:");
    expect(within(other).getByRole("link", { name: /call 112/i })).toHaveAttribute("href", "tel:112");
  });

  it("prefills the sender name from the account", async () => {
    auth.session = { user: { id: "u1", name: "Ravi Kumar" } };
    auth.status = "authenticated";
    renderView();
    await waitFor(() => expect(screen.getByLabelText(/your name/i)).toHaveValue("Ravi Kumar"));
    expect(screen.getByText(/saved to your profile history/i)).toBeInTheDocument();
  });
});


describe("SOSView sender name (review round 3)", () => {
  function sentBody(call = 0) {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return JSON.parse(String(init.body)) as { user_name?: string };
  }

  beforeEach(() => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ ...SOS_RESPONSE, sms: { configured: false, sent: [], failed: [] } }),
    );
  });

  it("never sends the previous account's name for the next signed-in user", async () => {
    // Regression: Alice's prefilled name was stored, survived sign-out and won over Bob's
    // session name, so Bob's SOS went out as "SOS from Alice Upvoter".
    auth.session = { user: { id: "alice", name: "Alice Upvoter" } };
    auth.status = "authenticated";
    renderView();
    await screen.findByText("Location found");
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Alice Upvoter");
    await sendViaTwoStep();
    await screen.findByRole("heading", { name: /sos saved/i });
    expect(sentBody().user_name).toBe("Alice Upvoter");
    cleanup();

    await forgetUserData(); // Alice signs out
    expect(window.localStorage.getItem(SOS_NAME_STORAGE_KEY)).toBeNull();

    auth.session = { user: { id: "bob", name: "Bob Reporter" } };
    renderView();
    await screen.findByText("Location found");
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Bob Reporter");
    await sendViaTwoStep();
    await screen.findByRole("heading", { name: /sos saved/i });
    expect(sentBody(1).user_name).toBe("Bob Reporter");
  });

  it("ignores a name remembered for another identity, even without a sign-out", async () => {
    window.localStorage.setItem(
      SOS_NAME_STORAGE_KEY,
      JSON.stringify({ name: "Alice Upvoter", owner: identityTag("alice") }),
    );
    // Bob's session arrives late (loading first): the name must not flash Alice's either.
    auth.session = null;
    auth.status = "loading";
    const view = renderView();
    await screen.findByText("Location found");
    expect(screen.getByLabelText(/your name/i)).toHaveValue("");
    auth.session = { user: { id: "bob", name: "Bob Reporter" } };
    auth.status = "authenticated";
    view.rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SOSView />
      </SWRConfig>,
    );
    await waitFor(() => expect(screen.getByLabelText(/your name/i)).toHaveValue("Bob Reporter"));
    cleanup();

    // An anonymous visitor (e.g. after Alice's session expired) does not get it either.
    auth.session = null;
    auth.status = "unauthenticated";
    renderView();
    await screen.findByText("Location found");
    expect(screen.getByLabelText(/your name/i)).toHaveValue("");
  });

  it("keeps a name the same account chose, and ignores old plain-text values", async () => {
    auth.session = { user: { id: "bob", name: "Bob Reporter" } };
    auth.status = "authenticated";
    window.localStorage.setItem(
      SOS_NAME_STORAGE_KEY,
      JSON.stringify({ name: "Bob R. (blue house)", owner: identityTag("bob") }),
    );
    renderView();
    await screen.findByText("Location found");
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Bob R. (blue house)");
    cleanup();

    window.localStorage.setItem(SOS_NAME_STORAGE_KEY, "Alice Upvoter"); // pre-upgrade format
    renderView();
    await screen.findByText("Location found");
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Bob Reporter");
  });
});
