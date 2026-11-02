import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Leaflet cannot run in jsdom: replace the dynamically imported mini-map with a stub that
// "picks" a fixed point.
vi.mock("next/dynamic", async () => {
  const ReactModule = await import("react");
  return {
    default: () =>
      function PickerMapStub(props: { onPick?: (point: { lat: number; lon: number }) => void }) {
        return ReactModule.createElement(
          "div",
          { "data-testid": "picker-map" },
          ReactModule.createElement(
            "button",
            { type: "button", onClick: () => props.onPick?.({ lat: 12.3456789, lon: 77.6543219 }) },
            "stub pick",
          ),
        );
      },
  };
});

import { LocationPicker, parseCoordinateInput } from "@/components/LocationPicker";
import type { LatLon } from "@/lib/types";

function Harness({ onChange, initial = null }: { onChange: (value: LatLon | null) => void; initial?: LatLon | null }) {
  const [value, setValue] = React.useState<LatLon | null>(initial);
  return (
    <LocationPicker
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

type SuccessCb = (position: GeolocationPosition) => void;
type ErrorCb = (error: GeolocationPositionError) => void;

function installGeolocation(behaviour: { lat: number; lon: number; accuracy: number } | { code: number }) {
  const getCurrentPosition = vi.fn((success: SuccessCb, error: ErrorCb) => {
    setTimeout(() => {
      if ("code" in behaviour) {
        error({ code: behaviour.code, message: "" } as GeolocationPositionError);
      } else {
        success({
          coords: { latitude: behaviour.lat, longitude: behaviour.lon, accuracy: behaviour.accuracy },
          timestamp: Date.now(),
        } as GeolocationPosition);
      }
    }, 0);
  });
  Object.defineProperty(navigator, "geolocation", {
    value: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() },
    configurable: true,
  });
  return getCurrentPosition;
}

afterEach(() => {
  Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
});

describe("parseCoordinateInput", () => {
  it("accepts decimal points or commas within range", () => {
    expect(parseCoordinateInput(" 28.6139 ", 90)).toBe(28.6139);
    expect(parseCoordinateInput("-77,21", 180)).toBe(-77.21);
    expect(parseCoordinateInput("+12", 90)).toBe(12);
  });

  it("rejects text, empty and out-of-range values", () => {
    expect(parseCoordinateInput("", 90)).toBeNull();
    expect(parseCoordinateInput("abc", 90)).toBeNull();
    expect(parseCoordinateInput("1e3", 180)).toBeNull();
    expect(parseCoordinateInput("90.5", 90)).toBeNull();
    expect(parseCoordinateInput("180.0001", 180)).toBeNull();
  });
});

describe("LocationPicker", () => {
  it("uses a one-shot GPS fix when asked, rounded to 5 decimals", async () => {
    const getCurrentPosition = installGeolocation({ lat: 28.613912345, lon: 77.209012345, accuracy: 18 });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    // Nothing is requested until the user asks.
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Use my current location" }));

    expect(await screen.findByText(/Selected:/)).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith({ lat: 28.61391, lon: 77.20901 });
    expect(screen.getByText(/±18 m/)).toBeInTheDocument();
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true }),
    );
  });

  it("explains a denied permission inline and offers the map instead", async () => {
    installGeolocation({ code: 1 });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Use my current location" }));
    expect(await screen.findByText(/Location permission was denied/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Pick on the map instead" }));
    expect(screen.getByTestId("picker-map")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick on map" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reports unsupported browsers without crashing", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Use my current location" }));
    expect(screen.getByText("This device or browser does not support location.")).toBeInTheDocument();
  });

  it("picks a point on the mini-map and can clear it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Pick on map" }));
    await user.click(screen.getByRole("button", { name: "stub pick" }));
    expect(onChange).toHaveBeenLastCalledWith({ lat: 12.34568, lon: 77.65432 });
    expect(screen.getByText(/12\.34568°N, 77\.65432°E/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Check in Google Maps/ })).toHaveAttribute(
      "href",
      "https://maps.google.com/?q=12.345680,77.654320",
    );

    await user.click(screen.getByRole("button", { name: /Clear/ }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText("No location selected yet.")).toBeInTheDocument();
  });

  it("accepts manual coordinates once both are valid and flags invalid ones", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Coordinates" }));
    const lat = screen.getByLabelText("Latitude");
    const lon = screen.getByLabelText("Longitude");

    await user.type(lat, "95");
    await user.type(lon, "77,25");
    await user.tab();
    expect(screen.getByText("Enter a latitude between -90 and 90.")).toBeInTheDocument();
    expect(lat).toHaveAttribute("aria-invalid", "true");
    expect(onChange).not.toHaveBeenCalled();

    await user.clear(lat);
    await user.type(lat, "-12.5");
    expect(onChange).toHaveBeenLastCalledWith({ lat: -12.5, lon: 77.25 });
    expect(screen.queryByText("Enter a latitude between -90 and 90.")).not.toBeInTheDocument();
  });

  it("starts on the map with an initial value and shows it as selected", () => {
    render(<Harness onChange={vi.fn()} initial={{ lat: 19.076, lon: 72.8777 }} />);
    expect(screen.getByTestId("picker-map")).toBeInTheDocument();
    expect(screen.getByText(/19\.07600°N, 72\.87770°E/)).toBeInTheDocument();
  });
});
