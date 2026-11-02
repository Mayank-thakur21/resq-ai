/**
 * URL of the service worker script, versioned per build.
 *
 * `public/sw.js` is a static, hand-written file whose bytes do not change between deploys,
 * so browsers would never reinstall it (and never re-warm the offline pages). Registering it
 * as `/sw.js?v=<build id>` gives every deploy a new script URL: the browser installs the new
 * worker, which reads its version from `self.location` (cache names include it), precaches
 * and warms the offline-critical pages of *that* build and deletes the previous caches.
 *
 * The build id comes from `next.config.ts` (`NEXT_PUBLIC_RESQ_BUILD_ID`, inlined at build
 * time); development builds use "dev".
 */

/** Path of the service worker script (without the version query). */
export const SERVICE_WORKER_PATH = "/sw.js";

/** Build id embedded in the service worker URL (letters, digits, `.`, `_`, `-`). */
export function serviceWorkerVersion(): string {
  const raw = process.env.NEXT_PUBLIC_RESQ_BUILD_ID ?? "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : "dev";
}

/** `/sw.js?v=<build id>` — use for every `navigator.serviceWorker.register` call. */
export function serviceWorkerUrl(): string {
  return `${SERVICE_WORKER_PATH}?v=${encodeURIComponent(serviceWorkerVersion())}`;
}

/** True when `scriptURL` (absolute or relative) points at our service worker, any version. */
export function isResqServiceWorker(scriptURL: string | undefined | null): boolean {
  if (!scriptURL) return false;
  try {
    return new URL(scriptURL, "http://localhost").pathname === SERVICE_WORKER_PATH;
  } catch {
    return false;
  }
}
