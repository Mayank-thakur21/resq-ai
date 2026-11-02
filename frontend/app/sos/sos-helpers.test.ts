import { describe, expect, it } from "vitest";

import {
  buildLocalSmsBody,
  buildSosRequest,
  DEFAULT_SOS_MESSAGE,
  effectiveMessage,
  formatAccuracy,
  matchSmsResults,
  MAX_SMS_BODY_LENGTH,
  needsSmsFallback,
  safeSmsUri,
} from "@/app/sos/sos-helpers";

const NOW = new Date(Date.UTC(2026, 10, 2, 9, 5));

describe("buildSosRequest", () => {
  it("builds the backend payload, deduping numbers and dropping empty optionals", () => {
    expect(
      buildSosRequest({
        location: { lat: 28.6139, lon: 77.209, accuracy: 12.345 },
        message: "  Trapped   on the roof ",
        numbers: ["+919876543210", "+919876543210", "+14155552671"],
        userName: "  ",
      }),
    ).toEqual({
      lat: 28.6139,
      lon: 77.209,
      accuracy_m: 12.3,
      message: "Trapped on the roof",
      contact_numbers: ["+919876543210", "+14155552671"],
    });
  });

  it("uses the default message, caps contacts at 10 and keeps the name", () => {
    const numbers = Array.from({ length: 12 }, (_, i) => `+9198765432${String(i).padStart(2, "0")}`);
    const request = buildSosRequest({
      location: { lat: 1, lon: 2, accuracy: null },
      message: "",
      numbers,
      userName: "Asha",
    });
    expect(request.message).toBe(DEFAULT_SOS_MESSAGE);
    expect(request.contact_numbers).toHaveLength(10);
    expect(request.user_name).toBe("Asha");
    expect(request).not.toHaveProperty("accuracy_m");
  });

  it("caps the message at 300 characters", () => {
    expect(effectiveMessage("x".repeat(400))).toHaveLength(300);
  });
});

describe("buildLocalSmsBody", () => {
  it("mirrors the backend SMS format", () => {
    expect(
      buildLocalSmsBody({ name: "Asha", message: "Help!", location: { lat: 28.6139, lon: 77.209 }, now: NOW }),
    ).toBe("🆘 SOS from Asha: Help! | Location: https://maps.google.com/?q=28.613900,77.209000 | 2026-11-02 09:05 UTC");
  });

  it("omits the location when unknown and uses Anonymous without a name", () => {
    expect(buildLocalSmsBody({ message: "", location: null, now: NOW })).toBe(
      `🆘 SOS from Anonymous: ${DEFAULT_SOS_MESSAGE} | 2026-11-02 09:05 UTC`,
    );
  });

  it("shortens the message (never the link or time) to fit 320 characters", () => {
    const body = buildLocalSmsBody({
      name: "Asha",
      message: "word ".repeat(80),
      location: { lat: 28.6139, lon: 77.209 },
      now: NOW,
    });
    expect(body.length).toBeLessThanOrEqual(MAX_SMS_BODY_LENGTH);
    expect(body).toContain("…");
    expect(body).toContain("https://maps.google.com/?q=28.613900,77.209000");
    expect(body.endsWith("2026-11-02 09:05 UTC")).toBe(true);
  });
});

describe("SMS results", () => {
  const recipients = [
    { contact: { name: "Mom", phone: "+919876543210", custom: true }, e164: "+919876543210" },
    { contact: { name: "Dad", phone: "+14155552671", custom: true }, e164: "+14155552671" },
  ];

  it("maps masked numbers back to contact names", () => {
    expect(
      matchSmsResults(
        {
          configured: true,
          sent: [{ to: "+91******3210", sid: "SM1", status: "queued" }],
          failed: [{ to: "+14*****2671", error: "Unreachable" }],
        },
        recipients,
      ),
    ).toEqual([
      { to: "+91******3210", name: "Mom", status: "sent", detail: "queued" },
      { to: "+14*****2671", name: "Dad", status: "failed", detail: "Unreachable" },
    ]);
  });

  it("needs the native SMS fallback when not configured or anything failed", () => {
    expect(needsSmsFallback({ sms: { configured: false, sent: [], failed: [] } })).toBe(true);
    expect(needsSmsFallback({ sms: { configured: true, sent: [], failed: [{ to: "x", error: "e" }] } })).toBe(true);
    expect(needsSmsFallback({ sms: { configured: true, sent: [{ to: "x", sid: "s", status: "queued" }], failed: [] } })).toBe(
      false,
    );
  });

  it("only trusts sms: URIs from the server", () => {
    expect(safeSmsUri("sms:+1?&body=hi", "sms:fallback")).toBe("sms:+1?&body=hi");
    expect(safeSmsUri("javascript:alert(1)", "sms:fallback")).toBe("sms:fallback");
    expect(safeSmsUri(undefined, "sms:fallback")).toBe("sms:fallback");
  });
});

describe("formatAccuracy", () => {
  it("formats metres and kilometres", () => {
    expect(formatAccuracy(12.4)).toBe("±12 m");
    expect(formatAccuracy(0.2)).toBe("±1 m");
    expect(formatAccuracy(1500)).toBe("±1.5 km");
    expect(formatAccuracy(25_000)).toBe("±25 km");
    expect(formatAccuracy(null)).toBe("");
  });
});
