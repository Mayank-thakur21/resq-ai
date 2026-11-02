import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { retryTarget } from "@/app/offline/_components/RetryConnectionButton";
import OfflinePage from "@/app/offline/page";
import { CONTACTS_STORAGE_KEY, resetContactsMemoryForTests } from "@/lib/contacts";

beforeEach(() => {
  window.localStorage.clear();
  resetContactsMemoryForTests();
});

describe("/offline", () => {
  it("lists emergency numbers as tel: links and offline tips", () => {
    render(<OfflinePage />);
    expect(screen.getByRole("heading", { name: "You're offline" })).toBeInTheDocument();
    const numbers = screen.getByRole("heading", { name: "Emergency numbers" }).parentElement as HTMLElement;
    for (const number of ["112", "108", "100", "101", "911", "999"]) {
      expect(within(numbers).getByRole("link", { name: new RegExp(`^Call ${number},`) })).toHaveAttribute(
        "href",
        `tel:${number}`,
      );
    }
    expect(screen.getByText("Text when calls fail")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Saved contacts" })).toHaveAttribute("href", "/contacts");
  });

  it("shows the contacts saved on this device without any network request", () => {
    window.localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify([{ name: "Mom", phone: "+919876543210" }]));
    render(<OfflinePage />);
    expect(screen.getByRole("link", { name: "Call Mom" })).toHaveAttribute("href", "tel:+919876543210");
    expect(screen.getByRole("link", { name: "Text Mom" })).toHaveAttribute("href", "sms:+919876543210");
  });

  it("suggests adding contacts when none are saved, and highlights reconnection", () => {
    render(<OfflinePage />);
    expect(screen.getByText("No contacts saved on this device")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByRole("button", { name: "Back online — reload" })).toBeInTheDocument();
  });

  it("returns to the page the user wanted, but only same-origin paths", () => {
    expect(retryTarget("?from=%2Falerts%3Ftab%3Dnews")).toBe("/alerts?tab=news");
    expect(retryTarget("")).toBe("/");
    expect(retryTarget("?from=https%3A%2F%2Fevil.example")).toBe("/");
    expect(retryTarget("?from=%2F%2Fevil.example")).toBe("/");
    expect(retryTarget("?from=%2F%5Cevil.example")).toBe("/");
    expect(retryTarget("?from=%2Foffline")).toBe("/");
    expect(retryTarget("?from=%2Foffline%3Ffrom%3D%252Fmap")).toBe("/");
  });

  it("rejects control characters the URL parser would strip (open redirect)", () => {
    const origin = "https://resq.example";
    // TAB / LF / CR between the slashes: the URL parser drops them -> //evil.example/phish
    for (const encoded of ["%09", "%0A", "%0D"]) {
      expect(retryTarget(`?from=%2F${encoded}%2Fevil.example%2Fphish`, origin)).toBe("/");
      expect(retryTarget(`?from=%2F%2F${encoded}evil.example`, origin)).toBe("/");
    }
    expect(retryTarget("?from=%2F%00%2Fevil.example", origin)).toBe("/");
    expect(retryTarget("?from=%2F%7F%2Fevil.example", origin)).toBe("/");
    expect(retryTarget("?from=%2F%5C%2Fevil.example", origin)).toBe("/");
    // Legit same-origin paths keep their query and hash.
    expect(retryTarget("?from=%2Fmap%3Flayer%3Dhospitals%23x", origin)).toBe("/map?layer=hospitals#x");
    expect(retryTarget("?from=%2Fincidents%2Fabc", origin)).toBe("/incidents/abc");
  });
});
