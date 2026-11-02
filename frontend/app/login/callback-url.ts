/**
 * Sanitises the `callbackUrl` query parameter used by the login/register pages so it can only
 * point inside this app (prevents open redirects such as `?callbackUrl=https://evil.example`
 * or `//evil.example`). Auth pages themselves are never valid targets (avoids loops).
 */
export function sanitizeCallbackUrl(
  value: string | string[] | null | undefined,
  fallback = "/",
): string {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return fallback;

  let path: string | null = null;
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) {
    path = raw;
  } else {
    // Absolute URLs are accepted only for our own origin (NEXTAUTH_URL on the server,
    // window.location on the client).
    const origin =
      typeof window !== "undefined" ? window.location.origin : safeOrigin(process.env.NEXTAUTH_URL);
    try {
      const url = new URL(raw);
      if (origin && url.origin === origin) path = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      path = null;
    }
  }

  if (!path || /[\u0000-\u001f]/.test(path)) return fallback;
  const pathname = path.split(/[?#]/)[0] ?? "";
  if (pathname === "/login" || pathname === "/register" || pathname.startsWith("/api/auth")) {
    return fallback;
  }
  return path;
}

function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Reads a single string value from Next.js `searchParams`. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
