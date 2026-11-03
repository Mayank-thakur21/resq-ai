/**
 * Sign-out that also forgets per-user data cached on this device.
 *
 * - The service worker caches GET weather/alerts/incidents/places responses (network-first
 *   fallback); incident payloads include `upvoted_by_me` and the cache keys hold the user's
 *   query coordinates, so the next person on this device must not see them. The cache
 *   ({@link API_CACHE_NAME}) is deleted from the page itself (CacheStorage is shared with the
 *   worker, so this also works when no worker controls the page, e.g. after a hard reload),
 *   and the active worker is told with a `CLEAR_API_CACHE` message, so responses still in
 *   flight are not written back into the cache afterwards (`public/sw.js`). Signing out does
 *   this twice, before and after the session cookie is deleted ({@link signOutAndForget}).
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

/** True while {@link signOutAndForget} runs; see there. */
let signingOut = false;

/**
 * Whether a sign-out is under way. `components/Providers.tsx` passes this to SWR as
 * `isPaused`, so no hook starts a request (e.g. the 60 s incidents refresh) with the session
 * that is about to end.
 */
export function isSigningOut(): boolean {
  return signingOut;
}

/**
 * Same-origin path to load after signing out; anything else (another origin, malformed)
 * becomes "/". The callers pass app paths; this only guards against a future misuse turning
 * sign-out into an open redirect.
 */
function signedOutDestination(callbackUrl: string): string {
  try {
    const target = new URL(callbackUrl, window.location.origin);
    if (target.origin === window.location.origin) return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    // Malformed: fall through to the home page.
  }
  return "/";
}

/**
 * Signs out and forgets this device's per-user data, in an order that leaves nothing
 * fetched with the ending session in the service worker's cache:
 *
 * 1. SWR revalidation is paused ({@link isSigningOut}), so the app's own refreshes do not
 *    start requests with the old session while this runs (unlinking and the sign-out request
 *    can take seconds on a slow network).
 * 2. {@link forgetUserData} right away, so the data is gone even if the sign-out request
 *    hangs or fails (offline).
 * 3. This device's push subscription is unlinked from the account (best effort, a few
 *    seconds at most; it needs the session, so it runs before 4).
 * 4. NextAuth's sign-out request (`redirect: false`), whose response deletes the session
 *    cookie.
 * 5. {@link forgetUserData} again, now that the cookie is gone. Requests that still carried
 *    the old session in the meantime (a refresh that started before 1, another tab, a fetch
 *    outside SWR) were either stored already, and are deleted now, or are still in flight
 *    under the cache generation that this `CLEAR_API_CACHE` retires, so the worker drops them
 *    when they land (`public/sw.js`). Every request the worker handles from here on is
 *    anonymous. This step runs even when 4 fails: whether the cookie survived is unknown.
 * 6. A full page load of `callbackUrl` (not a client-side transition) discards everything
 *    still held in memory: SWR's cache, React state, the paused flag. Should the browser
 *    later restore this page from its back/forward cache, it is reloaded instead of showing
 *    the previous account's data (with SWR still paused).
 *
 * Clearing only *before* the sign-out request (the previous order) left a window of seconds
 * in which a refresh, still authenticated, was cached under the new generation. Making the
 * worker refuse to cache until the next navigation was considered instead, but the worker
 * keeps that state in memory, which the browser discards whenever the idle worker is
 * stopped, and it would also stop caching after an account switch without a page load
 * (`components/SessionDataGuard.tsx`); clearing after the cookie is gone needs neither.
 *
 * Rejects (with the data already forgotten and SWR running again) when the sign-out request
 * fails, so the caller can tell the user.
 */
export async function signOutAndForget(callbackUrl = "/"): Promise<void> {
  signingOut = true;
  let signedOut = false;
  try {
    await forgetUserData();
    await unlinkCurrentSubscription();
    await signOut({ callbackUrl, redirect: false });
    signedOut = true;
  } finally {
    // forgetUserData never rejects, so the sign-out error (if any) is what propagates.
    await forgetUserData();
    // Failed: still signed in as far as we know, so the app may refresh again.
    if (!signedOut) signingOut = false;
  }
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) window.location.reload();
  });
  const destination = signedOutDestination(callbackUrl);
  window.location.assign(destination);
  // Same as NextAuth's own redirect: a "#..." target would only change the fragment.
  if (destination.includes("#")) window.location.reload();
}
