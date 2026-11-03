"use client";

import { useSession } from "next-auth/react";
import * as React from "react";

import { identityTag } from "@/lib/identity";
import { forgetUserData } from "@/lib/sign-out";

/** localStorage: {@link identityTag} of the account whose data this device last held. */
export const DATA_OWNER_STORAGE_KEY = "resq_data_owner";

/**
 * Forgets the previous account's cached data (`forgetUserData`: the service worker's API
 * cache, chat transcript, last location, ...) when a *different* account signs in on this
 * device without signing out first — an expired session followed by someone else's sign-in,
 * or a sign-in from another tab.
 *
 * Only a positive change of identity counts. "Signed out" is also what NextAuth reports when
 * the session request fails (offline), and the saved offline data must survive that.
 * Mounted once, in `components/Providers.tsx`.
 */
export function SessionDataGuard(): null {
  const { data, status } = useSession();
  const userId = data?.user?.id ?? null;

  React.useEffect(() => {
    if (status !== "authenticated" || !userId) return;
    const tag = identityTag(userId);
    let previous: string | null;
    try {
      previous = window.localStorage.getItem(DATA_OWNER_STORAGE_KEY);
      if (previous === tag) return;
      window.localStorage.setItem(DATA_OWNER_STORAGE_KEY, tag);
    } catch {
      return; // storage blocked: nothing per-user was stored either
    }
    if (previous) void forgetUserData();
  }, [status, userId]);

  return null;
}
