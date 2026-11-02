/**
 * Same-origin proxy: `/api/backend/<path>?<query>` -> `${BACKEND_URL}/api/<path>?<query>`.
 *
 * Why a proxy?
 * - The backend URL is resolved at RUNTIME (works unchanged in Docker / any environment).
 * - The browser never sees backend credentials: when a NextAuth session exists we mint a
 *   5-minute HS256 JWT server-side and send it as `Authorization: Bearer <jwt>`.
 * - The browser's cookies and any client-supplied `Authorization` header are NOT forwarded.
 * - The browser's `X-Forwarded-For` chain is NOT forwarded either: only the client address
 *   resolved by `lib/client-ip.ts` (trusted proxy hops), as `X-ResQ-Client-IP` with the
 *   internal key so the backend can trust it.
 *
 * Guard rails:
 * - Internal endpoints (`users`) are never reachable from the browser (404 envelope).
 * - Path traversal (`..`, `.`, empty or slash-containing segments) is rejected (404).
 * - Bodies must be JSON (415) and at most 1 MB (413).
 * - Upstream requests time out after 20 s (504); connection failures return 502
 *   `backend_unreachable`.
 */

import { getServerSession } from "next-auth";
import type { NextRequest } from "next/server";

import {
  PayloadTooLargeError,
  errorResponse,
  isJsonContentType,
  logEvent,
  readBodyWithLimit,
  resolveRequestId,
} from "@/app/api/_lib/http";
import {
  MAX_BODY_BYTES,
  PASSTHROUGH_REQUEST_HEADERS,
  PASSTHROUGH_RESPONSE_HEADERS,
  UPSTREAM_TIMEOUT_MS,
  buildBackendPath,
} from "@/app/api/_lib/proxy";
import { authOptions } from "@/lib/auth";
import {
  BackendTokenConfigError,
  getBackendUrl,
  getInternalApiKey,
  mintBackendToken,
} from "@/lib/backend-token";
import { clientIpHeaders, resolveClientIp } from "@/lib/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path?: string[] }> };

let warnedMissingSecret = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns `Bearer <jwt>` for a signed-in user, or `null` to forward anonymously. */
async function resolveAuthorization(requestId: string): Promise<string | null> {
  let session;
  try {
    session = await getServerSession(authOptions);
  } catch (error) {
    // A broken/expired session cookie must not break public endpoints: continue anonymously.
    logEvent("warn", "proxy.session_error", { requestId, error: errorMessage(error) });
    return null;
  }
  const user = session?.user;
  if (!user?.id) return null;

  try {
    const token = await mintBackendToken({ id: user.id, email: user.email, name: user.name });
    return `Bearer ${token}`;
  } catch (error) {
    if (error instanceof BackendTokenConfigError) {
      if (!warnedMissingSecret) {
        warnedMissingSecret = true;
        logEvent("warn", "proxy.jwt_secret_missing", {
          message: "BACKEND_JWT_SECRET is not set; forwarding requests without Authorization",
        });
      }
      return null;
    }
    logEvent("error", "proxy.token_mint_failed", { requestId, error: errorMessage(error) });
    return null;
  }
}

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const startedAt = Date.now();
  const requestId = resolveRequestId(request.headers);
  const method = request.method.toUpperCase();

  const { path } = await context.params;
  const backendPath = buildBackendPath(path);
  if (!backendPath) {
    return errorResponse(404, "not_found", "Not found", requestId);
  }

  // ---- Body (JSON only, size-capped) ----
  let body: string | undefined;
  if (method !== "GET") {
    try {
      body = await readBodyWithLimit(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return errorResponse(
          413,
          "payload_too_large",
          "Request body is too large (max 1 MB)",
          requestId,
        );
      }
      return errorResponse(400, "bad_request", "Could not read the request body", requestId);
    }
    if (body.length === 0) {
      body = undefined;
    } else if (!isJsonContentType(request.headers.get("content-type"))) {
      return errorResponse(
        415,
        "unsupported_media_type",
        "Request body must be JSON (Content-Type: application/json)",
        requestId,
      );
    }
  }

  // ---- Upstream headers (allow-list; cookies/authorization from the browser are dropped) ----
  const headers = new Headers({ Accept: "application/json", "X-Request-ID": requestId });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  for (const name of PASSTHROUGH_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value.slice(0, 256));
  }
  // The end client's address for the backend's per-client limits: resolved from the hops our
  // own reverse proxies added (TRUSTED_PROXY_HOPS), never the browser's raw X-Forwarded-For
  // chain, and authenticated with the internal key (see lib/client-ip.ts).
  clientIpHeaders(resolveClientIp(request.headers), getInternalApiKey()).forEach((value, name) =>
    headers.set(name, value),
  );

  const authorization = await resolveAuthorization(requestId);
  if (authorization) headers.set("Authorization", authorization);

  const target = `${getBackendUrl()}/api/${backendPath}${request.nextUrl.search}`;

  // ---- Call the backend ----
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = AbortSignal.any([timeoutSignal, request.signal]);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      signal,
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (timeoutSignal.aborted) {
      logEvent("warn", "proxy.upstream_timeout", {
        requestId,
        method,
        path: backendPath,
        durationMs,
      });
      return errorResponse(
        504,
        "backend_timeout",
        "The ResQ AI service took too long to respond. Please try again.",
        requestId,
      );
    }
    if (request.signal.aborted) {
      // The browser went away; nobody will read this response.
      return errorResponse(499, "client_closed_request", "Client closed the request", requestId);
    }
    logEvent("error", "proxy.upstream_unreachable", {
      requestId,
      method,
      path: backendPath,
      durationMs,
      error: errorMessage(error),
    });
    return errorResponse(
      502,
      "backend_unreachable",
      "The ResQ AI service is unreachable. Please try again shortly.",
      requestId,
    );
  }

  // ---- Relay the response ----
  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has("x-request-id")) responseHeaders.set("X-Request-ID", requestId);

  logEvent(upstream.status >= 500 ? "warn" : "debug", "proxy.request", {
    requestId,
    method,
    path: backendPath,
    status: upstream.status,
    authenticated: Boolean(authorization),
    durationMs: Date.now() - startedAt,
  });

  const noBody = [204, 205, 304].includes(upstream.status);
  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
