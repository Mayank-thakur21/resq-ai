import { describe, expect, it } from "vitest";

import {
  buildSmsUri,
  isE164,
  maskPhone,
  normalizePhone,
  telHref,
  toE164,
  validatePhoneInput,
} from "@/lib/phone";

describe("normalizePhone / toE164", () => {
  it("strips separators like the backend", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalizePhone("+1 (415) 555.2671")).toBe("+14155552671");
    expect(toE164("+91 98765-43210")).toBe("+919876543210");
  });

  it("turns the international 00 prefix into +", () => {
    expect(toE164("0044 20 7946 0958")).toBe("+442079460958");
  });

  it("never guesses a country code", () => {
    expect(toE164("98765 43210")).toBeNull();
    expect(toE164("112")).toBeNull();
    expect(toE164("+0123456789")).toBeNull();
    expect(toE164("+91 98765 ext 1")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
  });

  it("enforces the E.164 length (7–15 digits)", () => {
    expect(isE164("+1234567")).toBe(true);
    expect(isE164("+123456")).toBe(false);
    expect(isE164("+123456789012345")).toBe(true);
    expect(isE164("+1234567890123456")).toBe(false);
  });
});

describe("validatePhoneInput", () => {
  it("accepts international numbers and stores them in E.164", () => {
    expect(validatePhoneInput(" +91 98765 43210 ")).toEqual({
      ok: true,
      value: "+919876543210",
      e164: "+919876543210",
    });
  });

  it("accepts local numbers and service codes, flagged as not E.164", () => {
    expect(validatePhoneInput("98765 43210")).toEqual({ ok: true, value: "98765 43210", e164: null });
    expect(validatePhoneInput("112")).toEqual({ ok: true, value: "112", e164: null });
  });

  it.each([
    ["", "Enter a phone number."],
    ["12", "That phone number is too short."],
    ["call me", "Use digits only"],
    ["91+98765", "The + sign"],
    ["+1234567890123456", "at most 15 digits"],
  ])("rejects %j", (input, message) => {
    const result = validatePhoneInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe("maskPhone", () => {
  it("matches the backend's mask_phone", () => {
    expect(maskPhone("+919876543210")).toBe("+91******3210");
    expect(maskPhone("+14155552671")).toBe("+14*****2671");
    expect(maskPhone("+1234567")).toBe("******67");
    expect(maskPhone("1234")).toBe("****");
    expect(maskPhone("")).toBe("");
  });
});

describe("telHref / buildSmsUri", () => {
  it("keeps only dialable characters", () => {
    expect(telHref("112 (International Emergency)")).toBe("tel:112");
    expect(telHref("+91 98765-43210")).toBe("tel:+919876543210");
    expect(telHref("*123#")).toBe("tel:*123#");
  });

  it("builds the same sms: URI format as the backend fallback", () => {
    expect(buildSmsUri(["+919876543210", "+1 415 555 2671"], "SOS & help: https://maps.google.com/?q=1,2")).toBe(
      "sms:+919876543210,+14155552671?&body=SOS%20%26%20help%3A%20https%3A%2F%2Fmaps.google.com%2F%3Fq%3D1%2C2",
    );
    expect(buildSmsUri([], "Help")).toBe("sms:?&body=Help");
  });
});
