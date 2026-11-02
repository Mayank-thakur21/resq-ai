// @vitest-environment node
import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKEND_TOKEN_AUDIENCE,
  BACKEND_TOKEN_ISSUER,
  BACKEND_TOKEN_TTL_SECONDS,
  BackendTokenConfigError,
  getBackendUrl,
  getInternalApiKey,
  mintBackendToken,
} from "@/lib/backend-token";

const SECRET = "test-backend-secret-with-enough-entropy";
const key = new TextEncoder().encode(SECRET);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mintBackendToken", () => {
  it("mints an HS256 JWT with the claims the backend requires", async () => {
    const token = await mintBackendToken(
      { id: "user-123", email: "ana@example.com", name: "Ana" },
      { secret: SECRET },
    );

    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "JWT" });

    const { payload } = await jwtVerify(token, key, {
      issuer: BACKEND_TOKEN_ISSUER,
      audience: BACKEND_TOKEN_AUDIENCE,
      algorithms: ["HS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    expect(payload.sub).toBe("user-123");
    expect(payload.iss).toBe("resq-frontend");
    expect(payload.aud).toBe("resq-backend");
    expect(payload.email).toBe("ana@example.com");
    expect(payload.name).toBe("Ana");
    expect(typeof payload.jti).toBe("string");
    expect(payload.exp! - payload.iat!).toBe(BACKEND_TOKEN_TTL_SECONDS);
    expect(BACKEND_TOKEN_TTL_SECONDS).toBe(300);
  });

  it("reads the secret from BACKEND_JWT_SECRET by default", async () => {
    vi.stubEnv("BACKEND_JWT_SECRET", SECRET);
    const token = await mintBackendToken({ id: "github:42" });
    const { payload } = await jwtVerify(token, key, {
      issuer: BACKEND_TOKEN_ISSUER,
      audience: BACKEND_TOKEN_AUDIENCE,
    });
    expect(payload.sub).toBe("github:42");
  });

  it("omits optional claims that are empty", async () => {
    const token = await mintBackendToken({ id: "u1", email: null, name: "" }, { secret: SECRET });
    const { payload } = await jwtVerify(token, key);
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("name");
  });

  it("cannot be verified with a different secret", async () => {
    const token = await mintBackendToken({ id: "u1" }, { secret: SECRET });
    await expect(jwtVerify(token, new TextEncoder().encode("another-secret"))).rejects.toBeInstanceOf(
      joseErrors.JWSSignatureVerificationFailed,
    );
  });

  it("produces tokens that expire after the TTL", async () => {
    const issued = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const token = await mintBackendToken({ id: "u1" }, { secret: SECRET, now: issued });
    await expect(jwtVerify(token, key)).rejects.toBeInstanceOf(joseErrors.JWTExpired);
  });

  it("throws BackendTokenConfigError when no secret is configured", async () => {
    vi.stubEnv("BACKEND_JWT_SECRET", "");
    await expect(mintBackendToken({ id: "u1" })).rejects.toBeInstanceOf(BackendTokenConfigError);
  });

  it("refuses to mint a token without a subject", async () => {
    await expect(mintBackendToken({ id: "" }, { secret: SECRET })).rejects.toThrow(/user id/);
  });
});

describe("backend env helpers", () => {
  it("defaults BACKEND_URL and strips trailing slashes", () => {
    vi.stubEnv("BACKEND_URL", "");
    expect(getBackendUrl()).toBe("http://localhost:8000");
    vi.stubEnv("BACKEND_URL", "http://backend:8000///");
    expect(getBackendUrl()).toBe("http://backend:8000");
  });

  it("returns null for an unset internal key", () => {
    vi.stubEnv("INTERNAL_API_KEY", "  ");
    expect(getInternalApiKey()).toBeNull();
    vi.stubEnv("INTERNAL_API_KEY", "k3y");
    expect(getInternalApiKey()).toBe("k3y");
  });
});
