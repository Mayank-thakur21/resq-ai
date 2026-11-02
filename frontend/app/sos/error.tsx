"use client";

import { MessageSquareText, Phone } from "lucide-react";
import { useEffect } from "react";

import { ErrorState } from "@/components/ErrorState";

/**
 * Error UI for `/sos`. Even when the SOS page crashes, the user must still be able to call
 * for help, so the emergency call and the SMS app are offered right here.
 */
export default function SOSError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[sos] page crashed", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl items-center px-4 py-12">
      <ErrorState
        className="w-full"
        title="The SOS page ran into a problem"
        message="You can still get help right now: call 112 or text someone from your phone."
        onRetry={reset}
        details={error.digest ? `Error reference: ${error.digest}` : null}
      >
        <a
          href="tel:112"
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 focus-visible:ring-3 focus-visible:ring-emerald-300/60 focus-visible:outline-none"
        >
          <Phone aria-hidden="true" className="size-4" />
          Call 112
        </a>
        <a
          href={`sms:?&body=${encodeURIComponent("SOS! I need help!")}`}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none"
        >
          <MessageSquareText aria-hidden="true" className="size-4" />
          Open SMS app
        </a>
      </ErrorState>
    </div>
  );
}
