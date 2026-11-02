/**
 * Sign-out that also forgets per-user data cached on this device.
 *
 * - The service worker caches GET weather/alerts/incidents/places responses (network-first
 *   fallback); incident payloads include `upvoted_by_me`, so the next person on this device
 *   must not see them. `public/sw.js` clears that cache on a `CLEAR_API_CACHE` message.
 * - The chat transcript lives in sessionStorage for the tab (`CHAT_HISTORY_STORAGE_KEY`).
 * - An unsent incident report draft (sessionStorage, `INCIDENT_DRAFT_KEY` in
 *   `components/IncidentForm.tsx`) is the signed-in user's own text.
 * - The push re-sync marker (`resq_push_synced`) is cleared and the device's push subscription
 *   is unlinked from the account (`POST /push/unlink`), so the previous user's test and
 *   personal notifications stop reaching this device; the next sign-in re-links it.
 * - The last known location (`LAST_FIX_STORAGE_KEY` in `lib/geo.ts`, used offline) goes with
 *   the API cache it points into.
 *
 * Device-level data that is not tied to an account (emergency contacts, checklist progress,
 * dismissed alerts, map preferences) is intentionally kept.
 *
 * Used by every "Sign out" control (Navbar desktop menu, mobile "More" sheet, profile page).
 */

import { signOut } from "next-auth/react";

import { CHAT_HISTORY_STORAGE_KEY } from "@/app/chat/chat-helpers";
import { LAST_FIX_STORAGE_KEY } from "@/lib/geo";
import { PUSH_SYNCED_STORAGE_KEY, unlinkCurrentSubscription } from "@/lib/push";

/**
 * Mirrors `INCIDENT_DRAFT_KEY` (components/IncidentForm.tsx). Not imported from there so the
 * Navbar bundle does not pull in the incident form; `lib/sign-out.test.ts` keeps them equal.
 */
export const INCIDENT_DRAFT_STORAGE_KEY = "resq_incident_draft";

/** Per-user sessionStorage entries removed on sign-out. */
export const SESSION_KEYS_CLEARED_ON_SIGN_OUT: readonly string[] = [
  CHAT_HISTORY_STORAGE_KEY,
  INCIDENT_DRAFT_STORAGE_KEY,
  PUSH_SYNCED_STORAGE_KEY,
];

/** localStorage entries removed on sign-out. */
export const LOCAL_KEYS_CLEARED_ON_SIGN_OUT: readonly string[] = [LAST_FIX_STORAGE_KEY];

/** Message understood by `public/sw.js` (drops the API response cache). */
export const CLEAR_API_CACHE_MESSAGE = { type: "CLEAR_API_CACHE" } as const;

/** Clears cached per-user data; never throws (missing SW / blocked storage are fine). */
export function forgetUserData(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage(CLEAR_API_CACHE_MESSAGE);
  } catch {
    // No (controlling) service worker: nothing is cached.
  }
  for (const key of SESSION_KEYS_CLEARED_ON_SIGN_OUT) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage disabled: nothing was stored.
    }
  }
  for (const key of LOCAL_KEYS_CLEARED_ON_SIGN_OUT) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage disabled: nothing was stored.
    }
  }
}

/**
 * Forgets cached per-user data, unlinks this device's push subscription from the account
 * (best effort, a few seconds at most), then signs out via NextAuth (redirects to
 * `callbackUrl`).
 */
export async function signOutAndForget(callbackUrl = "/"): Promise<void> {
  forgetUserData();
  await unlinkCurrentSubscription();
  await signOut({ callbackUrl });
}
