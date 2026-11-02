/**
 * Test-only helpers for the map / incident tests (imported by `*.test.tsx` files only).
 *
 * - `makeIncident` / `makePlace` / `makeDisaster`: realistic API objects.
 * - `SWRTestProvider`: isolated SWR cache per test, no dedupe, no retries.
 * - `mockFetch`: routes `fetch` calls by backend path (as seen through the proxy) to
 *   handlers, records calls, and fails loudly on unexpected requests.
 */

import * as React from "react";
import { SWRConfig } from "swr";
import { vi } from "vitest";

import { fetcher } from "@/lib/api";
import type { DisasterEvent, Incident, Place } from "@/lib/types";

export function makeIncident(overrides: Partial<Incident> = {}): Incident {
  const created = new Date(Date.now() - 5 * 60_000).toISOString();
  return {
    id: "inc-1",
    created_at: created,
    updated_at: created,
    lat: 28.6139,
    lon: 77.209,
    disaster_type: "flood",
    severity: "high",
    description: "Water is rising quickly near the market road.",
    image_url: null,
    status: "open",
    reporter: { id: "u-reporter", name: "Asha Rao" },
    upvotes: 2,
    verified: false,
    upvoted_by_me: false,
    distance_km: 1.2,
    ...overrides,
  };
}

export function makePlace(overrides: Partial<Place> = {}): Place {
  return {
    id: "node/1",
    name: "City Hospital",
    type: "hospital",
    lat: 28.62,
    lon: 77.21,
    distance_km: 0.8,
    address: "1 Main Road",
    phone: "+91 11 2345 6789",
    ...overrides,
  };
}

export function makeDisaster(overrides: Partial<DisasterEvent> = {}): DisasterEvent {
  return {
    id: "gdacs-EQ-1",
    source: "gdacs",
    event_type: "EQ",
    event_type_label: "Earthquake",
    title: "M 5.9 earthquake",
    description: "Moderate earthquake",
    alert_level: "orange",
    severity_text: "Magnitude 5.9M",
    country: "India",
    lat: 29.1,
    lon: 78.0,
    from_date: new Date(Date.now() - 3_600_000).toISOString(),
    to_date: null,
    is_current: true,
    url: "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1",
    distance_km: 90,
    ...overrides,
  };
}

/** Isolated SWR cache so tests never share data. */
export function SWRTestProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fetcher,
        dedupingInterval: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        keepPreviousData: true,
      }}
    >
      {children}
    </SWRConfig>
  );
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message, request_id: "req-test" } }, status);
}

export interface RecordedCall {
  method: string;
  /** Backend path without the proxy prefix, e.g. "incidents" or "incidents/abc/upvote". */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type RouteHandler = (call: RecordedCall) => Response | Promise<Response>;

/**
 * Installs a `fetch` mock that dispatches on `"METHOD path"` (e.g. `"GET incidents"`) or just
 * `"path"` (any method). Returns the recorded calls.
 */
export function mockFetch(routes: Record<string, RouteHandler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    const path = url.pathname.replace(/^\/api\/backend\//, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: RecordedCall = { method, path, query: url.searchParams, body };
    calls.push(call);
    const handler = routes[`${method} ${path}`] ?? routes[path];
    if (!handler) throw new Error(`Unexpected fetch: ${method} ${path}`);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

/** A promise you resolve later (for asserting optimistic UI before a response arrives). */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
