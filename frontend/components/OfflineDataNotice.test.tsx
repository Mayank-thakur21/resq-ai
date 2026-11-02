import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OfflineDataNotice } from "@/components/OfflineDataNotice";

const META = Symbol.for("resq.responseMeta");

function saved(cachedAt: string | null, extra: Record<string, unknown> = {}): object {
  const body = { events: [] };
  Object.defineProperty(body, META, { value: { offline: true, cachedAt, ...extra }, enumerable: false });
  return body;
}

describe("OfflineDataNotice", () => {
  it("renders nothing for live data", () => {
    const { container } = render(<OfflineDataNotice data={{ events: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels saved data with its age", () => {
    render(<OfflineDataNotice data={saved(new Date(Date.now() - 3 * 3600_000).toISOString())} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Showing saved data from 3 hours ago/);
  });

  it("uses the oldest saved copy among several responses", () => {
    const recent = saved(new Date(Date.now() - 5 * 60_000).toISOString());
    const old = saved(new Date(Date.now() - 2 * 86_400_000).toISOString());
    render(<OfflineDataNotice data={[{ live: true }, recent, old, undefined]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/2 days ago/);
  });

  it("still warns when the save time is unknown", () => {
    render(<OfflineDataNotice data={saved(null)} compact />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing saved data — you're offline");
  });

  it("mentions a saved copy fetched for another spot, and server trouble", () => {
    const { unmount } = render(<OfflineDataNotice data={saved(null, { distanceM: 1250 })} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing saved data for a spot 1.3 km away — you're offline or the connection is very slow.",
    );
    unmount();
    render(<OfflineDataNotice data={[saved(null, { distanceM: 40, reason: "server-error" })]} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing saved data — the ResQ AI service is having trouble right now.",
    );
  });
});
