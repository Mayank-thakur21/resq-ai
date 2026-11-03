import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PwaRegister, {
  isServiceWorkerEnabled,
  OFFLINE_BANNER_HEIGHT_VAR,
  OfflineBanner,
  SERVICE_WORKER_URL,
} from "@/components/PwaRegister";

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
    render(
      <>
        <OfflineBanner />
        <PwaRegister />
      </>,
    );
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
    render(<OfflineBanner />);
    expect(screen.getByText(/You're offline\./)).toBeInTheDocument();
  });

  it("keeps the offline banner in the page flow instead of over the page", () => {
    // Regression: a fixed overlay hid the first ~80 px of every page while offline (e.g. the
    // /offline page's icon).
    setOnline(false);
    const { container } = render(
      <>
        <OfflineBanner />
        <PwaRegister />
      </>,
    );
    const banner = container.querySelector('[data-slot="offline-banner"]');
    expect(banner?.className.split(/\s+/)).toEqual(expect.arrayContaining(["sticky", "top-14"]));
    expect(banner?.className.split(/\s+/)).not.toContain("fixed");
    // The fixed status area (update / back online toasts) has nothing to show.
    expect(container.querySelector('[data-slot="pwa-status"]')).toBeNull();
  });
});

describe("OfflineBanner — room for views sized to the viewport (review round 4)", () => {
  const root = () => document.documentElement.style;
  let bannerHeight = 0;
  let resize: (() => void) | undefined;

  beforeEach(() => {
    bannerHeight = 0;
    resize = undefined;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ height: bannerHeight }) as DOMRect,
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {
          resize = undefined;
        }
      },
    );
  });

  afterEach(() => {
    root().removeProperty(OFFLINE_BANNER_HEIGHT_VAR);
  });

  it("publishes the banner's height on <html> while offline and removes it when back online", () => {
    // Regression: /chat and /map size themselves to the viewport minus the navbar and tab
    // bar, so the in-flow banner pushed the chat composer and the map's attribution under
    // the mobile tab bar (input bottom 815 px vs tab bar top 779 px at 390x844).
    render(<OfflineBanner />);
    expect(root().getPropertyValue(OFFLINE_BANNER_HEIGHT_VAR)).toBe("");

    bannerHeight = 89.5;
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(root().getPropertyValue(OFFLINE_BANNER_HEIGHT_VAR)).toBe("90px");

    // The text wraps onto another line (narrower viewport, rotation).
    bannerHeight = 112;
    act(() => resize?.());
    expect(root().getPropertyValue(OFFLINE_BANNER_HEIGHT_VAR)).toBe("112px");

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(root().getPropertyValue(OFFLINE_BANNER_HEIGHT_VAR)).toBe("");
    expect(resize).toBeUndefined();
  });

  it("works without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    bannerHeight = 70;
    setOnline(false);
    const { unmount } = render(<OfflineBanner />);
    expect(root().getPropertyValue(OFFLINE_BANNER_HEIGHT_VAR)).toBe("70px");
    unmount();
    expect(root().getPropertyValue(OFFLINE_BANNER_HEIGHT_VAR)).toBe("");
  });

  // jsdom's import.meta.url is not a file: URL; vitest runs from the frontend root.
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
    });
  const appSources = () => [
    ...sources(path.join(process.cwd(), "app")),
    ...sources(path.join(process.cwd(), "components")),
  ];
  // Fixed heights (`h-[calc(100dvh…)]`, any breakpoint), not `min-h-…` (content can grow).
  const fixedHeight = /(?<![\w-])(?:\w+:)*h-\[calc\(100dvh[^\s"'`]*\]/g;

  it("is subtracted by every view sized to the viewport, and defaults to 0px", () => {
    const found: string[] = [];
    for (const file of appSources()) {
      for (const [match] of readFileSync(file, "utf8").matchAll(fixedHeight)) {
        found.push(`${path.relative(process.cwd(), file)}: ${match}`);
      }
    }
    // /chat and /map, each with its route skeleton, on mobile and on desktop.
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found.filter((entry) => !entry.includes(`var(${OFFLINE_BANNER_HEIGHT_VAR})`))).toEqual([]);

    const css = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");
    expect(css).toMatch(new RegExp(`:root \\{[^}]*${OFFLINE_BANNER_HEIGHT_VAR}: 0px;`));
  });

  it("is never outweighed by a minimum height on a view sized to the viewport", () => {
    // Regression: `/map` (and its skeleton) also had a 30rem minimum height. On a landscape
    // phone (e.g. 844x390) the space between the navbar and the tab bar is shorter, so the
    // minimum won and pushed the map and its attribution below the tab bar and the viewport.
    const classLists: string[] = [];
    for (const file of appSources()) {
      for (const [, classes] of readFileSync(file, "utf8").matchAll(/className="([^"]*)"/g)) {
        if (classes && classes.match(fixedHeight)) {
          classLists.push(`${path.relative(process.cwd(), file)}: ${classes}`);
        }
      }
    }
    expect(classLists.map((entry) => entry.split(":")[0]).sort()).toEqual(
      expect.arrayContaining([
        path.join("app", "chat", "ChatView.tsx"),
        path.join("app", "chat", "loading.tsx"),
        path.join("app", "map", "MapView.tsx"),
        path.join("app", "map", "loading.tsx"),
      ]),
    );
    expect(classLists.filter((entry) => /(?<![\w-])(?:\w+:)*min-h-/.test(entry))).toEqual([]);
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
