import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MapLayers, type MapLayersProps } from "@/components/MapLayers";
import { MAP_LAYERS } from "@/components/map/layers";

function setup(overrides: Partial<MapLayersProps> = {}) {
  const props: MapLayersProps = {
    enabled: ["hospital", "shelter", "incidents"],
    onToggle: vi.fn(),
    radiusKm: 5,
    onRadiusChange: vi.fn(),
    ...overrides,
  };
  const user = userEvent.setup();
  render(<MapLayers {...props} />);
  return { props, user };
}

describe("MapLayers", () => {
  it("renders one labelled checkbox per layer reflecting the enabled set", () => {
    setup();
    expect(screen.getByRole("region", { name: "Map layers" })).toBeInTheDocument();
    for (const layer of MAP_LAYERS) {
      const checkbox = screen.getByRole("checkbox", { name: new RegExp(layer.label) });
      if (["hospital", "shelter", "incidents"].includes(layer.id)) expect(checkbox).toBeChecked();
      else expect(checkbox).not.toBeChecked();
    }
    expect(screen.getByText("3 on")).toBeInTheDocument();
  });

  it("toggles layers on and off", async () => {
    const { props, user } = setup();
    await user.click(screen.getByRole("checkbox", { name: /Hospitals/ }));
    expect(props.onToggle).toHaveBeenLastCalledWith("hospital", false);
    await user.click(screen.getByRole("checkbox", { name: /Pharmacies/ }));
    expect(props.onToggle).toHaveBeenLastCalledWith("pharmacy", true);
  });

  it("shows per-layer counts, loading and errors independently, with retry", async () => {
    const onRetry = vi.fn();
    const { user } = setup({
      status: {
        hospital: { status: "ready", count: 12 },
        shelter: { status: "error", error: "Can't reach ResQ AI right now.", onRetry },
        incidents: { status: "loading" },
        // Disabled layers never show a status, even if one is passed.
        police: { status: "ready", count: 4 },
      },
    });

    expect(screen.getByText("12 hospitals found")).toBeInTheDocument();
    expect(screen.getByText("Loading incidents")).toBeInTheDocument();
    expect(screen.queryByText(/police found/i)).not.toBeInTheDocument();

    const shelterCheckbox = screen.getByRole("checkbox", { name: /Shelters/ });
    expect(shelterCheckbox).toHaveAccessibleDescription(expect.stringContaining("Can't reach ResQ AI right now."));
    expect(screen.getByRole("img", { name: "Shelters failed to load" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry shelters" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a stale-data warning while keeping the count", () => {
    setup({
      status: {
        hospital: {
          status: "ready",
          count: 3,
          error: "Couldn't refresh — showing earlier results.",
          onRetry: vi.fn(),
          refreshing: true,
        },
      },
    });
    expect(screen.getByText("3 hospitals found")).toBeInTheDocument();
    expect(screen.getByText("Couldn't refresh — showing earlier results.")).toBeInTheDocument();
    expect(screen.getByText("Refreshing hospitals")).toBeInTheDocument();
  });

  it("changes the radius and recenters", async () => {
    const onRecenter = vi.fn();
    const { props, user } = setup({ onRecenter });

    const radius = screen.getByRole("combobox", { name: "Search radius" });
    expect(within(radius).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "1 km",
      "2 km",
      "5 km",
      "10 km",
      "20 km",
    ]);
    await user.selectOptions(radius, "10");
    expect(props.onRadiusChange).toHaveBeenCalledWith(10);

    await user.click(screen.getByRole("button", { name: "Recenter on my location" }));
    expect(onRecenter).toHaveBeenCalledTimes(1);
  });

  it("uses layer notes as the description and offers a close button for the sheet", async () => {
    const onClose = vi.fn();
    const { user } = setup({
      enabled: ["disasters"],
      status: { disasters: { status: "ready", count: 1, note: "GDACS alerts within 300 km" } },
      onClose,
    });
    expect(screen.getByRole("checkbox", { name: /Disasters/ })).toHaveAccessibleDescription(
      "GDACS alerts within 300 km",
    );
    await user.click(screen.getByRole("button", { name: "Close map layers" }));
    expect(onClose).toHaveBeenCalled();
  });
});
