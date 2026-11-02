"use client";

import { BellRing } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage, isApiError, sendTestPush } from "@/lib/api";
import { pluralize } from "@/lib/format";

type TestState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; sent: number }
  | { kind: "error"; message: string };

function describeError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "not_configured") return "Push notifications aren't set up on this server yet.";
    if (error.status === 401) return "Your session has expired. Sign in again to send a test notification.";
  }
  return getErrorMessage(error, "Couldn't send a test notification.");
}

/** "Send test notification" — asks the backend to push to this user's subscribed devices. */
export function TestNotificationCard() {
  const [state, setState] = React.useState<TestState>({ kind: "idle" });

  const send = async () => {
    setState({ kind: "sending" });
    try {
      const { sent } = await sendTestPush();
      setState({ kind: "done", sent });
    } catch (error) {
      console.warn("[profile] test notification failed", error);
      setState({ kind: "error", message: describeError(error) });
    }
  };

  return (
    <section
      aria-labelledby="test-push-title"
      className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 backdrop-blur-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-300"
          >
            <BellRing className="size-5" />
          </span>
          <div>
            <h2 id="test-push-title" className="text-base font-semibold text-white">
              Test notification
            </h2>
            <p className="mt-0.5 text-sm text-slate-400">Check that alerts reach your devices.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void send()}
          disabled={state.kind === "sending"}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none disabled:opacity-70"
        >
          {state.kind === "sending" ? <Spinner size="sm" label="Sending" className="text-white" /> : null}
          Send test notification
        </button>
      </div>
      {state.kind === "done" && (
        <Alert variant={state.sent > 0 ? "success" : "info"} className="mt-4">
          <AlertDescription>
            {state.sent > 0
              ? `Sent to ${pluralize(state.sent, "device")}. It should arrive within a few seconds.`
              : "No devices are subscribed yet. Turn on alert notifications above, then try again."}
          </AlertDescription>
        </Alert>
      )}
      {state.kind === "error" && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

export default TestNotificationCard;
