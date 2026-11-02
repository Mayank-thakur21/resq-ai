import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

const platform = vi.hoisted(() => ({ ios: false, standalone: false }));
vi.mock("@/lib/push", () => ({
  isIOS: () => platform.ios,
  isStandalone: () => platform.standalone,
}));

import InstallPrompt, { INSTALL_DISMISSED_STORAGE_KEY, wasRecentlyDismissed } from "@/components/InstallPrompt";

function fireInstallEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string; platform: string }>;
    platforms: string[];
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome, platform: "web" });
  event.platforms = ["web"];
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  navigation.pathname = "/";
  platform.ios = false;
  platform.standalone = false;
  window.localStorage.clear();
});

describe("InstallPrompt", () => {
  it("stays hidden until the browser offers installation", () => {
    const { container } = render(<InstallPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("captures beforeinstallprompt and opens the native dialog on Install", async () => {
    render(<InstallPrompt />);
    const event = fireInstallEvent("accepted");
    expect(event.defaultPrevented).toBe(true);

    expect(screen.getByRole("dialog", { name: "Install ResQ AI" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(INSTALL_DISMISSED_STORAGE_KEY)).toBeNull();
  });

  it("remembers a dismissal for 30 days", () => {
    render(<InstallPrompt />);
    fireInstallEvent();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(wasRecentlyDismissed()).toBe(true);
    expect(wasRecentlyDismissed(Date.now() + 31 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("does not listen at all after a recent dismissal or when already installed", () => {
    window.localStorage.setItem(INSTALL_DISMISSED_STORAGE_KEY, String(Date.now()));
    const first = render(<InstallPrompt />);
    const event = fireInstallEvent();
    expect(event.defaultPrevented).toBe(false);
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    window.localStorage.clear();
    platform.standalone = true;
    const second = render(<InstallPrompt />);
    fireInstallEvent();
    expect(second.container).toBeEmptyDOMElement();
  });

  it("shows the Add to Home Screen hint on iOS after a delay", () => {
    vi.useFakeTimers();
    try {
      platform.ios = true;
      render(<InstallPrompt />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(screen.getByRole("dialog", { name: "Install ResQ AI" })).toHaveTextContent("Add to Home Screen");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is never shown on the SOS page", () => {
    navigation.pathname = "/sos";
    const { container } = render(<InstallPrompt />);
    fireInstallEvent();
    expect(container).toBeEmptyDOMElement();
  });
});
