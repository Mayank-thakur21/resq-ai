import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string; name?: string } },
  status: "unauthenticated" as "loading" | "authenticated" | "unauthenticated",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: auth.session, status: auth.status }),
}));

import { IncidentCard } from "@/components/IncidentCard";
import { deferred, errorResponse, jsonResponse, makeIncident, mockFetch } from "@/components/map/test-fixtures";

function signIn(id = "u-viewer") {
  auth.session = { user: { id, name: "Viewer" } };
  auth.status = "authenticated";
}

beforeEach(() => {
  auth.session = null;
  auth.status = "unauthenticated";
});

describe("IncidentCard", () => {
  it("shows type, severity, verification, distance, reporter and links", () => {
    render(<IncidentCard incident={makeIncident({ verified: true, severity: "critical" })} />);

    const card = screen.getByRole("article", { name: "Flood" });
    expect(card).toHaveAttribute("id", "incident-inc-1");
    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("1.2 km away")).toBeInTheDocument();
    expect(screen.getByText("Reported 5 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Flood" })).toHaveAttribute("href", "/incidents/inc-1");
    expect(screen.getByRole("link", { name: /Details/ })).toHaveAttribute("href", "/incidents/inc-1");
    expect(screen.getByRole("link", { name: "Map" })).toHaveAttribute("href", "/map?lat=28.6139&lon=77.209");
  });

  it("marks highlighted and resolved incidents", () => {
    render(<IncidentCard incident={makeIncident({ status: "resolved" })} highlighted />);
    expect(screen.getByRole("article")).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByText("Highlighted")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("prompts signed-out users to sign in instead of calling the API", async () => {
    const { fetchMock } = mockFetch({});
    const user = userEvent.setup();
    render(<IncidentCard incident={makeIncident()} />);

    await user.click(screen.getByRole("button", { name: /Confirm this incident, 2 confirmations/ }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Sign in to confirm incidents/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Fincidents%3Ffocus%3Dinc-1",
    );
  });

  it("upvotes optimistically and reports the server copy", async () => {
    signIn();
    const response = deferred<Response>();
    const { calls } = mockFetch({ "POST incidents/inc-1/upvote": () => response.promise });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<IncidentCard incident={makeIncident()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Confirm this incident/ }));

    // Optimistic: count and pressed state change before the server answers.
    const pressed = screen.getByRole("button", { name: /You confirmed this incident, 3 confirmations/ });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("upvote-count")).toHaveTextContent("3");
    expect(calls).toHaveLength(1);

    const updated = makeIncident({ upvotes: 3, upvoted_by_me: true, verified: true });
    await act(async () => {
      response.resolve(jsonResponse(updated));
    });

    expect(onChange).toHaveBeenCalledWith(updated);
    expect(screen.getByTestId("upvote-count")).toHaveTextContent("3");
  });

  it("rolls back and explains when the upvote fails", async () => {
    signIn();
    mockFetch({ "POST incidents/inc-1/upvote": () => errorResponse(500, "internal_error", "Database is down") });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<IncidentCard incident={makeIncident()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Confirm this incident/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Database is down");
    expect(screen.getByTestId("upvote-count")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /Confirm this incident, 2 confirmations/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("asks to sign in again when the session expired (401)", async () => {
    signIn();
    mockFetch({ "POST incidents/inc-1/upvote": () => errorResponse(401, "unauthorized", "Token expired") });
    const user = userEvent.setup();
    render(<IncidentCard incident={makeIncident()} />);

    await user.click(screen.getByRole("button", { name: /Confirm this incident/ }));

    expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByTestId("upvote-count")).toHaveTextContent("2");
  });

  it("does not let reporters confirm their own report", () => {
    signIn("u-reporter");
    render(<IncidentCard incident={makeIncident()} />);
    expect(screen.getByRole("button", { name: /Your report, 2 confirmations/ })).toBeDisabled();
  });

  it("treats an existing upvote as final (idempotent)", async () => {
    signIn();
    const { fetchMock } = mockFetch({});
    const user = userEvent.setup();
    render(<IncidentCard incident={makeIncident({ upvoted_by_me: true, upvotes: 4 })} />);

    const button = screen.getByRole("button", { name: /You confirmed this incident, 4 confirmations/ });
    expect(button).toHaveAttribute("aria-pressed", "true");
    await user.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets fresher props win over a previous optimistic value", async () => {
    signIn();
    mockFetch({
      "POST incidents/inc-1/upvote": () => jsonResponse(makeIncident({ upvotes: 3, upvoted_by_me: true })),
    });
    const user = userEvent.setup();
    const { rerender } = render(<IncidentCard incident={makeIncident()} />);
    await user.click(screen.getByRole("button", { name: /Confirm this incident/ }));
    expect(await screen.findByTestId("upvote-count")).toHaveTextContent("3");

    // A background refresh brings newer numbers (someone else confirmed too).
    rerender(<IncidentCard incident={makeIncident({ upvotes: 7, upvoted_by_me: true })} />);
    expect(screen.getByTestId("upvote-count")).toHaveTextContent("7");
  });
});
