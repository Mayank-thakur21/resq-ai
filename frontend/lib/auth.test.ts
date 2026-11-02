// @vitest-environment node
import type { Account, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_ERROR_CODES, authOptions, verifyCredentials } from "@/lib/auth";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("BACKEND_URL", "http://backend.test:8000");
  vi.stubEnv("INTERNAL_API_KEY", "internal-secret");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("verifyCredentials", () => {
  it("returns the backend user for valid credentials", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "u-1", email: "a@b.co", name: "Ana" }), { status: 200 }),
    );

    const user = await verifyCredentials({ email: " A@B.co ", password: "secret-pass" });

    expect(user).toEqual({ id: "u-1", email: "a@b.co", name: "Ana" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.test:8000/api/users/verify");
    expect(new Headers(init.headers).get("x-internal-key")).toBe("internal-secret");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.co", password: "secret-pass" });
  });

  it("reports the browser's address so failed sign-ins are throttled per client", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "u-1", email: "a@b.co", name: "Ana" }), { status: 200 }),
    );
    await verifyCredentials({ email: "a@b.co", password: "secret-pass" }, "203.0.113.7");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("x-resq-client-ip")).toBe("203.0.113.7");

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await verifyCredentials({ email: "a@b.co", password: "x" });
    const [, second] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new Headers(second.headers).get("x-resq-client-ip")).toBeNull();
  });

  it("authorize() resolves the client address from the request headers", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const provider = authOptions.providers[0] as unknown as {
      options: { authorize: (c: unknown, r: unknown) => Promise<unknown> };
    };
    await provider.options.authorize(
      { email: "a@b.co", password: "x" },
      { headers: { "x-forwarded-for": "10.9.9.9, 198.51.100.4" } },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("x-resq-client-ip")).toBe("198.51.100.4");
  });

  it("returns null for wrong credentials (401)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(verifyCredentials({ email: "a@b.co", password: "nope" })).resolves.toBeNull();
  });

  it("returns null without calling the backend for malformed input", async () => {
    await expect(verifyCredentials({ email: "not-an-email", password: "x" })).resolves.toBeNull();
    await expect(verifyCredentials(undefined)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws AuthUnavailable when the backend is unreachable or errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(verifyCredentials({ email: "a@b.co", password: "x" })).rejects.toThrow(
      AUTH_ERROR_CODES.unavailable,
    );
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    await expect(verifyCredentials({ email: "a@b.co", password: "x" })).rejects.toThrow(
      AUTH_ERROR_CODES.unavailable,
    );
  });

  it("throws AuthRateLimited when the backend limits attempts for this email (429)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many", request_id: "r" } }), {
        status: 429,
        headers: { "Retry-After": "42" },
      }),
    );
    await expect(verifyCredentials({ email: "a@b.co", password: "x" })).rejects.toThrow(
      AUTH_ERROR_CODES.rateLimited,
    );
  });

  it("throws AuthNotConfigured without an internal key or when the backend says 503", async () => {
    vi.stubEnv("INTERNAL_API_KEY", "");
    await expect(verifyCredentials({ email: "a@b.co", password: "x" })).rejects.toThrow(
      AUTH_ERROR_CODES.notConfigured,
    );
    vi.stubEnv("INTERNAL_API_KEY", "k");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(verifyCredentials({ email: "a@b.co", password: "x" })).rejects.toThrow(
      AUTH_ERROR_CODES.notConfigured,
    );
  });

  it("treats a busy backend (503 service_busy) as temporarily unavailable", async () => {
    vi.stubEnv("INTERNAL_API_KEY", "k");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "service_busy", message: "busy", request_id: "r" } }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
      }),
    );
    await expect(verifyCredentials({ email: "a@b.co", password: "x" })).rejects.toThrow(
      AUTH_ERROR_CODES.unavailable,
    );
  });
});

describe("authOptions callbacks", () => {
  const jwt = authOptions.callbacks!.jwt!;
  const session = authOptions.callbacks!.session!;
  const redirect = authOptions.callbacks!.redirect!;

  it("uses JWT sessions and the custom sign-in page", () => {
    expect(authOptions.session?.strategy).toBe("jwt");
    expect(authOptions.pages?.signIn).toBe("/login");
  });

  it("stores the credentials user id as token.uid", async () => {
    const token = await jwt({
      token: { sub: "u-1" } as JWT,
      user: { id: "u-1", name: "Ana", email: "a@b.co" } as User,
      account: { type: "credentials", provider: "credentials", providerAccountId: "u-1" } as Account,
    } as never);
    expect(token.uid).toBe("u-1");
    expect(token.name).toBe("Ana");
  });

  it("prefixes OAuth user ids with the provider", async () => {
    const token = await jwt({
      token: {} as JWT,
      user: { id: "12345" } as User,
      account: { type: "oauth", provider: "github", providerAccountId: "12345" } as Account,
    } as never);
    expect(token.uid).toBe("github:12345");
  });

  it("keeps the token unchanged on subsequent requests", async () => {
    const token = await jwt({ token: { uid: "google:9" } as JWT } as never);
    expect(token.uid).toBe("google:9");
  });

  it("exposes token.uid as session.user.id", async () => {
    const result = (await session({
      session: { user: { name: "Ana", email: "a@b.co" }, expires: "2099-01-01" } as Session,
      token: { uid: "github:7" } as JWT,
    } as never)) as Session;
    expect(result.user.id).toBe("github:7");
  });

  it("only redirects within the app origin", async () => {
    const baseUrl = "http://localhost:3000";
    await expect(redirect({ url: "/incidents/new", baseUrl })).resolves.toBe(
      "http://localhost:3000/incidents/new",
    );
    await expect(redirect({ url: "http://localhost:3000/profile", baseUrl })).resolves.toBe(
      "http://localhost:3000/profile",
    );
    await expect(redirect({ url: "https://evil.example/phish", baseUrl })).resolves.toBe(baseUrl);
    await expect(redirect({ url: "//evil.example", baseUrl })).resolves.toBe(baseUrl);
  });
});
