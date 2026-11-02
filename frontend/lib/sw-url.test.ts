import { afterEach, describe, expect, it, vi } from "vitest";

import { isResqServiceWorker, serviceWorkerUrl, serviceWorkerVersion } from "@/lib/sw-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("service worker URL", () => {
  it("carries the build id so every deploy installs (and re-warms) a new worker", () => {
    vi.stubEnv("NEXT_PUBLIC_RESQ_BUILD_ID", "abc123");
    expect(serviceWorkerVersion()).toBe("abc123");
    expect(serviceWorkerUrl()).toBe("/sw.js?v=abc123");
  });

  it("falls back to 'dev' for a missing or unsafe build id", () => {
    vi.stubEnv("NEXT_PUBLIC_RESQ_BUILD_ID", "");
    expect(serviceWorkerUrl()).toBe("/sw.js?v=dev");
    vi.stubEnv("NEXT_PUBLIC_RESQ_BUILD_ID", "../evil?x=1");
    expect(serviceWorkerVersion()).toBe("dev");
  });

  it("recognises our worker whatever its version", () => {
    expect(isResqServiceWorker("https://resq.test/sw.js?v=old")).toBe(true);
    expect(isResqServiceWorker("/sw.js")).toBe(true);
    expect(isResqServiceWorker("https://resq.test/other-sw.js")).toBe(false);
    expect(isResqServiceWorker("")).toBe(false);
  });
});
