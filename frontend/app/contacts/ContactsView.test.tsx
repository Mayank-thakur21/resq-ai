import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildStatusMessage } from "@/app/contacts/_components/ShareStatusCards";
import ContactsView from "@/app/contacts/ContactsView";
import { CONTACTS_STORAGE_KEY, resetContactsMemoryForTests } from "@/lib/contacts";

function stored(): Array<{ name: string; phone: string }> {
  return JSON.parse(window.localStorage.getItem(CONTACTS_STORAGE_KEY) ?? "[]");
}

beforeEach(() => {
  window.localStorage.clear();
  resetContactsMemoryForTests();
  Object.defineProperty(window.navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: vi.fn((success: PositionCallback) =>
        success({ coords: { latitude: 28.6139, longitude: 77.209, accuracy: 20 }, timestamp: 1 } as GeolocationPosition),
      ),
      watchPosition: vi.fn(),
      clearWatch: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window.navigator, "geolocation");
});

describe("ContactsView", () => {
  it("links the help card to the SOS flow instead of a share-only SOS", () => {
    render(<ContactsView />);
    expect(screen.getByRole("link", { name: /send an sos/i })).toHaveAttribute("href", "/sos");
    expect(screen.getByRole("link", { name: /open sos/i })).toHaveAttribute("href", "/sos");
    // Built-in services are always listed and callable.
    expect(screen.getByRole("link", { name: "Call National Emergency" })).toHaveAttribute("href", "tel:112");
  });

  it("validates, stores in E.164 and flags numbers without a country code", async () => {
    const user = userEvent.setup();
    render(<ContactsView />);
    const form = screen.getByRole("form", { name: "Add a trusted contact" });

    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(within(form).getByText("Enter a name.")).toBeInTheDocument();
    expect(within(form).getByText("Enter a phone number.")).toBeInTheDocument();
    expect(within(form).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");

    await user.type(within(form).getByLabelText("Name"), "Mom");
    await user.type(within(form).getByLabelText("Phone number"), "+91 98765 43210");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Mom was added and can receive SOS texts.")).toBeInTheDocument();
    expect(stored()).toEqual([{ name: "Mom", phone: "+919876543210", custom: true }]);
    expect(screen.getByText("SOS ready")).toBeInTheDocument();

    await user.type(within(form).getByLabelText("Name"), "Dad");
    await user.type(within(form).getByLabelText("Phone number"), "98765 01234");
    expect(screen.getByText(/start with \+ and the country code/i)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/dad was added\. without a country code/i)).toBeInTheDocument();
    expect(screen.getByText("No country code")).toBeInTheDocument();
    expect(screen.getByText(/1 contact has no country code/i)).toBeInTheDocument();

    await user.type(within(form).getByLabelText("Name"), "Mother");
    await user.type(within(form).getByLabelText("Phone number"), "+919876543210");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(within(form).getByText(/already saved as “Mom”/)).toBeInTheDocument();
  });

  it("removes a contact with undo", async () => {
    window.localStorage.setItem(
      CONTACTS_STORAGE_KEY,
      JSON.stringify([
        { name: "Mom", phone: "+919876543210", custom: true },
        { name: "Dad", phone: "+14155552671", custom: true },
      ]),
    );
    const user = userEvent.setup();
    render(<ContactsView />);

    await user.click(await screen.findByRole("button", { name: "Remove Mom" }));
    expect(stored().map((c) => c.name)).toEqual(["Dad"]);
    expect(screen.getByText(/removed/i)).toHaveTextContent("Removed Mom.");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(stored().map((c) => c.name)).toEqual(["Mom", "Dad"]);
    expect(screen.getByRole("link", { name: "Text Mom" })).toHaveAttribute("href", "sms:+919876543210");
  });

  it("copies the status message with the current location and confirms inline", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<ContactsView />);

    await user.click(screen.getByRole("button", { name: "Copy “I'm safe” message" }));
    expect(writeText).toHaveBeenCalledWith(buildStatusMessage("safe", { lat: 28.6139, lon: 77.209 }));
    expect(await screen.findByText(/message copied/i)).toBeInTheDocument();
    expect(screen.getByText("Your current location is included.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Send “I need help” on WhatsApp" }).getAttribute("href")).toContain(
      encodeURIComponent("EMERGENCY: I need help immediately!"),
    );
  });
});
