/**
 * The sender name remembered on this device between SOS uses (`/sos`), together with the
 * identity it was used under ({@link identityTag}; `""` for anonymous use).
 *
 * A name is only offered again to the same identity: after Alice signs out (or her session
 * expires) and Bob signs in, Bob's SOS must not go out as "SOS from Alice". The key is also
 * removed on sign-out (`lib/sign-out.ts`). Values from older versions (a plain string with no
 * identity) are ignored.
 *
 * A tiny module of its own so the Navbar's sign-out code does not pull in the SOS page.
 */

import { writeUserData } from "@/lib/user-data";

/** localStorage key: `{"name": string, "owner": string}`. */
export const SOS_NAME_STORAGE_KEY = "resq_sos_name";

interface StoredSosName {
  name: string;
  owner: string;
}

function isStoredSosName(value: unknown): value is StoredSosName {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.owner === "string";
}

/** The name remembered for `owner`, or `""` (none, another identity's, or unreadable). */
export function readSosName(owner: string): string {
  try {
    const raw = window.localStorage.getItem(SOS_NAME_STORAGE_KEY);
    if (!raw) return "";
    const parsed: unknown = JSON.parse(raw);
    return isStoredSosName(parsed) && parsed.owner === owner ? parsed.name.trim() : "";
  } catch {
    return ""; // storage blocked, or an old plain-text value
  }
}

/**
 * Remembers `name` for `owner` (an empty name forgets it); never throws. Not remembered while
 * signing out (`lib/user-data.ts`).
 */
export function storeSosName(name: string, owner: string): void {
  const clean = name.trim();
  const value: StoredSosName = { name: clean, owner };
  writeUserData("local", SOS_NAME_STORAGE_KEY, clean ? JSON.stringify(value) : null);
}
