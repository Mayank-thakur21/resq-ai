"use client";

import { House } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { ErrorState } from "@/components/ErrorState";

/** Error UI for `/profile`; `reset()` re-renders the segment. */
export default function ProfileError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[profile] page crashed", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl items-center px-4 py-12">
      <ErrorState
        className="w-full"
        title="Your profile couldn't be displayed"
        message="Something went wrong while loading your profile. Try again, or come back later."
        onRetry={reset}
        details={error.digest ? `Error reference: ${error.digest}` : null}
      >
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none"
        >
          <House aria-hidden="true" className="size-4" />
          Go home
        </Link>
      </ErrorState>
    </div>
  );
}
