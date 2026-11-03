import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signOut: vi.fn(async () => ({ url: "http://localhost:3000/" })) }));
vi.mock("next-auth/react", () => ({ signOut: auth.signOut }));

import ChatView from "@/app/chat/ChatView";
import { CHAT_HISTORY_STORAGE_KEY } from "@/app/chat/chat-helpers";
import { signOutAndForget } from "@/lib/sign-out";
import type { ChatResponse } from "@/lib/types";
import { setSigningOut } from "@/lib/user-data";

const REPLY: ChatResponse = {
  response: "**Move to higher ground** now.",
  agent_used: "safety_agent",
  urgency_level: "high",
  detected_disaster: "flood",
  advisory: "Heavy rain expected for the next 3 hours.",
  recommended_actions: ["Turn off electricity", "Avoid floodwater"],
  emergency_numbers: ["112 (International Emergency)", "108 (Ambulance, India)"],
  steps_taken: ["Router Agent classified the request", "Mapping Agent found nearby places"],
  data: {
    hospitals: [
      { id: "h1", name: "AIIMS", type: "hospital", lat: 28.567, lon: 77.21, distance_km: 2.4, address: "Ansari Nagar", phone: "+911126588500" },
    ],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(REPLY));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window.navigator, "geolocation");
  setSigningOut(false); // a successful sign-out leaves the page "signing out"
});

describe("ChatView", () => {
  it("does not store the transcript again when an answer lands after sign-out (review round 5)", async () => {
    // Regression: the answer re-rendered the old page before the signed-out one loaded, and
    // the history effect wrote the whole transcript back into this tab's sessionStorage.
    vi.stubGlobal("location", { origin: window.location.origin, href: window.location.href, assign: vi.fn(), reload: vi.fn() });
    let deliver: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (deliver = resolve)));
    const user = userEvent.setup();
    render(<ChatView />);

    await user.type(screen.getByLabelText("Describe your situation"), "PRIVATE where can I go tonight?{Enter}");
    await waitFor(() => expect(window.sessionStorage.getItem(CHAT_HISTORY_STORAGE_KEY)).toContain("PRIVATE"));

    await signOutAndForget("/");
    expect(window.sessionStorage.getItem(CHAT_HISTORY_STORAGE_KEY)).toBeNull();

    deliver(jsonResponse(REPLY));
    // The page still shows the answer until it is replaced, but stores nothing for the next one.
    expect(await screen.findByText("Move to higher ground")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(CHAT_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it("sends a message through the API proxy and renders the agents' structured answer", async () => {
    const user = userEvent.setup();
    render(<ChatView />);

    await user.type(screen.getByLabelText("Describe your situation"), "Water is entering my house{Enter}");

    expect(await screen.findByText("Move to higher ground")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/backend/chat");
    expect(JSON.parse(String(init.body))).toEqual({ message: "Water is entering my house", language: "en" });

    expect(screen.getByText("Water is entering my house")).toBeInTheDocument();
    expect(screen.getByText("Flood")).toBeInTheDocument();
    expect(screen.getByText("Urgency: high")).toBeInTheDocument();
    expect(screen.getByText("Turn off electricity")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Call 112, International Emergency" })).toHaveAttribute("href", "tel:112");
    expect(screen.getByText("Heavy rain expected for the next 3 hours.")).toBeInTheDocument();

    const hospitals = screen.getByRole("heading", { name: "Nearby hospitals" }).parentElement as HTMLElement;
    expect(within(hospitals).getByText("AIIMS")).toBeInTheDocument();
    expect(within(hospitals).getByText("2.4 km")).toBeInTheDocument();
    expect(within(hospitals).getByRole("link", { name: /directions/i })).toHaveAttribute(
      "href",
      "https://maps.google.com/?q=28.567000,77.210000",
    );

    // The transcript survives navigation within the tab.
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(CHAT_HISTORY_STORAGE_KEY) ?? "[]")).toHaveLength(2),
    );
  });

  it("shows an inline error bubble with Retry instead of an alert", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "rate_limited", message: "Too many", request_id: "r1" } }, 429),
    );
    const user = userEvent.setup();
    render(<ChatView />);

    await user.type(screen.getByLabelText("Describe your situation"), "Earthquake!{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/too many requests/i);
    expect(consoleWarn).toHaveBeenCalled();

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Move to higher ground")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).message).toBe("Earthquake!");
  });

  it("attaches the location only after the user shares it", async () => {
    Object.defineProperty(window.navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: vi.fn((success: PositionCallback) =>
          success({ coords: { latitude: 19.076, longitude: 72.8777, accuracy: 10 }, timestamp: 1 } as GeolocationPosition),
        ),
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      },
    });
    const user = userEvent.setup();
    render(<ChatView />);
    expect(window.navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Share my location" }));
    expect(await screen.findByText("Location shared (±10 m).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop sharing location" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Find the nearest hospital" }));
    await screen.findByText("Move to higher ground");
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      message: "Find the nearest hospital",
      language: "en",
      location: { lat: 19.076, lon: 72.8777 },
    });
  });

  it("explains inline when voice input isn't supported", async () => {
    render(<ChatView />);
    fireEvent.click(screen.getByRole("button", { name: "Speak your message" }));
    expect(await screen.findByText(/voice input isn't supported in this browser/i)).toBeInTheDocument();
  });

  it("uses the selected answer language and restores the transcript", async () => {
    window.sessionStorage.setItem(
      CHAT_HISTORY_STORAGE_KEY,
      JSON.stringify([{ id: "u1", role: "user", content: "Earlier question", createdAt: 1 }]),
    );
    const user = userEvent.setup();
    render(<ChatView />);
    expect(await screen.findByText("Earlier question")).toBeInTheDocument();
    // Suggestions are only offered for a fresh conversation.
    expect(screen.queryByRole("group", { name: "Suggestions" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Answer language"), "hi");
    await user.type(screen.getByLabelText("Describe your situation"), "Help{Enter}");
    await screen.findByText("Move to higher ground");
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).language).toBe("hi");

    await user.click(screen.getByRole("button", { name: "Clear conversation" }));
    expect(screen.queryByText("Earlier question")).not.toBeInTheDocument();
  });
});
