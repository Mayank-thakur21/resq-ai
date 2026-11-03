/**
 * Sign-out that also forgets per-user data cached on this device.
 *
 * - The service worker caches GET weather/alerts/incidents/places responses (network-first
 *   fallback); incident payloads include `upvoted_by_me` and the cache keys hold the user's
 *   query coordinates, so the next person on this device must not see them. The cache
 *   ({@link API_CACHE_NAME}) is deleted from the page itself (CacheStorage is shared with the
 *   worker, so this also works when no worker controls the page, e.g. after a hard reload),
 *   and the active worker is told with a `CLEAR_API_CACHE` message, so responses still in
 *   flight are not written back into the cache afterwards (`public/sw.js`).
 * - The chat transcript lives in sessionStorage for the tab (`CHAT_HISTORY_STORAGE_KEY`).
 * - An unsent incident report draft (sessionStorage, `INCIDENT_DRAFT_KEY` in
 *   `components/IncidentForm.tsx`) is the signed-in user's own text.
 * - The push re-sync marker (`resq_push_synced`) is cleared and the device's push subscription
 *   is unlinked from the account (`POST /push/unlink`), so the previous user's test and
 *   personal notifications stop reaching this device; the next sign-in re-links it.
 * - The last known location (`LAST_FIX_STORAGE_KEY` in `lib/geo.ts`, used offline) goes with
 *   the API cache it points into.
 * - The remembered SOS sender name (`SOS_NAME_STORAGE_KEY`, `lib/sos-name.ts`); it is also
 *   tied to the identity it was used under, so it never reaches another account.
 * - `components/SessionDataGuard.tsx` runs {@link forgetUserData} as well when a different
 *   account signs in on this device without signing out first (e.g. an expired session).
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
import { SOS_NAME_STORAGE_KEY } from "@/lib/sos-name";

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
export const LOCAL_KEYS_CLEARED_ON_SIGN_OUT: readonly string[] = [LAST_FIX_STORAGE_KEY, SOS_NAME_STORAGE_KEY];

/** Message understood by `public/sw.js` (drops the API response cache). */
export const CLEAR_API_CACHE_MESSAGE = { type: "CLEAR_API_CACHE" } as const;

/**
 * Name of the service worker's API response cache: `resq-api-v${DATA_CACHE_VERSION}` in
 * `public/sw.js` (`lib/sign-out.test.ts` keeps the two equal).
 */
export const API_CACHE_NAME = "resq-api-v2";

/** The worker to tell: the page's controller, else the active one (uncontrolled page). */
async function activeServiceWorker(): Promise<ServiceWorker | null> {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container) return null;
  if (container.controller) return container.controller;
  const registration = await container.getRegistration?.();
  return registration?.active ?? null;
}

/** Clears cached per-user data; never rejects (missing SW / blocked storage are fine). */
export async function forgetUserData(): Promise<void> {
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
  try {
    // First, so the worker stops storing responses that are still in flight.
    (await activeServiceWorker())?.postMessage(CLEAR_API_CACHE_MESSAGE);
  } catch {
    // No service worker: nothing is in flight.
  }
  try {
    if (typeof caches !== "undefined") await caches.delete(API_CACHE_NAME);
  } catch {
    // CacheStorage unavailable (insecure context, blocked storage): nothing is cached.
  }
}

/**
 * Forgets cached per-user data, unlinks this device's push subscription from the account
 * (best effort, a few seconds at most), then signs out via NextAuth (redirects to
 * `callbackUrl`).
 */
export async function signOutAndForget(callbackUrl = "/"): Promise<void> {
  await forgetUserData();
  await unlinkCurrentSubscription();
  await signOut({ callbackUrl });
}
