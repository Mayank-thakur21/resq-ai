/**
 * Pure helpers and constants of the backend proxy (`app/api/backend/[...path]/route.ts`).
 * Kept outside the route module because Next.js only allows HTTP-method and segment-config
 * exports from `route.ts` files.
 */

/** Maximum accepted request body size (1 MB). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Upstream (FastAPI) timeout in milliseconds. */
export const UPSTREAM_TIMEOUT_MS = 20_000;

/** Backend routers the browser must never reach through the proxy (internal-only). */
export const BLOCKED_SEGMENTS: ReadonlySet<string> = new Set(["users"]);

/** Response headers copied from the backend to the browser. */
export const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-type",
  "retry-after",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

/** Request headers copied from the browser to the backend (besides the ones we set). */
export const PASSTHROUGH_REQUEST_HEADERS = ["accept-language"] as const;

/**
 * Validates the catch-all route segments and returns the URL-encoded backend path
 * (without the `/api/` prefix), or `null` when the request must be rejected:
 * - no segments, empty segments, `.` / `..`,
 * - segments containing `/`, `\` or NUL (e.g. from `%2F` / `%5C` encodings),
 * - any segment naming an internal router (`users`, case-insensitive).
 */
export function buildBackendPath(segments: readonly string[] | undefined): string | null {
  if (!segments || segments.length === 0) return null;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return null;
    if (/[/\\\0]/.test(segment)) return null;
    if (BLOCKED_SEGMENTS.has(segment.toLowerCase())) return null;
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}
