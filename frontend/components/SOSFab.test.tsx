import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

import SOSFab, { isSOSFabVisible } from "@/components/SOSFab";

beforeEach(() => {
  navigation.pathname = "/";
});

describe("SOSFab", () => {
  it("links to /sos from regular pages, on large screens only", () => {
    // Regression: below lg it duplicated the tab bar's SOS button and covered card buttons
    // and text (e.g. the first incident's "Details").
    for (const pathname of ["/", "/alerts", "/incidents", "/offline"]) {
      navigation.pathname = pathname;
      const { unmount } = render(<SOSFab />);
      const link = screen.getByRole("link", { name: /sos — send an emergency alert/i });
      expect(link).toHaveAttribute("href", "/sos");
      const classes = link.className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
      expect(classes).not.toContain("flex");
      unmount();
    }
  });

  it("is not rendered on the SOS page itself", () => {
    navigation.pathname = "/sos";
    const { container } = render(<SOSFab />);
    expect(container).toBeEmptyDOMElement();
    expect(isSOSFabVisible("/sos/anything")).toBe(false);
    expect(isSOSFabVisible("/sossy")).toBe(true);
  });

  it("is desktop-only on the chat page (the composer sits bottom-right on mobile)", () => {
    navigation.pathname = "/chat";
    render(<SOSFab />);
    const classes = screen.getByRole("link", { name: /sos/i }).className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
  });

  it("is desktop-only on the map (it would cover the OSM attribution on mobile)", () => {
    navigation.pathname = "/map";
    render(<SOSFab />);
    const classes = screen.getByRole("link", { name: /sos/i }).className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
  });
});
