// @vitest-environment node
import { jwtVerify } from "jose";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getServerSession` is the only thing the proxy needs from next-auth; everything else in the
// module graph (providers in lib/auth.ts) is imported from sub-paths and stays real.
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));

import { getServerSession } from "next-auth";

import { buildBackendPath } from "@/app/api/_lib/proxy";

import { DELETE, GET, PATCH, POST } from "./route";

const SECRET = "proxy-test-secret";
const mockedSession = vi.mocked(getServerSession);
let fetchMock: ReturnType<typeof vi.fn>;

function ctx(...path: string[]) {
  return { params: Promise.resolve({ path }) };
}

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

function upstreamJson(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

/** The `[url, init]` of the n-th upstream fetch, with headers normalised. */
function upstreamCall(n = 0): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

beforeEach(() => {
  vi.stubEnv("BACKEND_URL", "http://backend.test:8000");
  vi.stubEnv("BACKEND_JWT_SECRET", SECRET);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockedSession.mockResolvedValue(null);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("path validation", () => {
  it.each([
    [["users", "register"]],
    [["users"]],
    [["Users", "verify"]],
    [["incidents", "users"]],
  ])("blocks internal users endpoints: %j", async (path) => {
    const res = await POST(
      req(`/api/backend/${path.join("/")}`, {
        method: "POST",
        body: JSON.stringify({ email: "a@b.c", password: "x" }),
        headers: { "content-type": "application/json" },
      }),
      ctx(...path),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.request_id).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[[".."]], [["incidents", ".."]], [["."]], [["a%2F..", "x"].map(decodeURIComponent)], [["a\\b"]], [[""]]])(
    "rejects traversal and malformed segments: %j",
    async (path) => {
      const res = await GET(req("/api/backend/x"), ctx(...path));
      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a request without any path", async () => {
    const res = await GET(req("/api/backend"), { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
  });

  it("buildBackendPath encodes segments", () => {
    expect(buildBackendPath(["incidents", "a b?c#d"])).toBe("incidents/a%20b%3Fc%23d");
    expect(buildBackendPath(["alerts", "disasters"])).toBe("alerts/disasters");
  });
});

describe("client address", () => {
  it("reports the hop added by our trusted proxy, authenticated with the internal key", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    vi.stubEnv("INTERNAL_API_KEY", "internal-secret");
    fetchMock.mockResolvedValue(upstreamJson({ ok: true }));

    // A forged first hop is ignored; the right-most entry was written by our proxy.
    await POST(
      req("/api/backend/sos", {
        method: "POST",
        body: JSON.stringify({ lat: 1, lon: 2 }),
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "10.0.0.66, 203.0.113.7",
          "x-resq-client-ip": "6.6.6.6",
        },
      }),
      ctx("sos"),
    );

    const { headers } = upstreamCall();
    expect(headers.get("x-resq-client-ip")).toBe("203.0.113.7");
    expect(headers.get("x-internal-key")).toBe("internal-secret");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("rotating forged first hops all map to the same client", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    vi.stubEnv("INTERNAL_API_KEY", "internal-secret");
    fetchMock.mockImplementation(async () => upstreamJson({ ok: true }));
    for (let i = 0; i < 3; i += 1) {
      await GET(
        req("/api/backend/weather", { headers: { "x-forwarded-for": `10.0.0.${i}, 198.51.100.9` } }),
        ctx("weather"),
      );
    }
    const reported = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("x-resq-client-ip"),
    );
    expect(reported).toEqual(["198.51.100.9", "198.51.100.9", "198.51.100.9"]);
  });

  it("sends no client address (and no internal key) when it cannot be determined", async () => {
    vi.stubEnv("INTERNAL_API_KEY", "internal-secret");
    fetchMock.mockResolvedValueOnce(upstreamJson({ ok: true }));
    await GET(req("/api/backend/weather", { headers: { "x-forwarded-for": "garbage" } }), ctx("weather"));
    const { headers } = upstreamCall();
    expect(headers.get("x-resq-client-ip")).toBeNull();
    expect(headers.get("x-internal-key")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
  });

  it("never forwards the internal key without INTERNAL_API_KEY", async () => {
    fetchMock.mockResolvedValueOnce(upstreamJson({ ok: true }));
    await GET(req("/api/backend/weather", { headers: { "x-forwarded-for": "203.0.113.7" } }), ctx("weather"));
    const { headers } = upstreamCall();
    expect(headers.get("x-internal-key")).toBeNull();
    expect(headers.get("x-resq-client-ip")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });
});

describe("forwarding", () => {
  it("forwards GET with the query string to ${BACKEND_URL}/api/<path>", async () => {
    fetchMock.mockResolvedValueOnce(upstreamJson({ weather: { temperature: 30 } }));

    const res = await GET(
      req("/api/backend/weather?lat=28.6&lon=77.2", {
        headers: {
          "accept-language": "hi-IN",
          "x-forwarded-for": "203.0.113.7, 10.0.0.1",
          "x-request-id": "client-req-1",
          cookie: "next-auth.session-token=secret-cookie",
          authorization: "Bearer attacker-supplied",
        },
      }),
      ctx("weather"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weather: { temperature: 30 } });

    const { url, init, headers } = upstreamCall();
    expect(url).toBe("http://backend.test:8000/api/weather?lat=28.6&lon=77.2");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(headers.get("accept-language")).toBe("hi-IN");
    // TRUSTED_PROXY_HOPS unset (0): only the right-most entry (what Next.js recorded) is used;
    // the browser's chain is never forwarded as-is.
    expect(headers.get("x-forwarded-for")).toBe("10.0.0.1");
    expect(headers.get("x-request-id")).toBe("client-req-1");
    // Browser credentials are never forwarded.
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  it("forwards JSON bodies for POST and PATCH", async () => {
    fetchMock.mockImplementation(async () => upstreamJson({ id: "inc-1" }, { status: 201 }));
    const payload = { lat: 1, lon: 2, disaster_type: "flood" };

    const postRes = await POST(
      req("/api/backend/incidents", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
      ctx("incidents"),
    );
    expect(postRes.status).toBe(201);
    const first = upstreamCall(0);
    expect(first.init.method).toBe("POST");
    expect(first.init.body).toBe(JSON.stringify(payload));
    expect(first.headers.get("content-type")).toBe("application/json");

    await PATCH(
      req("/api/backend/incidents/inc-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "resolved" }),
        headers: { "content-type": "application/json" },
      }),
      ctx("incidents", "inc-1"),
    );
    const second = upstreamCall(1);
    expect(second.url).toBe("http://backend.test:8000/api/incidents/inc-1");
    expect(second.init.method).toBe("PATCH");
  });

  it("supports DELETE without a body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await DELETE(req("/api/backend/push/sub-1", { method: "DELETE" }), ctx("push", "sub-1"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(upstreamCall().init.body).toBeUndefined();
  });

  it("rejects non-JSON bodies with 415", async () => {
    const res = await POST(
      req("/api/backend/chat", {
        method: "POST",
        body: "message=hi",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      ctx("chat"),
    );
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe("unsupported_media_type");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects bodies over 1 MB with 413", async () => {
    const huge = JSON.stringify({ message: "x".repeat(1024 * 1024 + 10) });
    const res = await POST(
      req("/api/backend/chat", {
        method: "POST",
        body: huge,
        headers: { "content-type": "application/json" },
      }),
      ctx("chat"),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays backend status, body and rate-limit headers", async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamJson(
        { error: { code: "rate_limited", message: "Slow down", request_id: "be-9" } },
        {
          status: 429,
          headers: {
            "Retry-After": "30",
            "X-RateLimit-Limit": "5",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "1700000000",
            "X-Request-ID": "be-9",
            "Set-Cookie": "backend=1",
          },
        },
      ),
    );

    const res = await POST(
      req("/api/backend/sos", {
        method: "POST",
        body: JSON.stringify({ lat: 1, lon: 2, contact_numbers: [] }),
        headers: { "content-type": "application/json" },
      }),
      ctx("sos"),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-ratelimit-limit")).toBe("5");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(res.headers.get("x-ratelimit-reset")).toBe("1700000000");
    expect(res.headers.get("x-request-id")).toBe("be-9");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error.message).toBe("Slow down");
  });
});

describe("authentication", () => {
  it("attaches a backend JWT only when a session exists", async () => {
    mockedSession.mockResolvedValueOnce({
      user: { id: "user-42", email: "ravi@example.com", name: "Ravi" },
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
    fetchMock.mockResolvedValueOnce(upstreamJson({ events: [] }));

    await GET(req("/api/backend/sos/history"), ctx("sos", "history"));

    const authorization = upstreamCall().headers.get("authorization");
    expect(authorization).toMatch(/^Bearer /);
    const { payload } = await jwtVerify(
      authorization!.slice("Bearer ".length),
      new TextEncoder().encode(SECRET),
      { issuer: "resq-frontend", audience: "resq-backend" },
    );
    expect(payload).toMatchObject({ sub: "user-42", email: "ravi@example.com", name: "Ravi" });
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it("forwards anonymously without a session", async () => {
    mockedSession.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValueOnce(upstreamJson({ incidents: [] }));
    await GET(req("/api/backend/incidents"), ctx("incidents"));
    expect(upstreamCall().headers.get("authorization")).toBeNull();
  });

  it("forwards anonymously when the session has no user id", async () => {
    mockedSession.mockResolvedValueOnce({ user: { name: "x" }, expires: "" } as never);
    fetchMock.mockResolvedValueOnce(upstreamJson({}));
    await GET(req("/api/backend/incidents"), ctx("incidents"));
    expect(upstreamCall().headers.get("authorization")).toBeNull();
  });

  it("still serves public endpoints when reading the session fails", async () => {
    mockedSession.mockRejectedValueOnce(new Error("JWT decode failed"));
    fetchMock.mockResolvedValueOnce(upstreamJson({ status: "ok" }));
    const res = await GET(req("/api/backend/health"), ctx("health"));
    expect(res.status).toBe(200);
    expect(upstreamCall().headers.get("authorization")).toBeNull();
  });

  it("forwards without Authorization when BACKEND_JWT_SECRET is missing", async () => {
    vi.stubEnv("BACKEND_JWT_SECRET", "");
    mockedSession.mockResolvedValueOnce({ user: { id: "u1" }, expires: "" });
    fetchMock.mockResolvedValueOnce(upstreamJson({}));
    const res = await GET(req("/api/backend/incidents"), ctx("incidents"));
    expect(res.status).toBe(200);
    expect(upstreamCall().headers.get("authorization")).toBeNull();
  });
});

describe("upstream failures", () => {
  it("returns 502 backend_unreachable when the backend cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }));
    const res = await GET(req("/api/backend/weather?lat=1&lon=2"), ctx("weather"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("backend_unreachable");
    expect(body.error.message).toMatch(/unreachable/i);
    expect(typeof body.error.request_id).toBe("string");
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("returns 504 backend_timeout when the upstream timeout fires", async () => {
    const timedOut = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timedOut);
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));

    const res = await GET(req("/api/backend/chat"), ctx("chat"));
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("backend_timeout");
  });

  it("generates a request id when the client sends none (or an invalid one)", async () => {
    fetchMock.mockResolvedValueOnce(upstreamJson({}));
    await GET(req("/api/backend/health", { headers: { "x-request-id": "bad id with spaces" } }), ctx("health"));
    const forwarded = upstreamCall().headers.get("x-request-id");
    expect(forwarded).toMatch(/^[0-9a-f-]{36}$/);
  });
});
