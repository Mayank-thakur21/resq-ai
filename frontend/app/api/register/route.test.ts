// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

let fetchMock: ReturnType<typeof vi.fn>;

function register(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost:3000/api/register", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

const valid = { name: "  Priya  ", email: " Priya@Example.COM ", password: "correct-horse-9" };

beforeEach(() => {
  vi.stubEnv("BACKEND_URL", "http://backend.test:8000");
  vi.stubEnv("INTERNAL_API_KEY", "internal-secret");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/register", () => {
  it("validates, normalises and forwards to the internal backend endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "u-1", email: "priya@example.com", name: "Priya" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await register(valid, { "x-forwarded-for": "198.51.100.4" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "u-1", email: "priya@example.com", name: "Priya" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("http://backend.test:8000/api/users/register");
    expect(headers.get("x-internal-key")).toBe("internal-secret");
    expect(headers.get("x-forwarded-for")).toBe("198.51.100.4");
    // Lets the backend limit registrations per end client.
    expect(headers.get("x-resq-client-ip")).toBe("198.51.100.4");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Priya",
      email: "priya@example.com",
      password: "correct-horse-9",
    });
  });

  it.each([
    [{ ...valid, email: "not-an-email" }, /email/],
    [{ ...valid, password: "short" }, /password/],
    [{ ...valid, name: "   " }, /name/],
    [{ ...valid, name: "x".repeat(81) }, /name/],
    [{ email: "a@b.co" }, /name/],
  ])("returns 422 validation_error for %j", async (body, pattern) => {
    const res = await register(body);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("validation_error");
    expect(json.error.message).toMatch(pattern);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON and 415 for non-JSON content", async () => {
    expect((await register("{oops")).status).toBe(400);
    const res = await register("name=x", { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it("maps a duplicate email (409) to a conflict envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "conflict", message: "exists", request_id: "x" } }), {
        status: 409,
      }),
    );
    const res = await register(valid);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("conflict");
    expect(json.error.message).toMatch(/already exists/);
  });

  it("returns 503 not_configured when INTERNAL_API_KEY is missing", async () => {
    vi.stubEnv("INTERNAL_API_KEY", "");
    const res = await register(valid);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 backend_unreachable on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await register(valid);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("backend_unreachable");
  });

  it("passes rate limiting through with Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "60" } }));
    const res = await register(valid);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("reports a busy backend as service_busy (not as a configuration problem)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "service_busy", message: "busy", request_id: "r" } }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
      }),
    );
    const res = await register(valid);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("service_busy");
    expect(res.headers.get("retry-after")).toBe("2");

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const misconfigured = await register(valid);
    expect((await misconfigured.json()).error.code).toBe("not_configured");
  });
});
