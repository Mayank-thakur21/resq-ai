// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_IP_HEADER,
  clientIpHeaders,
  normaliseIp,
  resetClientIpWarningForTests,
  resolveClientIp,
  trustedProxyHops,
} from "@/lib/client-ip";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetClientIpWarningForTests();
});

function xff(value: string): Headers {
  return new Headers({ "x-forwarded-for": value });
}

describe("trustedProxyHops", () => {
  it.each([
    [undefined, 0],
    ["", 0],
    ["1", 1],
    [" 2 ", 2],
    ["-1", 0],
    ["1.5", 0],
    ["abc", 0],
    ["99", 10],
  ])("TRUSTED_PROXY_HOPS=%j -> %d", (raw, expected) => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: raw } as unknown as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("normaliseIp", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    [" 203.0.113.7 ", "203.0.113.7"],
    ["203.0.113.7:51234", "203.0.113.7"],
    ["2001:DB8::1", "2001:db8::1"],
    ["[2001:db8::1]", "2001:db8::1"],
    ["[2001:db8::1]:443", "2001:db8::1"],
    ["::ffff:198.51.100.4", "198.51.100.4"],
    ["unknown", null],
    ["", null],
    [null, null],
    ["<script>", null],
  ])("%j -> %j", (input, expected) => {
    expect(normaliseIp(input)).toBe(expected);
  });
});

describe("resolveClientIp", () => {
  it("ignores everything left of the hop recorded by our trusted proxy", () => {
    // Regression: the first (client-controlled) hop used to be trusted.
    expect(resolveClientIp(xff("10.0.0.1, 203.0.113.7"), 1)).toBe("203.0.113.7");
    for (let i = 0; i < 5; i += 1) {
      expect(resolveClientIp(xff(`10.0.0.${i}, 198.51.100.9`), 1)).toBe("198.51.100.9");
    }
  });

  it("counts several trusted proxies from the right", () => {
    expect(resolveClientIp(xff("6.6.6.6, 203.0.113.7, 10.0.0.2"), 2)).toBe("203.0.113.7");
    // Shorter chain than expected: the left-most entry is the best guess.
    expect(resolveClientIp(xff("203.0.113.7"), 3)).toBe("203.0.113.7");
  });

  it("uses the address Next.js recorded when no proxy is trusted", () => {
    expect(resolveClientIp(xff("192.0.2.10"), 0)).toBe("192.0.2.10");
    expect(resolveClientIp(xff("10.0.0.1, 192.0.2.10"), 0)).toBe("192.0.2.10");
  });

  it("returns null without a usable header", () => {
    expect(resolveClientIp(new Headers(), 1)).toBeNull();
    expect(resolveClientIp(xff(" , "), 1)).toBeNull();
    expect(resolveClientIp(xff("not-an-ip"), 1)).toBeNull();
    expect(resolveClientIp(null, 1)).toBeNull();
  });

  it("reads plain header objects (NextAuth's authorize request)", () => {
    expect(resolveClientIp({ "x-forwarded-for": "10.0.0.1, 198.51.100.4" }, 1)).toBe(
      "198.51.100.4",
    );
    expect(resolveClientIp({ "x-forwarded-for": ["10.0.0.1", "198.51.100.4"] }, 1)).toBe(
      "198.51.100.4",
    );
    expect(resolveClientIp({}, 1)).toBeNull();
  });

  it("reads TRUSTED_PROXY_HOPS by default", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(resolveClientIp(xff("6.6.6.6, 203.0.113.7, 10.0.0.2"))).toBe("203.0.113.7");
  });

  it("warns once in production when no proxy is trusted", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resolveClientIp(xff("192.0.2.10"), 0);
    resolveClientIp(xff("192.0.2.11"), 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("TRUSTED_PROXY_HOPS=0");
  });
});

describe("clientIpHeaders", () => {
  it("pairs the client address with the internal key", () => {
    const headers = clientIpHeaders("203.0.113.7", "internal-secret");
    expect(headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
    expect(headers.get("x-internal-key")).toBe("internal-secret");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("sends only X-Forwarded-For without an internal key, nothing without an address", () => {
    const keyless = clientIpHeaders("203.0.113.7", null);
    expect(keyless.get(CLIENT_IP_HEADER)).toBeNull();
    expect(keyless.get("x-internal-key")).toBeNull();
    expect([...clientIpHeaders(null, "internal-secret").keys()]).toEqual([]);
  });
});
