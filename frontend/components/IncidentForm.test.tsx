import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
const auth = vi.hoisted(() => ({
  session: { user: { id: "u1", name: "Asha Rao", email: "asha@example.com" } } as null | {
    user: { id: string; name?: string; email?: string };
  },
  status: "authenticated" as "loading" | "authenticated" | "unauthenticated",
}));

vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/incidents/new" }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: auth.session, status: auth.status }),
  signOut: vi.fn(async () => ({ url: "http://localhost:3000/" })),
}));
vi.mock("next/dynamic", async () => {
  const ReactModule = await import("react");
  return {
    default: () =>
      function PickerMapStub(props: { onPick?: (point: { lat: number; lon: number }) => void }) {
        return ReactModule.createElement(
          "button",
          { type: "button", onClick: () => props.onPick?.({ lat: 28.6, lon: 77.2 }) },
          "stub pick",
        );
      },
  };
});

import { INCIDENT_DRAFT_KEY, IncidentForm, validateIncidentForm } from "@/components/IncidentForm";
import { errorResponse, jsonResponse, makeIncident, mockFetch } from "@/components/map/test-fixtures";
import { signOutAndForget } from "@/lib/sign-out";
import { setSigningOut } from "@/lib/user-data";

beforeEach(() => {
  auth.session = { user: { id: "u1", name: "Asha Rao", email: "asha@example.com" } };
  auth.status = "authenticated";
});

afterEach(() => {
  window.sessionStorage.clear();
  setSigningOut(false); // a successful sign-out leaves the page "signing out"
});

describe("validateIncidentForm", () => {
  const valid = {
    disaster_type: "fire",
    severity: "critical",
    description: "  Smoke from the warehouse on 5th street.  ",
    image_url: "",
    location: { lat: 28.6, lon: 77.2 },
  };

  it("builds the API body (trimmed description, no empty image_url)", () => {
    expect(validateIncidentForm(valid)).toEqual({
      ok: true,
      data: {
        lat: 28.6,
        lon: 77.2,
        disaster_type: "fire",
        severity: "critical",
        description: "Smoke from the warehouse on 5th street.",
      },
    });
    const withImage = validateIncidentForm({ ...valid, image_url: " https://example.com/a.jpg " });
    expect(withImage.ok && withImage.data.image_url).toBe("https://example.com/a.jpg");
  });

  it("reports one message per invalid field", () => {
    const result = validateIncidentForm({
      disaster_type: "",
      severity: "extreme",
      description: "short",
      image_url: "javascript:alert(1)",
      location: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      ["description", "disaster_type", "image_url", "location", "severity"].sort(),
    );
    expect(result.errors.description).toMatch(/at least 10 characters/);
    expect(result.errors.image_url).toMatch(/https:\/\//);
  });

  it("rejects descriptions over 1000 characters and out-of-range locations", () => {
    const result = validateIncidentForm({ ...valid, description: "x".repeat(1001), location: { lat: 91, lon: 0 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.description).toMatch(/under 1000/);
    expect(result.errors.location).toBeDefined();
  });
});

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByRole("combobox", { name: /What happened/ }), "fire");
  await user.click(screen.getByRole("radio", { name: /Critical/ }));
  await user.type(screen.getByRole("textbox", { name: /Description/ }), "Smoke pouring from the warehouse roof.");
  await user.click(screen.getByRole("button", { name: "Pick on map" }));
  await user.click(screen.getByRole("button", { name: "stub pick" }));
}

describe("IncidentForm", () => {
  it("shows inline errors and does not submit an invalid report", async () => {
    const { fetchMock } = mockFetch({});
    const user = userEvent.setup();
    render(<IncidentForm />);

    await user.click(screen.getByRole("button", { name: "Submit report" }));

    expect(screen.getByText("Choose what happened.")).toBeInTheDocument();
    expect(screen.getByText(/at least 10 characters/)).toBeInTheDocument();
    expect(screen.getByText(/Set the incident location/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /What happened/ })).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a valid report and redirects to the new incident", async () => {
    const created = makeIncident({ id: "new-1" });
    const { calls } = mockFetch({ "POST incidents": () => jsonResponse(created, 201) });
    const user = userEvent.setup();
    render(<IncidentForm />);

    expect(screen.getByText(/Reporting as/)).toHaveTextContent("Asha Rao");
    const counter = screen.getByText("0/1000");
    await fillValidForm(user);
    expect(counter).toHaveTextContent("38/1000");
    expect(window.sessionStorage.getItem(INCIDENT_DRAFT_KEY)).toContain("Smoke pouring");

    await user.click(screen.getByRole("button", { name: "Submit report" }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/incidents/new-1?created=1"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      lat: 28.6,
      lon: 77.2,
      disaster_type: "fire",
      severity: "critical",
      description: "Smoke pouring from the warehouse roof.",
    });
    expect(window.sessionStorage.getItem(INCIDENT_DRAFT_KEY)).toBeNull();
  });

  it("does not save the draft again after sign-out (review round 5)", async () => {
    // Regression: typing in the old page before the signed-out one loaded stored the
    // previous user's text where the next page restores drafts from.
    vi.stubGlobal("location", { origin: window.location.origin, href: window.location.href, assign: vi.fn(), reload: vi.fn() });
    const user = userEvent.setup();
    render(<IncidentForm />);
    await user.type(screen.getByRole("textbox", { name: /Description/ }), "First words");
    expect(window.sessionStorage.getItem(INCIDENT_DRAFT_KEY)).toContain("First words");

    await signOutAndForget("/");
    expect(window.sessionStorage.getItem(INCIDENT_DRAFT_KEY)).toBeNull();
    await user.type(screen.getByRole("textbox", { name: /Description/ }), " and more");
    expect(window.sessionStorage.getItem(INCIDENT_DRAFT_KEY)).toBeNull();
  });

  it("keeps the draft and offers sign-in when the session expired", async () => {
    mockFetch({ "POST incidents": () => errorResponse(401, "unauthorized", "Missing token") });
    const user = userEvent.setup();
    render(<IncidentForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/session has expired/i);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Fincidents%2Fnew",
    );
    expect(window.sessionStorage.getItem(INCIDENT_DRAFT_KEY)).toContain("Smoke pouring");
    expect(screen.getByRole("button", { name: "Submit report" })).toBeEnabled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows the backend's validation message", async () => {
    mockFetch({
      "POST incidents": () => errorResponse(422, "validation_error", "image_url: URL must be an absolute http(s) URL"),
    });
    const user = userEvent.setup();
    render(<IncidentForm />);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("URL must be an absolute http(s) URL");
  });

  it("restores a draft and can start over", async () => {
    window.sessionStorage.setItem(
      INCIDENT_DRAFT_KEY,
      JSON.stringify({ disaster_type: "flood", severity: "high", description: "Road under water", image_url: "" }),
    );
    const user = userEvent.setup();
    render(<IncidentForm />);

    expect(await screen.findByText(/restored your unsent draft/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Description/ })).toHaveValue("Road under water");
    expect(screen.getByRole("combobox", { name: /What happened/ })).toHaveValue("flood");
    expect(screen.getByRole("radio", { name: /High/ })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByRole("textbox", { name: /Description/ })).toHaveValue("");
    expect(screen.queryByText(/restored your unsent draft/)).not.toBeInTheDocument();
  });

  it("pre-fills the location passed in the URL", () => {
    render(<IncidentForm initialLocation={{ lat: 19.076, lon: 72.8777 }} />);
    expect(screen.getByText(/19\.07600°N, 72\.87770°E/)).toBeInTheDocument();
  });
});
