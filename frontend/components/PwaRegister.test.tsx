import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PwaRegister, { isServiceWorkerEnabled, SERVICE_WORKER_URL } from "@/components/PwaRegister";

class FakeWorker extends EventTarget {
  state = "installed";
  // A worker installed by an earlier build (versioned URL).
  scriptURL = "http://localhost:3000/sw.js?v=previous-build";
  postMessage = vi.fn();
}

interface FakeContainer extends EventTarget {
  controller: unknown;
  register: ReturnType<typeof vi.fn>;
  getRegistrations: ReturnType<typeof vi.fn>;
}

function installServiceWorkerApi(registration: object, controller: unknown = {}): FakeContainer {
  const container = Object.assign(new EventTarget(), {
    controller,
    register: vi.fn().mockResolvedValue(registration),
    getRegistrations: vi.fn().mockResolvedValue([registration]),
  });
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: container });
  return container;
}

function makeRegistration(extra: Record<string, unknown> = {}) {
  return Object.assign(new EventTarget(), {
    active: new FakeWorker(),
    waiting: null as FakeWorker | null,
    installing: null as FakeWorker | null,
    update: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(true),
    ...extra,
  });
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

beforeEach(() => {
  setOnline(true);
});

afterEach(() => {
  Reflect.deleteProperty(window.navigator, "serviceWorker");
  Reflect.deleteProperty(window.navigator, "onLine");
});

describe("PwaRegister — connectivity", () => {
  it("renders nothing while online", () => {
    const { container } = render(<PwaRegister />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an offline banner and a short 'back online' note", async () => {
    render(<PwaRegister />);
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(/You're offline\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Offline help" })).toHaveAttribute("href", "/offline");

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(/You're offline\./)).not.toBeInTheDocument();
    expect(screen.getByText("Back online")).toBeInTheDocument();
  });

  it("starts in the offline state when the browser already is offline", () => {
    setOnline(false);
    render(<PwaRegister />);
    expect(screen.getByText(/You're offline\./)).toBeInTheDocument();
  });
});

describe("PwaRegister — service worker", () => {
  it("is enabled in production or with the dev opt-in", () => {
    expect(isServiceWorkerEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SW_IN_DEV", "true");
    expect(isServiceWorkerEnabled()).toBe(true);
  });

  it("unregisters a stale ResQ worker in development without the opt-in", async () => {
    const registration = makeRegistration();
    const container = installServiceWorkerApi(registration);
    render(<PwaRegister />);
    await waitFor(() => expect(registration.unregister).toHaveBeenCalled());
    expect(container.register).not.toHaveBeenCalled();
  });

  it("registers the build-versioned script URL", () => {
    expect(SERVICE_WORKER_URL).toMatch(/^\/sw\.js\?v=[A-Za-z0-9._-]+$/);
  });

  it("registers /sw.js and offers a waiting update, activating it on Reload", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SW_IN_DEV", "true");
    const waiting = new FakeWorker();
    const registration = makeRegistration({ waiting });
    const container = installServiceWorkerApi(registration, { active: true });

    render(<PwaRegister />);
    await waitFor(() =>
      expect(container.register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: "/", updateViaCache: "none" }),
    );
    expect(await screen.findByText(/Update available\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(screen.getByRole("button", { name: "Reloading…" })).toBeDisabled();
  });

  it("does not prompt on the very first install (no controller yet)", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SW_IN_DEV", "true");
    const registration = makeRegistration({ waiting: new FakeWorker() });
    const container = installServiceWorkerApi(registration, null);
    render(<PwaRegister />);
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    expect(screen.queryByText(/Update available\./)).not.toBeInTheDocument();
  });

  it("can dismiss the update notice", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SW_IN_DEV", "true");
    installServiceWorkerApi(makeRegistration({ waiting: new FakeWorker() }), {});
    render(<PwaRegister />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByText(/Update available\./)).not.toBeInTheDocument();
  });
});
