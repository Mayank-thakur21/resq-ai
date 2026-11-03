import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/" }));
const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string; name?: string; email?: string } },
  status: "unauthenticated" as "loading" | "authenticated" | "unauthenticated",
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: auth.session, status: auth.status }),
  signOut: auth.signOut,
}));

import Navbar, { isActivePath, loginHref } from "@/components/Navbar";
import { shouldRetryOnError } from "@/components/Providers";
import { ApiError } from "@/lib/api";

beforeEach(() => {
  navigation.pathname = "/";
  auth.session = null;
  auth.status = "unauthenticated";
});

describe("Navbar", () => {
  it("marks the current page with aria-current in both navigations", () => {
    navigation.pathname = "/map";
    render(<Navbar />);

    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getByRole("link", { name: "Map" })).toHaveAttribute("aria-current", "page");
    expect(within(main).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");

    const tabs = screen.getByRole("navigation", { name: "Primary" });
    expect(within(tabs).getByRole("link", { name: "Map" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "SOS emergency" })).toHaveAttribute("href", "/sos");
  });

  it("offers sign-in that returns to the current page when signed out", () => {
    navigation.pathname = "/alerts";
    render(<Navbar />);
    const links = screen.getAllByRole("link", { name: /sign in/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/login?callbackUrl=%2Falerts");
    }
  });

  it("shows the account menu with Profile and Sign out when signed in", async () => {
    auth.session = { user: { id: "u1", name: "Asha Rao", email: "asha@example.com" } };
    auth.status = "authenticated";
    const user = userEvent.setup();
    render(<Navbar />);

    const toggle = screen.getByRole("button", { name: /account menu for asha rao/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("link", { name: "Profile" })[0]).toHaveAttribute("href", "/profile");

    // Sign-out also forgets per-user data cached on the device (SW API cache, chat transcript).
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage } },
    });
    window.sessionStorage.setItem("resq_chat_history", "[]");
    // jsdom cannot load another page; the sign-out ends with a full page load of "/".
    const assign = vi.fn();
    vi.stubGlobal("location", { origin: window.location.origin, href: window.location.href, assign, reload: vi.fn() });
    try {
      await user.click(screen.getByRole("button", { name: "Sign out" }));
      expect(auth.signOut).toHaveBeenCalledWith({ callbackUrl: "/", redirect: false });
      await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
      expect(postMessage).toHaveBeenCalledWith({ type: "CLEAR_API_CACHE" });
      expect(window.sessionStorage.getItem("resq_chat_history")).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("opens the mobile More sheet as a dialog and closes it with Escape", async () => {
    const user = userEvent.setup();
    render(<Navbar />);

    await user.click(screen.getByRole("button", { name: "More pages" }));
    const dialog = await screen.findByRole("dialog", { name: "More" });
    expect(within(dialog).getByRole("link", { name: "Incidents" })).toHaveAttribute("href", "/incidents");
    expect(within(dialog).getByRole("link", { name: "Checklist" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("navigation helpers", () => {
  it("isActivePath matches exact and nested paths only", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/map", "/")).toBe(false);
    expect(isActivePath("/incidents/123", "/incidents")).toBe(true);
    expect(isActivePath("/incidentsx", "/incidents")).toBe(false);
    expect(isActivePath(null, "/map")).toBe(false);
  });

  it("loginHref skips callbackUrl for home and auth pages", () => {
    expect(loginHref("/")).toBe("/login");
    expect(loginHref("/login")).toBe("/login");
    expect(loginHref("/register")).toBe("/login");
    expect(loginHref("/incidents/new")).toBe("/login?callbackUrl=%2Fincidents%2Fnew");
  });
});

describe("SWR retry policy", () => {
  it("does not retry 4xx errors except 408/429, but retries network and 5xx errors", () => {
    expect(shouldRetryOnError(new ApiError(404, "not_found", "x"))).toBe(false);
    expect(shouldRetryOnError(new ApiError(401, "unauthorized", "x"))).toBe(false);
    expect(shouldRetryOnError(new ApiError(429, "rate_limited", "x"))).toBe(true);
    expect(shouldRetryOnError(new ApiError(502, "backend_unreachable", "x"))).toBe(true);
    expect(shouldRetryOnError(new ApiError(0, "network_error", "x"))).toBe(true);
    expect(shouldRetryOnError(new ApiError(0, "aborted", "x"))).toBe(false);
    expect(shouldRetryOnError(new Error("boom"))).toBe(true);
  });
});
