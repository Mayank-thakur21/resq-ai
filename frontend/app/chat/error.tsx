"use client";

import { Phone, Siren } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { ErrorState } from "@/components/ErrorState";

/** Error UI for `/chat`; the emergency call and SOS stay one tap away. */
export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[chat] page crashed", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl items-center px-4 py-12">
      <ErrorState
        className="w-full"
        title="The assistant ran into a problem"
        message="Something went wrong while showing the chat. Try again — and if you are in danger, call 112 or send an SOS now."
        onRetry={reset}
        details={error.digest ? `Error reference: ${error.digest}` : null}
      >
        <a
          href="tel:112"
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:ring-3 focus-visible:ring-emerald-300/60 focus-visible:outline-none"
        >
          <Phone aria-hidden="true" className="size-4" />
          Call 112
        </a>
        <Link
          href="/sos"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none"
        >
          <Siren aria-hidden="true" className="size-4" />
          Open SOS
        </Link>
      </ErrorState>
    </div>
  );
}
