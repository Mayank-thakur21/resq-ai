/**
 * SERVER-ONLY NextAuth (v4) configuration.
 *
 * - Sessions are stateless JWTs (no database adapter).
 * - Email + password users live in the backend: `authorize` calls the internal
 *   `POST /api/users/verify` endpoint with `X-Internal-Key`.
 * - GitHub / Google are added only when their env vars are set (see `lib/auth-providers.ts`).
 * - The stable user id is stored as `token.uid` and exposed as `session.user.id`. OAuth ids are
 *   namespaced (`github:<id>`, `google:<id>`) so they can never collide with backend UUIDs.
 *
 * `authorize` error contract (surfaced as `signIn(...).error` on the login page):
 *   - returns `null`           -> "CredentialsSignin" (wrong email or password)
 *   - throws AUTH_ERROR_CODES.* -> that code (backend down / auth not configured / too many
 *     failed attempts: the backend counts failures per client address and account)
 *
 * The browser's address (resolved with `lib/client-ip.ts`) is sent as `X-ResQ-Client-IP`, so
 * the backend can throttle failed sign-ins per client instead of putting every login of the
 * deployment into one bucket keyed on this server's IP.
 */

import type { NextAuthOptions, User } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { z } from "zod";

import { isGitHubEnabled, isGoogleEnabled } from "@/lib/auth-providers";
import { getBackendUrl, getInternalApiKey } from "@/lib/backend-token";
import { CLIENT_IP_HEADER, resolveClientIp } from "@/lib/client-ip";
import type { PublicUser } from "@/lib/types";

/** Error codes thrown from `authorize`; the login page maps them to friendly messages. */
export const AUTH_ERROR_CODES = {
  /** Backend unreachable, timed out or returned 5xx. */
  unavailable: "AuthUnavailable",
  /** INTERNAL_API_KEY missing on the frontend or user auth disabled on the backend. */
  notConfigured: "AuthNotConfigured",
  /** Backend 429 `rate_limited`: too many failed sign-in attempts (per client / account). */
  rateLimited: "AuthRateLimited",
} as const;

const VERIFY_TIMEOUT_MS = 10_000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(128),
});

function log(level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  console[level](`[auth] ${message}`, extra ?? "");
}

/** `error.code` of a backend error envelope, or `null` (consumes the body). */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } } | null;
    return typeof body?.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function isPublicUser(value: unknown): value is PublicUser {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.email === "string" && typeof v.name === "string";
}

/**
 * Verifies email + password against the backend. Exported for unit tests.
 * @returns the user, or `null` for invalid credentials.
 * @throws Error(AUTH_ERROR_CODES.*) when verification is impossible right now.
 */
export async function verifyCredentials(
  rawCredentials: unknown,
  clientIp: string | null = null,
): Promise<User | null> {
  const parsed = credentialsSchema.safeParse(rawCredentials);
  if (!parsed.success) return null;

  const internalKey = getInternalApiKey();
  if (!internalKey) {
    log("error", "INTERNAL_API_KEY is not set; credentials sign-in is disabled");
    throw new Error(AUTH_ERROR_CODES.notConfigured);
  }

  let response: Response;
  try {
    response = await fetch(`${getBackendUrl()}/api/users/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Internal-Key": internalKey,
        ...(clientIp ? { [CLIENT_IP_HEADER]: clientIp } : {}),
      },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    log("error", "backend unreachable during credentials verification", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(AUTH_ERROR_CODES.unavailable);
  }

  if (response.status === 401 || response.status === 404 || response.status === 422) {
    return null;
  }
  if (response.status === 429) {
    // Failed-attempt limiter on the backend (per client address and account). Not logged
    // with the email address.
    log("warn", "too many sign-in attempts (429 from /api/users/verify)", {
      retryAfter: response.headers.get("retry-after"),
    });
    throw new Error(AUTH_ERROR_CODES.rateLimited);
  }
  if (response.status === 503) {
    if ((await errorCode(response)) === "service_busy") {
      // Temporary overload (bounded bcrypt queue / database pool): "try again in a moment".
      log("warn", "backend busy (503 service_busy from /api/users/verify)", {
        retryAfter: response.headers.get("retry-after"),
      });
      throw new Error(AUTH_ERROR_CODES.unavailable);
    }
    log("error", "backend reports user auth is not configured (503)");
    throw new Error(AUTH_ERROR_CODES.notConfigured);
  }
  if (!response.ok) {
    log("error", "unexpected status from /api/users/verify", { status: response.status });
    throw new Error(AUTH_ERROR_CODES.unavailable);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    log("error", "invalid JSON from /api/users/verify");
    throw new Error(AUTH_ERROR_CODES.unavailable);
  }
  if (!isPublicUser(body)) {
    log("error", "unexpected body shape from /api/users/verify");
    throw new Error(AUTH_ERROR_CODES.unavailable);
  }
  return { id: body.id, email: body.email, name: body.name };
}

function buildProviders(): NextAuthOptions["providers"] {
  const providers: NextAuthOptions["providers"] = [
    CredentialsProvider({
      id: "credentials",
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      // NextAuth passes the incoming request's headers as a plain object.
      authorize: (credentials, req) =>
        verifyCredentials(credentials, resolveClientIp(req?.headers)),
    }),
  ];

  if (isGitHubEnabled()) {
    providers.push(
      GitHubProvider({
        clientId: process.env.GITHUB_ID as string,
        clientSecret: process.env.GITHUB_SECRET as string,
      }),
    );
  }
  if (isGoogleEnabled()) {
    providers.push(
      GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID as string,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      }),
    );
  }
  return providers;
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  providers: buildProviders(),
  callbacks: {
    async jwt({ token, user, account }) {
      // `user`/`account` are only present on the sign-in request.
      if (user) {
        token.uid =
          account && account.type === "oauth"
            ? `${account.provider}:${account.providerAccountId}`
            : user.id;
        if (user.name) token.name = user.name;
        if (user.email) token.email = user.email;
      }
      return token;
    },
    async session({ session, token }) {
      const id = token.uid ?? token.sub;
      if (session.user && id) {
        session.user.id = id;
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      // Only ever redirect within this origin (prevents open redirects via callbackUrl).
      if (url.startsWith("/") && !url.startsWith("//")) return `${baseUrl}${url}`;
      try {
        if (new URL(url).origin === baseUrl) return url;
      } catch {
        // fall through
      }
      return baseUrl;
    },
  },
  logger: {
    error(code, metadata) {
      log("error", code, { metadata: metadata instanceof Error ? metadata.message : metadata });
    },
    warn(code) {
      log("warn", code);
    },
    debug() {
      // NextAuth debug output is too verbose (and may include tokens); keep it off.
    },
  },
};
