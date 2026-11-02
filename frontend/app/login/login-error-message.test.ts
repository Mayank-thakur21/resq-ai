import { describe, expect, it } from "vitest";

import { loginErrorMessage } from "@/app/login/LoginForm";

describe("loginErrorMessage", () => {
  it("maps authorize() error codes to user-facing copy", () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage("CredentialsSignin")).toMatch(/incorrect email or password/i);
    expect(loginErrorMessage("AuthUnavailable")).toMatch(/can't reach/i);
    expect(loginErrorMessage("AuthNotConfigured")).toMatch(/temporarily unavailable/i);
    // Backend per-email limiter (429 rate_limited on /api/users/verify).
    expect(loginErrorMessage("AuthRateLimited")).toMatch(/too many failed sign-in attempts/i);
    expect(loginErrorMessage("SomethingNew")).toBe("Sign-in failed. Please try again.");
  });
});
