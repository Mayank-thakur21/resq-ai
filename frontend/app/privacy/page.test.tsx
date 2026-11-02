import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PrivacyPage, { metadata } from "@/app/privacy/page";

describe("/privacy", () => {
  it("describes what is actually stored (no 'location is never stored' promise)", () => {
    // Regression: the page claimed location was never stored, while SOS events, incident
    // reports and push subscriptions persist it.
    const { container } = render(<PrivacyPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/do not store your location/i);
    expect(screen.getByRole("heading", { name: "SOS events" })).toBeInTheDocument();
    expect(text).toMatch(/exact location/i);
    expect(text).toMatch(/visible to everyone/i);
    expect(text).toMatch(/rounded to about\s+110 m/i);
    expect(text).toMatch(/phone numbers\s+are not stored/i);
    for (const service of ["OpenStreetMap", "Overpass", "Google Gemini", "Twilio", "GDACS"]) {
      expect(text).toContain(service);
    }
    expect(metadata.title).toBe("Privacy");
  });
});
