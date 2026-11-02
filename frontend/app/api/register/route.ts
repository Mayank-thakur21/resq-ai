/**
 * `POST /api/register` — creates an email + password account.
 *
 * Validates `{name, email, password}` with the shared zod schema, then calls the backend's
 * internal `POST /api/users/register` with `X-Internal-Key` (the browser can never reach that
 * endpoint directly). Responses use the standard error envelope:
 *   201 {id, email, name} | 400 bad_request | 409 conflict | 413 | 415 | 422 validation_error
 *   | 429 rate_limited | 502 backend_unreachable/upstream_error | 503 not_configured/service_busy | 504
 */

import type { NextRequest } from "next/server";

import {
  PayloadTooLargeError,
  errorResponse,
  isJsonContentType,
  jsonResponse,
  logEvent,
  readBodyWithLimit,
  resolveRequestId,
} from "@/app/api/_lib/http";
import { fieldErrors, registerSchema } from "@/app/register/schema";
import { getBackendUrl, getInternalApiKey } from "@/lib/backend-token";
import { clientIpHeaders, resolveClientIp } from "@/lib/client-ip";
import type { PublicUser } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 10 * 1024;
const BACKEND_TIMEOUT_MS = 10_000;

function isPublicUser(value: unknown): value is PublicUser {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.email === "string" && typeof v.name === "string";
}

/** The backend envelope's `error.code`, or `null` (reads the body). */
async function backendCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body?.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

async function backendMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown }; detail?: unknown };
    if (typeof body?.error?.message === "string") return body.error.message;
    if (typeof body?.detail === "string") return body.detail;
  } catch {
    // Non-JSON error body.
  }
  return null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = resolveRequestId(request.headers);

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(415, "unsupported_media_type", "Request body must be JSON", requestId);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readBodyWithLimit(request, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return errorResponse(413, "payload_too_large", "Request body is too large", requestId);
    }
    return errorResponse(400, "bad_request", "Request body must be valid JSON", requestId);
  }

  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    const message =
      Object.entries(errors)
        .map(([field, msg]) => `${field}: ${msg}`)
        .join("; ") || "Invalid registration details";
    return errorResponse(422, "validation_error", message, requestId);
  }

  const internalKey = getInternalApiKey();
  if (!internalKey) {
    logEvent("error", "register.not_configured", { requestId, reason: "INTERNAL_API_KEY unset" });
    return errorResponse(
      503,
      "not_configured",
      "Registration is not available right now. Please try again later.",
      requestId,
    );
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Internal-Key": internalKey,
    "X-Request-ID": requestId,
  });
  // Lets the backend limit registrations per end client (bcrypt is expensive).
  clientIpHeaders(resolveClientIp(request.headers), internalKey).forEach((value, name) =>
    headers.set(name, value),
  );

  let upstream: Response;
  try {
    upstream = await fetch(`${getBackendUrl()}/api/users/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    logEvent("error", "register.backend_error", {
      requestId,
      timedOut,
      error: error instanceof Error ? error.message : String(error),
    });
    return timedOut
      ? errorResponse(504, "backend_timeout", "The ResQ AI service took too long to respond", requestId)
      : errorResponse(
          502,
          "backend_unreachable",
          "The ResQ AI service is unreachable. Please try again shortly.",
          requestId,
        );
  }

  switch (upstream.status) {
    case 200:
    case 201: {
      let user: unknown;
      try {
        user = await upstream.json();
      } catch {
        user = null;
      }
      if (!isPublicUser(user)) {
        logEvent("error", "register.invalid_backend_body", { requestId });
        return errorResponse(502, "upstream_error", "Unexpected response from the server", requestId);
      }
      logEvent("info", "register.created", { requestId, userId: user.id });
      return jsonResponse({ id: user.id, email: user.email, name: user.name }, 201);
    }
    case 409:
      return errorResponse(
        409,
        "conflict",
        "An account with this email already exists. Try signing in instead.",
        requestId,
      );
    case 422:
      return errorResponse(
        422,
        "validation_error",
        (await backendMessage(upstream)) ?? "Invalid registration details",
        requestId,
      );
    case 429: {
      const retryAfter = upstream.headers.get("retry-after");
      return errorResponse(
        429,
        "rate_limited",
        "Too many attempts. Please wait a moment and try again.",
        requestId,
        retryAfter ? { "Retry-After": retryAfter } : undefined,
      );
    }
    case 503: {
      const retryAfter = upstream.headers.get("retry-after");
      if ((await backendCode(upstream)) === "service_busy") {
        // Temporary overload (bounded bcrypt queue / database pool), not a configuration issue.
        logEvent("warn", "register.backend_busy", { requestId });
        return errorResponse(
          503,
          "service_busy",
          "The server is busy right now. Please try again in a few seconds.",
          requestId,
          retryAfter ? { "Retry-After": retryAfter } : undefined,
        );
      }
      logEvent("error", "register.backend_not_configured", { requestId });
      return errorResponse(
        503,
        "not_configured",
        "Registration is not available right now. Please try again later.",
        requestId,
      );
    }
    default:
      logEvent("error", "register.unexpected_status", { requestId, status: upstream.status });
      return errorResponse(502, "upstream_error", "Registration failed. Please try again.", requestId);
  }
}
