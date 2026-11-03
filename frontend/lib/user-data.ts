/**
 * The sign-out flag, and the guard that every writer of per-user browser storage goes through.
 *
 * `signOutAndForget` (`lib/sign-out.ts`) clears this tab's per-user storage (chat transcript,
 * incident draft, last known location, SOS sender name, push re-sync marker) before and after
 * the session cookie is deleted, then loads the signed-out page. The old page keeps running
 * until the next document has loaded, though (seconds on a slow network): a chat answer that
 * arrives, a new fix from a position watch (`/sos`) or a keystroke in a draft would write the
 * previous user's data back after the last clear, and the signed-out page, which shares this
 * tab's sessionStorage and the device's localStorage, would show it to the next person.
 *
 * So these writes are skipped while a sign-out is under way: {@link isSigningOut} turns true
 * when it starts and stays true after it succeeds, until the full page load discards this
 * module's state. It goes back to false only when the sign-out request fails (the user is
 * then still signed in). Removing an entry is always allowed.
 *
 * Kept free of imports, so writers anywhere can use it without pulling in next-auth and
 * without an import cycle with `lib/sign-out.ts`, which imports their storage keys.
 */

let signingOut = false;

/** Whether a sign-out is under way in this page (see the module comment). */
export function isSigningOut(): boolean {
  return signingOut;
}

/** Set by `signOutAndForget` only (and by tests, to start from a signed-in page). */
export function setSigningOut(active: boolean): void {
  signingOut = active;
}

/**
 * Stores (or, with `null`, removes) a per-user entry of this tab's storage. Skips the write
 * while a sign-out is under way; never throws (blocked storage, quota: per-user data is a
 * convenience, the app works without it).
 */
export function writeUserData(area: "local" | "session", key: string, value: string | null): void {
  if (value !== null && signingOut) return;
  try {
    const storage = area === "local" ? window.localStorage : window.sessionStorage;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Storage unavailable: nothing is remembered.
  }
}
