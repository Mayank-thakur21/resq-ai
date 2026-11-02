/**
 * Phone-number helpers shared by the contacts page, the SOS page and the offline page.
 *
 * Pure functions only (no React, no browser APIs): safe in server components and tests.
 *
 * The SOS backend only accepts international E.164 numbers (`+` country code + subscriber
 * number, 7–15 digits, e.g. `+919876543210`). These helpers mirror the backend's
 * normalisation (`app/schemas/sos.py::normalize_e164`) so the UI can tell the user *before*
 * sending which saved contacts can receive an SOS text:
 *
 *   "+91 98765-43210"  → "+919876543210"   (separators stripped)
 *   "0044 20 7946 0958" → "+442079460958"  ("00" international prefix → "+")
 *   "98765 43210"      → null              (no country code: cannot be sent safely)
 *
 * We never guess a country code: texting the wrong country in an emergency is worse than
 * asking the user to fix the number.
 */

/** E.164: "+", a country code that does not start with 0, 7–15 digits in total. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** Characters removed before validation (same set as the backend). */
const SEPARATORS = /[\s\-().]/g;

/** Characters a user may type into a phone field. */
const ALLOWED_INPUT = /^[+\d\s\-().]+$/;

/** Maximum length of a phone number as typed (with separators). */
export const MAX_PHONE_INPUT_LENGTH = 32;

/** Strips separators and turns a leading international "00" into "+". Never throws. */
export function normalizePhone(raw: string | null | undefined): string {
  let candidate = String(raw ?? "").replace(SEPARATORS, "");
  if (candidate.startsWith("00")) candidate = `+${candidate.slice(2)}`;
  return candidate;
}

/** True when `value` is already a canonical E.164 number (no separators). */
export function isE164(value: string | null | undefined): boolean {
  return typeof value === "string" && E164_PATTERN.test(value);
}

/**
 * Converts user input to E.164, or returns `null` when that is not possible without
 * guessing (missing country code, letters, too short/long).
 */
export function toE164(raw: string | null | undefined): string | null {
  const candidate = normalizePhone(raw);
  return isE164(candidate) ? candidate : null;
}

export type PhoneValidation =
  | { ok: true; /** Value to store: E.164 when convertible, else the trimmed input. */ value: string; e164: string | null }
  | { ok: false; error: string };

/**
 * Validates a phone number typed into the contacts form.
 *
 * Local numbers (no country code) and short codes (e.g. "112") are accepted — they can still
 * be called — but `e164` is `null` so the UI can warn that they can't receive SOS texts.
 */
export function validatePhoneInput(raw: string | null | undefined): PhoneValidation {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "Enter a phone number." };
  if (trimmed.length > MAX_PHONE_INPUT_LENGTH) {
    return { ok: false, error: "That phone number is too long." };
  }
  if (!ALLOWED_INPUT.test(trimmed)) {
    return { ok: false, error: "Use digits only, optionally starting with + and the country code." };
  }
  if (trimmed.indexOf("+") > 0 || (trimmed.match(/\+/g)?.length ?? 0) > 1) {
    return { ok: false, error: "The + sign can only appear once, at the start." };
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 3) return { ok: false, error: "That phone number is too short." };
  if (digits.length > 15) return { ok: false, error: "Phone numbers have at most 15 digits." };

  const e164 = toE164(trimmed);
  return { ok: true, value: e164 ?? trimmed, e164 };
}

/**
 * Masks a number exactly like the backend's `mask_phone` (`+919876543210` →
 * `+91******3210`). Used to match per-recipient SMS results (which only contain masked
 * numbers) back to the user's saved contacts.
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return "";
  const text = String(value).trim();
  if (text.length <= 4) return "*".repeat(text.length);
  if (text.length < 9) return "*".repeat(text.length - 2) + text.slice(-2);
  return `${text.slice(0, 3)}${"*".repeat(text.length - 7)}${text.slice(-4)}`;
}

/**
 * `tel:` link for a number or service code. Keeps only characters dialers understand
 * (`+`, digits, `*`, `#`), so "112 (International Emergency)" → "tel:112".
 */
export function telHref(value: string): string {
  const leading = String(value).trim().match(/^[+\d\s\-().*#]+/)?.[0] ?? "";
  const dialable = leading.replace(/[^\d+*#]/g, "");
  return `tel:${dialable}`;
}

/**
 * Native SMS app link with the recipients and body pre-filled — the same `sms:` format the
 * backend returns as `fallback_sms_uri` (`sms:<n1>,<n2>?&body=<urlencoded>`; the `?&` form
 * works on both iOS and Android). Used when the SOS request itself fails.
 */
export function buildSmsUri(numbers: readonly string[], body: string): string {
  const recipients = numbers.map((n) => normalizePhone(n)).filter(Boolean).join(",");
  return `sms:${recipients}?&body=${encodeURIComponent(body)}`;
}
