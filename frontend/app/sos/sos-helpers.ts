/**
 * Pure helpers for the SOS page (no React, no browser APIs) — unit tested in
 * `sos-helpers.test.ts`.
 *
 * The local SMS body mirrors the backend (`app/api/routes/sos.py::build_sms_body`) so the
 * "Open SMS app" fallback reads the same whether the request succeeded or failed.
 */

import type { SosRecipient } from "@/lib/contacts";
import { mapsLink } from "@/lib/geo";
import { maskPhone } from "@/lib/phone";
import type { SMSResult, SOSRequest, SOSResponse } from "@/lib/types";

export const DEFAULT_SOS_MESSAGE = "SOS! I need help!";
export const MAX_SOS_MESSAGE_LENGTH = 300;
export const MAX_SOS_CONTACTS = 10;
export const MAX_SOS_NAME_LENGTH = 80;
/** Same cap as the backend (`MAX_SMS_BODY_CHARS`). */
export const MAX_SMS_BODY_LENGTH = 320;
const ANONYMOUS_NAME = "Anonymous";
const ELLIPSIS = "…";

export interface MessagePreset {
  id: string;
  label: string;
  text: string;
}

export const SOS_MESSAGE_PRESETS: readonly MessagePreset[] = [
  { id: "help", label: "Need help", text: DEFAULT_SOS_MESSAGE },
  { id: "medical", label: "Medical", text: "SOS! I'm injured and need medical help." },
  { id: "trapped", label: "Trapped", text: "SOS! I'm trapped and can't get out." },
  { id: "flood", label: "Flood", text: "SOS! I'm caught in flooding and need to be evacuated." },
  { id: "fire", label: "Fire", text: "SOS! There's a fire and I need help getting out." },
  { id: "danger", label: "In danger", text: "SOS! I'm in danger and need help urgently." },
];

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The message that will actually be sent (trimmed, default when empty, max 300 chars). */
export function effectiveMessage(message: string): string {
  const clean = collapse(message);
  return (clean || DEFAULT_SOS_MESSAGE).slice(0, MAX_SOS_MESSAGE_LENGTH);
}

export interface SosLocation {
  lat: number;
  lon: number;
  accuracy: number | null;
}

/** Builds the `POST /sos` body: deduped numbers (max 10), optional fields omitted when empty. */
export function buildSosRequest(input: {
  location: SosLocation;
  message: string;
  numbers: readonly string[];
  userName?: string | null;
}): SOSRequest {
  const request: SOSRequest = {
    lat: input.location.lat,
    lon: input.location.lon,
    message: effectiveMessage(input.message),
    contact_numbers: [...new Set(input.numbers)].slice(0, MAX_SOS_CONTACTS),
  };
  const accuracy = input.location.accuracy;
  if (accuracy !== null && Number.isFinite(accuracy) && accuracy >= 0) {
    request.accuracy_m = Math.min(100_000, Math.round(accuracy * 10) / 10);
  }
  const name = collapse(input.userName ?? "").slice(0, MAX_SOS_NAME_LENGTH);
  if (name) request.user_name = name;
  return request;
}

function utcStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())} UTC`;
}

/**
 * SMS text used when the SOS request could not reach the server (same format as the
 * backend): `🆘 SOS from {name}: {message} | Location: {link} | {UTC time}` — the message is
 * shortened so the whole text stays within 320 characters; the link and time are never cut.
 * Without a location the "Location" part is omitted.
 */
export function buildLocalSmsBody(input: {
  name?: string | null;
  message: string;
  location: Pick<SosLocation, "lat" | "lon"> | null;
  now?: Date;
}): string {
  const name = collapse(input.name ?? "") || ANONYMOUS_NAME;
  const message = effectiveMessage(input.message);
  const stamp = utcStamp(input.now ?? new Date());
  const where = input.location ? ` | Location: ${mapsLink(input.location.lat, input.location.lon)}` : "";
  const render = (text: string) => `🆘 SOS from ${name}: ${text}${where} | ${stamp}`;

  const body = render(message);
  if (body.length <= MAX_SMS_BODY_LENGTH) return body;
  const budget = MAX_SMS_BODY_LENGTH - render("").length;
  if (budget > ELLIPSIS.length) return render(`${message.slice(0, budget - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`);
  return render("").slice(0, MAX_SMS_BODY_LENGTH);
}

/**
 * Returns `uri` only when it is an `sms:` URI (defence in depth: never render a server-provided
 * `javascript:` or `http:` link as the SMS button), otherwise `fallback`.
 */
export function safeSmsUri(uri: string | null | undefined, fallback: string): string {
  return typeof uri === "string" && /^sms:/i.test(uri.trim()) ? uri.trim() : fallback;
}

/** The native SMS fallback is needed when Twilio isn't configured or any send failed. */
export function needsSmsFallback(response: Pick<SOSResponse, "sms">): boolean {
  return !response.sms.configured || response.sms.failed.length > 0;
}

export interface RecipientOutcome {
  /** Masked number as returned by the backend. */
  to: string;
  /** Saved contact name when the masked number matches one of the selected contacts. */
  name: string | null;
  status: "sent" | "failed";
  /** Twilio status ("queued", "sent"…) or the error message. */
  detail: string;
}

/**
 * Matches the backend's per-number SMS results (masked numbers only) to the selected
 * contacts, so the UI can say "Sent to Mom" instead of "+91******3210".
 */
export function matchSmsResults(sms: SMSResult, recipients: readonly SosRecipient[]): RecipientOutcome[] {
  const pool = recipients
    .filter((recipient) => recipient.e164)
    .map((recipient) => ({ name: recipient.contact.name, masked: maskPhone(recipient.e164), used: false }));

  const nameFor = (masked: string): string | null => {
    const match = pool.find((entry) => !entry.used && entry.masked === masked);
    if (!match) return null;
    match.used = true;
    return match.name;
  };

  return [
    ...sms.sent.map((item) => ({
      to: item.to,
      name: nameFor(item.to),
      status: "sent" as const,
      detail: item.status,
    })),
    ...sms.failed.map((item) => ({
      to: item.to,
      name: nameFor(item.to),
      status: "failed" as const,
      detail: item.error,
    })),
  ];
}

/** "±12 m" / "±1.2 km" accuracy label; empty when unknown. */
export function formatAccuracy(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters) || meters < 0) return "";
  if (meters < 1000) return `±${Math.max(1, Math.round(meters))} m`;
  return `±${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

/** Accuracy worse than this is flagged as approximate in the UI. */
export const POOR_ACCURACY_METERS = 500;
