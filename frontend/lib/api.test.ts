import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  apiFetch,
  apiUrl,
  buildQuery,
  compareApiData,
  createIncident,
  errorFromResponse,
  fetcher,
  getErrorMessage,
  getIncident,
  getResponseMeta,
  getWeather,
  isSavedCopy,
  roundCoord,
  sendSOS,
  SLOW_TIMEOUT_MS,
  swrKeys,
} from "@/lib/api";
import { UPSTREAM_TIMEOUT_MS } from "@/app/api/_lib/proxy";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildQuery / apiUrl", () => {
  it("drops empty values, joins arrays with commas and encodes values", () => {
    expect(
      buildQuery({
        lat: 28.6,
        lon: 77.2,
        types: ["EQ", "TC"],
        empty: "",
        none: undefined,
        nil: null,
        emptyList: [],
        flag: false,
        query: "flood & rain",
      }),
    ).toBe("?lat=28.6&lon=77.2&types=EQ%2CTC&flag=false&query=flood+%26+rain");
  });

  it("returns an empty string when nothing remains", () => {
    expect(buildQuery()).toBe("");
    expect(buildQuery({ a: undefined, b: "" })).toBe("");
  });

  it("prefixes the proxy path and tolerates leading slashes and api/ prefixes", () => {
    expect(apiUrl("weather", { lat: 1, lon: 2 })).toBe("/api/backend/weather?lat=1&lon=2");
    expect(apiUrl("/incidents")).toBe("/api/backend/incidents");
    expect(apiUrl("api/alerts/news")).toBe("/api/backend/alerts/news");
    expect(apiUrl("/api/backend/sos")).toBe("/api/backend/sos");
  });
});

describe("apiFetch success paths", () => {
  it("sends JSON bodies and returns the parsed response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }, { status: 201 }));

    const result = await apiFetch<{ ok: boolean }>("push/unsubscribe", {
      method: "POST",
      body: { endpoint: "https://push.example/1" },
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/backend/push/unsubscribe");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ endpoint: "https://push.example/1" }));
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
  });

  it("does not send a body or Content-Type for GET requests", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ incidents: [] }));
    await apiFetch("incidents", { query: { status: "open" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/backend/incidents?status=open");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("returns undefined for 204 No Content", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiFetch("push/test", { method: "POST" })).resolves.toBeUndefined();
  });
});

describe("apiFetch error parsing", () => {
  it("parses the backend error envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "not_found", message: "Incident not found", request_id: "req-123" } },
        { status: 404 },
      ),
    );

    const error = await apiFetch("incidents/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: "not_found",
      message: "Incident not found",
      requestId: "req-123",
    });
    expect((error as ApiError).isClientError).toBe(true);
  });

  it("reads Retry-After on rate-limit errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "rate_limited", message: "Too many requests", request_id: "r" } },
        { status: 429, headers: { "Retry-After": "42" } },
      ),
    );
    const error = (await apiFetch("sos", { method: "POST", body: {} }).catch((e) => e)) as ApiError;
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfter).toBe(42);
    expect(getErrorMessage(error)).toContain("42s");
  });

  it("parses FastAPI {detail: [...]} validation bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { detail: [{ loc: ["query", "lat"], msg: "Input should be less than or equal to 90" }] },
        { status: 422, headers: { "X-Request-ID": "hdr-1" } },
      ),
    );
    const error = (await apiFetch("weather").catch((e) => e)) as ApiError;
    expect(error.status).toBe(422);
    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("lat: Input should be less than or equal to 90");
    expect(error.requestId).toBe("hdr-1");
  });

  it("parses {detail: string} bodies", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Not authenticated" }, { status: 401 }));
    const error = (await apiFetch("sos/history").catch((e) => e)) as ApiError;
    expect(error).toMatchObject({ status: 401, code: "unauthorized", message: "Not authenticated" });
    expect(error.isUnauthorized).toBe(true);
  });

  it("falls back to plain text bodies", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Service temporarily down", { status: 503 }));
    const error = (await apiFetch("health").catch((e) => e)) as ApiError;
    expect(error).toMatchObject({ status: 503, code: "service_unavailable", message: "Service temporarily down" });
  });

  it("never surfaces HTML error pages as the message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html><body>Bad gateway</body></html>", { status: 502, statusText: "Bad Gateway" }),
    );
    const error = (await apiFetch("health").catch((e) => e)) as ApiError;
    expect(error.message).toBe("Bad Gateway");
    expect(error.code).toBe("upstream_error");
  });

  it("rejects invalid JSON in a 2xx response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{not json", { status: 200 }));
    const error = (await apiFetch("health").catch((e) => e)) as ApiError;
    expect(error.code).toBe("invalid_response");
    expect(error.status).toBe(200);
  });

  it("errorFromResponse handles an empty body", async () => {
    const error = await errorFromResponse(new Response(null, { status: 500, statusText: "Server Error" }));
    expect(error).toMatchObject({ status: 500, code: "internal_error", message: "Server Error" });
  });
});

