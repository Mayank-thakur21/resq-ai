/**
 * SERVER-ONLY helpers for talking to the FastAPI backend from Next.js route handlers and
 * NextAuth callbacks. Never import this module from a client component: it reads secrets
 * (`BACKEND_JWT_SECRET`, `INTERNAL_API_KEY`) from the server environment.
 *
 * The backend trusts a short-lived HS256 JWT minted here from the NextAuth session:
 *   iss = "resq-frontend", aud = "resq-backend", sub = user id, optional email/name,
 *   iat/exp (5 minutes), jti (random).
 */

import { SignJWT } from "jose";

export const BACKEND_TOKEN_ISSUER = "resq-frontend";
export const BACKEND_TOKEN_AUDIENCE = "resq-backend";
/** Lifetime of a backend token in seconds. Tokens are minted per proxied request. */
export const BACKEND_TOKEN_TTL_SECONDS = 5 * 60;

const DEFAULT_BACKEND_URL = "http://localhost:8000";

/**
 * Base URL of the FastAPI backend, read at RUNTIME (so one Docker image works in any
 * environment). Trailing slashes are stripped.
 */
export function getBackendUrl(): string {
  const raw = process.env.BACKEND_URL?.trim() || DEFAULT_BACKEND_URL;
  return raw.replace(/\/+$/, "");
}

/** Shared secret for the backend's internal `/api/users/*` endpoints (`X-Internal-Key`). */
export function getInternalApiKey(): string | null {
  const key = process.env.INTERNAL_API_KEY?.trim();
  return key ? key : null;
}

/** Raised when the JWT cannot be minted because `BACKEND_JWT_SECRET` is not configured. */
export class BackendTokenConfigError extends Error {
  constructor(message = "BACKEND_JWT_SECRET is not configured") {
    super(message);
    this.name = "BackendTokenConfigError";
  }
}

export interface BackendTokenSubject {
  /** Stable user id (credentials users: backend UUID; OAuth: "github:<id>" / "google:<id>"). */
  id: string;
  email?: string | null;
  name?: string | null;
}

export interface MintBackendTokenOptions {
  /** Defaults to `process.env.BACKEND_JWT_SECRET`. */
  secret?: string;
  /** Defaults to {@link BACKEND_TOKEN_TTL_SECONDS}. */
  expiresInSeconds?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Mints the short-lived bearer token the proxy attaches to backend requests.
 *
 * @throws {BackendTokenConfigError} when no secret is configured.
 * @throws {Error} when the subject has no id.
 */
export async function mintBackendToken(
  subject: BackendTokenSubject,
  options: MintBackendTokenOptions = {},
): Promise<string> {
  const secret = options.secret ?? process.env.BACKEND_JWT_SECRET ?? "";
  if (!secret) throw new BackendTokenConfigError();
  if (!subject.id) throw new Error("Cannot mint a backend token without a user id");

  const ttl = options.expiresInSeconds ?? BACKEND_TOKEN_TTL_SECONDS;
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);

  // Only include optional claims that carry a value (the backend treats them as optional).
  const claims: Record<string, string> = {};
  if (subject.email) claims.email = subject.email;
  if (subject.name) claims.name = subject.name;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(subject.id)
    .setIssuer(BACKEND_TOKEN_ISSUER)
    .setAudience(BACKEND_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttl)
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(secret));
}
