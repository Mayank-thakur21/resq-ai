"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/ErrorState";

/**
 * Error UI for `/offline`. Kept dependency-free beyond ErrorState and always lists the
 * emergency numbers as plain `tel:` links, since this page is the last resort offline.
 */
export default function OfflineError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[offline] page crashed", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl items-center px-4 py-12">
      <ErrorState
        className="w-full"
        offline
        title="Offline help couldn't be displayed"
        message="Emergency numbers still work without internet: tap one below to call."
        onRetry={reset}
        details={error.digest ? `Error reference: ${error.digest}` : null}
      >
        {["112", "108", "100", "101", "911", "999"].map((number) => (
          <a
            key={number}
            href={`tel:${number}`}
            className="rounded-lg border border-red-500/40 px-3 py-2 text-sm font-bold text-red-100 hover:bg-red-500/20 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none"
          >
            {number}
          </a>
        ))}
      </ErrorState>
    </div>
  );
}
