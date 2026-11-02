/**
 * SERVER-ONLY: the end client's IP address, as far as this Next.js server can trust it.
 *
 * Why this matters: the backend's per-client limits (SOS 5/minute, chat, registration, the
 * per-client sign-in throttle) key anonymous callers on this address. A client must not be
 * able to choose it, or every request gets a fresh rate-limit bucket.
 *
 * How it works:
 * - Next.js fills `X-Forwarded-For` with the TCP peer address **only when the header is
 *   absent** (`req.headers['x-forwarded-for'] ??= socket.remoteAddress` in Next's
 *   base-server). A header sent by the client is kept as-is.
 * - Every reverse proxy in front of us records the address it received the request from,
 *   either by appending to the header or (better) by overwriting it.
 * - With `TRUSTED_PROXY_HOPS = N` trusted proxies, the client is therefore the entry `N`
 *   positions from the right; everything left of it was written by the client and is ignored.
 * - `TRUSTED_PROXY_HOPS = 0` (Next.js reached directly, e.g. `npm run dev`) uses the
 *   right-most entry, which is the socket address for honest clients but can be forged by a
 *   client that sends its own header. Never expose Next.js publicly with 0: docker-compose.yml
 *   puts an nginx proxy that overwrites the header in front (and sets 1).
 *
 * The result is sent to the backend as `X-ResQ-Client-IP` together with `X-Internal-Key`; the
 * backend ignores that header without a valid key, so browsers cannot set it themselves.
 */

import { isIP } from "node:net";

/** Header the backend accepts (only with a valid `X-Internal-Key`) as the client address. */
export const CLIENT_IP_HEADER = "X-ResQ-Client-IP";

/** Upper bound for `TRUSTED_PROXY_HOPS`. */
export const MAX_TRUSTED_PROXY_HOPS = 10;

/** `X-Forwarded-For` entries considered at most (longer chains are truncated on the left). */
const MAX_FORWARDED_HOPS = 20;

type HeaderSource = Headers | Record<string, string | string[] | undefined> | null | undefined;

let warnedUntrusted = false;

/** `TRUSTED_PROXY_HOPS` as an integer in `[0, MAX_TRUSTED_PROXY_HOPS]` (default 0). */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_TRUSTED_PROXY_HOPS);
}

/**
 * Canonical IPv4/IPv6 text, or `null` when `value` is not an IP address. Accepts the forms
 * proxies produce: `[2001:db8::1]`, `[2001:db8::1]:443`, `203.0.113.7:51234`, and reduces
 * IPv4-mapped IPv6 (`::ffff:203.0.113.7`) to IPv4.
 */
export function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim().slice(0, 64);
  if (candidate.startsWith("[")) {
    candidate = candidate.slice(1).split("]", 1)[0] ?? "";
  } else if ((candidate.match(/:/g) ?? []).length === 1) {
    candidate = candidate.split(":", 1)[0] ?? ""; // IPv4 with a port
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate);
  if (mapped?.[1]) candidate = mapped[1];
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version === 6) return candidate.toLowerCase();
  return null;
}

function readHeader(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : null;
}

/**
 * The client address to report to the backend, or `null` when none can be determined.
 *
 * @param headers incoming request headers (`Headers` or a plain object as NextAuth passes).
 * @param hops number of trusted reverse proxies (defaults to `TRUSTED_PROXY_HOPS`).
 */
export function resolveClientIp(headers: HeaderSource, hops = trustedProxyHops()): string | null {
  const raw = readHeader(headers, "x-forwarded-for");
  if (!raw) return null;
  const chain = raw
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean)
    .slice(-MAX_FORWARDED_HOPS);
  if (chain.length === 0) return null;

  if (hops === 0 && !warnedUntrusted && process.env.NODE_ENV === "production") {
    warnedUntrusted = true;
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "client_ip.untrusted",
        time: new Date().toISOString(),
        message:
          "TRUSTED_PROXY_HOPS=0: clients can forge X-Forwarded-For. Put a reverse proxy that " +
          "overwrites X-Forwarded-For in front of Next.js and set TRUSTED_PROXY_HOPS=1.",
      }),
    );
  }

  // Entry recorded by the outermost trusted proxy (or by Next.js itself when hops = 0).
  const index = Math.max(0, chain.length - Math.max(hops, 1));
  return normaliseIp(chain[index]);
}

/**
 * Headers that tell the backend who the end client is: `X-Forwarded-For` (single resolved
 * value, for deployments that run the backend behind its own trusted proxy) and, when the
 * internal key is configured, the authenticated `X-ResQ-Client-IP` + `X-Internal-Key` pair.
 */
export function clientIpHeaders(clientIp: string | null, internalKey: string | null): Headers {
  const headers = new Headers();
  if (!clientIp) return headers;
  headers.set("X-Forwarded-For", clientIp);
  if (internalKey) {
    headers.set(CLIENT_IP_HEADER, clientIp);
    headers.set("X-Internal-Key", internalKey);
  }
  return headers;
}

/** Test helper: forget that the "untrusted" warning was logged. */
export function resetClientIpWarningForTests(): void {
  warnedUntrusted = false;
}
