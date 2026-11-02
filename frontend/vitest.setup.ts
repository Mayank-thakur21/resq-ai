/**
 * Global test setup (runs before every test file).
 *
 * Importing `@testing-library/jest-dom/vitest` registers the DOM matchers
 * (`toBeInTheDocument`, `toHaveAttribute`, ...) on Vitest's `expect` and augments its types,
 * so every test file gets them without extra imports.
 */
import "@testing-library/jest-dom/vitest";

import { afterEach } from "vitest";

// Testing Library only auto-cleans when Vitest globals are enabled; we keep globals off
// (explicit imports), so unmount rendered trees after each DOM test ourselves.
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
