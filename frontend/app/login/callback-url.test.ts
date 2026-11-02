import { describe, expect, it } from "vitest";

import { firstParam, sanitizeCallbackUrl } from "@/app/login/callback-url";

describe("sanitizeCallbackUrl", () => {
  it("keeps same-app relative paths (with query and hash)", () => {
    expect(sanitizeCallbackUrl("/incidents/new?lat=1&lon=2")).toBe("/incidents/new?lat=1&lon=2");
    expect(sanitizeCallbackUrl("/profile#push")).toBe("/profile#push");
  });

  it("falls back for empty values", () => {
    expect(sanitizeCallbackUrl(undefined)).toBe("/");
    expect(sanitizeCallbackUrl("")).toBe("/");
    expect(sanitizeCallbackUrl(null, "/map")).toBe("/map");
  });

  it("rejects open redirects", () => {
    expect(sanitizeCallbackUrl("https://evil.example/x")).toBe("/");
    expect(sanitizeCallbackUrl("//evil.example/x")).toBe("/");
    expect(sanitizeCallbackUrl("/\\evil.example")).toBe("/");
    expect(sanitizeCallbackUrl("javascript:alert(1)")).toBe("/");
  });

  it("accepts absolute URLs on the current origin", () => {
    const origin = window.location.origin;
    expect(sanitizeCallbackUrl(`${origin}/alerts?tab=news`)).toBe("/alerts?tab=news");
  });

  it("never sends users back to auth pages", () => {
    expect(sanitizeCallbackUrl("/login?callbackUrl=/x")).toBe("/");
    expect(sanitizeCallbackUrl("/register")).toBe("/");
    expect(sanitizeCallbackUrl("/api/auth/signout")).toBe("/");
  });

  it("uses the first value of repeated params", () => {
    expect(sanitizeCallbackUrl(["/map", "/chat"])).toBe("/map");
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam("c")).toBe("c");
  });
});
