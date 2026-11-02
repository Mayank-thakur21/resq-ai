"use client";

import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import * as React from "react";
import { SWRConfig, type SWRConfiguration } from "swr";

import { compareApiData, fetcher, isApiError } from "@/lib/api";

/**
 * Retry policy: never retry client errors (4xx — retrying cannot fix a bad request, missing
 * auth or a 404) except 408/429; retry network failures and 5xx with SWR's exponential
 * backoff.
 */
export function shouldRetryOnError(error: unknown): boolean {
  if (isApiError(error)) {
    if (error.code === "aborted") return false;
    if (error.status === 408 || error.status === 429) return true;
    if (error.status >= 400 && error.status < 500) return false;
  }
  return true;
}

export const swrConfig: SWRConfiguration = {
  fetcher,
  // Collapse identical requests fired within 10 s (e.g. several widgets needing the weather).
  dedupingInterval: 10_000,
  // Emergency data should refresh when the user comes back to the tab, but not more than
  // once every 30 s.
  revalidateOnFocus: true,
  focusThrottleInterval: 30_000,
  revalidateOnReconnect: true,
  shouldRetryOnError,
  errorRetryCount: 3,
  errorRetryInterval: 5_000,
  // Keep showing the last data while a new key (e.g. new radius) loads.
  keepPreviousData: true,
  // A saved (offline) copy must be replaced by live data even when the content is identical,
  // so the "Showing saved data" notice disappears once the connection is back.
  compare: compareApiData,
};

export interface ProvidersProps {
  children: React.ReactNode;
  /** Optional session pre-fetched on the server (avoids a client round-trip). */
  session?: Session | null;
}

/** App-wide client providers: NextAuth session context + SWR defaults. */
export default function Providers({ children, session }: ProvidersProps) {
  return (
    <SessionProvider session={session} refetchOnWindowFocus refetchInterval={5 * 60}>
      <SWRConfig value={swrConfig}>{children}</SWRConfig>
    </SessionProvider>
  );
}