describe("apiFetch transport failures", () => {
  it("maps fetch rejections to a network_error with status 0", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const error = (await apiFetch("weather").catch((e) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: "network_error" });
    expect(error.isNetworkError).toBe(true);
    expect(getErrorMessage(error)).toMatch(/can't reach/i);
  });

  it("aborts and reports a timeout after timeoutMs", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );

    const pending = apiFetch("chat", { method: "POST", body: { message: "help" }, timeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toMatchObject({ status: 0, code: "timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("reports caller cancellation as aborted (not as a timeout)", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const controller = new AbortController();
    const pending = apiFetch("weather", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 0, code: "aborted" });
  });
});

describe("typed helpers and SWR integration", () => {
  it("getWeather builds the lat/lon query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ weather: {}, forecast: [], alerts: [], hazards: [] }));
    await getWeather({ lat: 12.5, lon: -45.25 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/weather?lat=12.5&lon=-45.25");
  });

  it("encodes ids in path segments", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "a/b" }));
    await getIncident("a/b?x");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/incidents/a%2Fb%3Fx");
  });

  it("createIncident POSTs the input", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "1" }, { status: 201 }));
    const input = {
      lat: 1,
      lon: 2,
      disaster_type: "flood" as const,
      severity: "high" as const,
      description: "Water rising fast on Main St",
    };
    await createIncident(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/backend/incidents");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it("fetcher accepts tuple keys and plain paths", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }));
    await fetcher(swrKeys.weather({ lat: 28.613912, lon: 77.209023 }));
    await fetcher("health");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend/weather?lat=28.6139&lon=77.209");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/backend/health");
  });

  it("swrKeys round coordinates and omit missing ones", () => {
    expect(roundCoord(12.345678)).toBe(12.3457);
    expect(swrKeys.incidents({ status: "all" })).toEqual([
      "incidents",
      { status: "all", lat: undefined, lon: undefined },
    ]);
    expect(swrKeys.incident("x y")).toEqual(["incidents/x%20y"]);
  });
});


describe("saved (offline) copies served by the service worker", () => {
  it("keeps X-ResQ-Offline / X-ResQ-Cached-At on the parsed body", async () => {
    // Regression: apiFetch dropped the headers, so hours-old data looked live.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { incidents: [] },
        { headers: { "X-ResQ-Offline": "1", "X-ResQ-Cached-At": "2026-11-02T10:00:00.000Z" } },
      ),
    );
    const data = await apiFetch<{ incidents: unknown[] }>("incidents");
    expect(getResponseMeta(data)).toEqual({ offline: true, cachedAt: "2026-11-02T10:00:00.000Z" });
    expect(isSavedCopy(data)).toBe(true);
    // Invisible to serialisation and equality checks.
    expect(JSON.stringify(data)).toBe('{"incidents":[]}');
    expect(data).toEqual({ incidents: [] });
  });

  it("live responses carry no metadata; a bad timestamp is dropped", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    expect(getResponseMeta(await apiFetch("weather"))).toBeNull();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true }, { headers: { "X-ResQ-Offline": "1", "X-ResQ-Cached-At": "yesterday-ish" } }),
    );
    expect(getResponseMeta(await apiFetch("weather"))).toEqual({ offline: true, cachedAt: null });
    expect(getResponseMeta(null)).toBeNull();
    expect(getResponseMeta("text")).toBeNull();
  });

  it("keeps the nearest-location distance and the server-error reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { ok: true },
        {
          headers: {
            "X-ResQ-Offline": "1",
            "X-ResQ-Cached-Distance-M": "812.4",
            "X-ResQ-Offline-Reason": "server-error",
          },
        },
      ),
    );
    expect(getResponseMeta(await apiFetch("weather"))).toEqual({
      offline: true,
      cachedAt: null,
      distanceM: 812,
      reason: "server-error",
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true }, { headers: { "X-ResQ-Offline": "1", "X-ResQ-Cached-Distance-M": "far" } }),
    );
    expect(getResponseMeta(await apiFetch("weather"))).toEqual({ offline: true, cachedAt: null });
  });

  it("compareApiData treats a saved copy and live data with the same content as different", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ a: 1 }, { headers: { "X-ResQ-Offline": "1" } }));
    const saved = await apiFetch("weather");
    fetchMock.mockResolvedValueOnce(jsonResponse({ a: 1 }));
    const live = await apiFetch("weather");
    expect(compareApiData(saved, live)).toBe(false);
    expect(compareApiData(live, { a: 1 })).toBe(true);
    expect(compareApiData(live, { a: 2 })).toBe(false);
    expect(compareApiData(undefined, undefined)).toBe(true);
  });
});


describe("timeout layering", () => {
  it("slow endpoints (SOS, chat) wait longer than the proxy's upstream timeout", async () => {
    expect(SLOW_TIMEOUT_MS).toBeGreaterThan(UPSTREAM_TIMEOUT_MS);
    vi.useFakeTimers();
    let aborted = false;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = sendSOS({ lat: 1, lon: 2, message: "help", contact_numbers: [] }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 1_000);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(SLOW_TIMEOUT_MS);
    expect(aborted).toBe(true);
    expect(await pending).toBeInstanceOf(ApiError);
  });
});
