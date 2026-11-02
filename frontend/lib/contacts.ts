/**
 * Trusted emergency contacts, stored on this device only.
 *
 * Storage contract (shared by `/contacts`, `/sos` and `/offline`): `localStorage["resq_contacts"]`
 * holds a JSON array of the user's own contacts, `[{ "name": "Mom", "phone": "+9198…", "custom": true }]`.
 * The built-in service numbers ({@link DEFAULT_EMERGENCY_CONTACTS}) are never stored.
 * The format is the one v1 of the contacts page wrote, so existing users keep their contacts.
 *
 * Contacts never leave the device except when the user sends an SOS (the selected numbers
 * are posted to the backend, which texts them) or shares a message themselves.
 *
 * Like `lib/geo.ts`, this is not a "use client" module: the pure helpers can be imported
 * anywhere; only client components may call {@link useContacts}.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { toE164, validatePhoneInput } from "@/lib/phone";

export const CONTACTS_STORAGE_KEY = "resq_contacts";
/** Same-tab change notification (the `storage` event only fires in *other* tabs). */
export const CONTACTS_CHANGED_EVENT = "resq:contacts-changed";

export const MAX_CUSTOM_CONTACTS = 25;
export const MAX_CONTACT_NAME_LENGTH = 80;

export interface Contact {
  name: string;
  phone: string;
  /** `true` for the user's own contacts; built-in service numbers omit it. */
  custom?: boolean;
}

/** Built-in emergency services (India defaults + the international 112). Never stored. */
export const DEFAULT_EMERGENCY_CONTACTS: readonly Contact[] = Object.freeze([
  { name: "National Emergency", phone: "112" },
  { name: "Ambulance", phone: "108" },
  { name: "Police", phone: "100" },
  { name: "Fire", phone: "101" },
]);

// ---------------------------------------------------------------------------------------
// Parsing & serialisation (pure)
// ---------------------------------------------------------------------------------------

/** Stable identity for list keys and de-duplication. */
export function contactKey(contact: Pick<Contact, "name" | "phone">): string {
  return `${contact.phone}|${contact.name}`;
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_CONTACT_NAME_LENGTH) : "";
}

/** Longest stored phone string we keep (v1 saved free text without validation). */
const MAX_STORED_PHONE_LENGTH = 64;

/**
 * Parses the stored JSON tolerantly: malformed JSON, non-arrays, entries without a name or
 * without any digit in the phone, and duplicates are dropped instead of throwing.
 *
 * Deliberately lenient about the phone format: v1 stored whatever the user typed, and
 * dropping those entries here would delete them on the next save. Invalid numbers are kept
 * (still callable / editable) and simply aren't offered as SOS recipients.
 */
export function parseStoredContacts(raw: string | null | undefined): Contact[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const contacts: Contact[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { name, phone } = item as { name?: unknown; phone?: unknown };
    const cleanPhone = typeof phone === "string" ? phone.trim().slice(0, MAX_STORED_PHONE_LENGTH) : "";
    const cleaned = cleanName(name);
    if (!cleaned || !/\d/.test(cleanPhone)) continue;
    const contact: Contact = { name: cleaned, phone: cleanPhone, custom: true };
    const key = contactKey(contact);
    if (seen.has(key)) continue;
    seen.add(key);
    contacts.push(contact);
    if (contacts.length >= MAX_CUSTOM_CONTACTS) break;
  }
  return contacts;
}

/** Serialises the user's own contacts (built-ins are filtered out). */
export function serializeContacts(contacts: readonly Contact[]): string {
  return JSON.stringify(
    contacts
      .filter((contact) => contact.custom)
      .slice(0, MAX_CUSTOM_CONTACTS)
      .map(({ name, phone }) => ({ name, phone, custom: true })),
  );
}

export type ContactInputResult =
  | { ok: true; contact: Contact }
  | { ok: false; errors: { name?: string; phone?: string; form?: string } };

/**
 * Validates the "add contact" form against the current list (duplicates, limit).
 * Phone numbers are stored in E.164 when convertible so the SOS page can use them directly.
 */
export function validateContactInput(
  input: { name: string; phone: string },
  existing: readonly Contact[],
): ContactInputResult {
  const errors: { name?: string; phone?: string; form?: string } = {};
  const name = cleanName(input.name);
  if (!name) errors.name = "Enter a name.";
  else if (input.name.trim().length > MAX_CONTACT_NAME_LENGTH) {
    errors.name = `Names can be at most ${MAX_CONTACT_NAME_LENGTH} characters.`;
  }

  const phone = validatePhoneInput(input.phone);
  if (!phone.ok) errors.phone = phone.error;

  const custom = existing.filter((contact) => contact.custom);
  if (phone.ok) {
    const comparable = phone.e164 ?? phone.value.replace(/\D/g, "");
    const duplicate = custom.find(
      (contact) => (toE164(contact.phone) ?? contact.phone.replace(/\D/g, "")) === comparable,
    );
    if (duplicate) errors.phone = `This number is already saved as “${duplicate.name}”.`;
  }
  if (custom.length >= MAX_CUSTOM_CONTACTS) {
    errors.form = `You can save up to ${MAX_CUSTOM_CONTACTS} contacts. Remove one to add another.`;
  }

  if (errors.name || errors.phone || errors.form || !phone.ok) return { ok: false, errors };
  return { ok: true, contact: { name, phone: phone.value, custom: true } };
}

