/**
 * Shared helpers for the Next.js API route handlers (server only).
 *
 * The `_lib` folder is private (underscore prefix), so Next.js never routes to it.
 */

import type { ApiErrorBody } from "@/lib/types";

/** Request ids we accept from clients: short and log-safe. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Returns the caller's `X-Request-ID` when it is well-formed, else a fresh UUID. */
export function resolveRequestId(headers: Headers): string {
  const incoming = headers.get("x-request-id")?.trim();
  return incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

/**
 * Builds a JSON response using the backend's error envelope so the browser client can parse
 * proxy-generated and backend-generated errors identically.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId = "",
  extraHeaders?: HeadersInit,
): Response {
  const body: ApiErrorBody = { error: { code, message, request_id: requestId } };
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  if (requestId) headers.set("X-Request-ID", requestId);
  return new Response(JSON.stringify(body), { status, headers });
}

/** JSON success response with `Cache-Control: no-store`. */
export function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export class PayloadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Reads a request body as UTF-8 text, aborting as soon as it exceeds `limit` bytes (so a
 * huge upload is never buffered in memory).
 *
 * @throws {PayloadTooLargeError}
 */
export async function readBodyWithLimit(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError(limit);
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(limit);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** True for `application/json` and `application/*+json` content types. */
export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "application/json" || (mime.startsWith("application/") && mime.endsWith("+json"));
}

type LogLevel = "debug" | "info" | "warn" | "error";

/** Minimal structured logger for route handlers (one JSON line per event). */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  if (level === "debug" && process.env.NODE_ENV === "production") return;
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  const sink = level === "debug" ? console.debug : console[level];
  sink(line);
}
