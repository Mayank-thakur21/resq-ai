import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Unit-test configuration.
 *
 * - Default environment is jsdom (components, hooks, browser helpers). Server-side tests
 *   (route handlers, JWT minting) opt into Node with a `// @vitest-environment node` docblock,
 *   because jsdom replaces `AbortSignal`/`TextEncoder` with implementations that Node's fetch
 *   and `jose` reject.
 * - `@/` mirrors the `paths` alias from tsconfig.json.
 * - Tests never touch the network: `fetch` is mocked per test.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "out/**", "e2e/**"],
    css: false,
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