/** A saved contact plus its E.164 form (`null` when it can't receive SOS texts). */
export interface SosRecipient {
  contact: Contact;
  e164: string | null;
}

/** The user's own contacts annotated for the SOS picker (built-in services excluded). */
export function toSosRecipients(contacts: readonly Contact[]): SosRecipient[] {
  return contacts
    .filter((contact) => contact.custom)
    .map((contact) => ({ contact, e164: toE164(contact.phone) }));
}

// ---------------------------------------------------------------------------------------
// Storage (every access guarded: private mode, disabled storage, quota)
// ---------------------------------------------------------------------------------------

/**
 * In-memory fallback when localStorage is unavailable, so the pages still work for the
 * current visit (the UI tells the user contacts won't be remembered).
 */
let memoryFallback: string | null = null;

/** Test helper: forget the in-memory fallback copy. */
export function resetContactsMemoryForTests(): void {
  memoryFallback = null;
}

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True when contacts can be persisted on this device. */
export function isContactStorageAvailable(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    const probe = "__resq_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function readRaw(): string | null {
  // Set only when the last write could not be persisted, so it is the newest copy.
  if (memoryFallback !== null) return memoryFallback;
  const storage = getStorage();
  if (storage) {
    try {
      return storage.getItem(CONTACTS_STORAGE_KEY);
    } catch {
      return null;
    }
  }
  return null;
}

/** Reads the user's own contacts (never throws). */
export function loadContacts(): Contact[] {
  return parseStoredContacts(readRaw());
}

/**
 * Persists the user's own contacts and notifies same-tab subscribers.
 * @returns `true` when written to localStorage, `false` when only kept in memory.
 */
export function saveContacts(contacts: readonly Contact[]): boolean {
  const raw = serializeContacts(contacts);
  let persisted = false;
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(CONTACTS_STORAGE_KEY, raw);
      persisted = true;
    } catch (error) {
      console.warn("[contacts] could not save to localStorage", error);
    }
  }
  memoryFallback = persisted ? null : raw;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CONTACTS_CHANGED_EVENT));
  }
  return persisted;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CONTACTS_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CONTACTS_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CONTACTS_CHANGED_EVENT, onChange);
  };
}

const getServerSnapshot = (): string | null => null;

// ---------------------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------------------

export interface UseContactsResult {
  /** The user's own contacts (built-ins excluded). Empty until `ready`. */
  contacts: Contact[];
  /** False during SSR / the hydration render (storage not read yet). */
  ready: boolean;
  /** False when contacts can't be persisted (private mode, disabled storage). */
  persistent: boolean;
  add: (input: { name: string; phone: string }) => ContactInputResult;
  remove: (contact: Contact) => void;
  /** Re-inserts a removed contact at its previous position (undo). */
  restore: (contact: Contact, index: number) => void;
}

/**
 * Live view of the saved contacts, kept in sync across components and browser tabs.
 * SSR-safe: renders an empty list on the server and during hydration.
 */
export function useContacts(): UseContactsResult {
  // The raw string is a stable snapshot (same string → no re-render).
  const raw = useSyncExternalStore(subscribe, readRaw, getServerSnapshot);
  const contacts = useMemo(() => parseStoredContacts(raw), [raw]);
  const [ready, setReady] = useState(false);
  const [persistent, setPersistent] = useState(true);

  useEffect(() => {
    setPersistent(isContactStorageAvailable());
    setReady(true);
  }, []);

  const add = useCallback((input: { name: string; phone: string }) => {
    const current = loadContacts();
    const result = validateContactInput(input, current);
    if (result.ok) setPersistent(saveContacts([...current, result.contact]));
    return result;
  }, []);

  const remove = useCallback((contact: Contact) => {
    const key = contactKey(contact);
    setPersistent(saveContacts(loadContacts().filter((item) => contactKey(item) !== key)));
  }, []);

  const restore = useCallback((contact: Contact, index: number) => {
    const current = loadContacts();
    if (current.some((item) => contactKey(item) === contactKey(contact))) return;
    const next = [...current];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, { ...contact, custom: true });
    setPersistent(saveContacts(next));
  }, []);

  return { contacts: ready ? contacts : [], ready, persistent, add, remove, restore };
}
