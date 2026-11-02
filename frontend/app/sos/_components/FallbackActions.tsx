"use client";

import { Check, Copy, MessageSquareText, Phone, Share2 } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface FallbackActionsProps {
  /** `sms:` URI with recipients and body pre-filled. */
  smsUri: string;
  /** Make "Open SMS app" the primary, full-width action (Twilio not configured / failed / offline). */
  emphasizeSms?: boolean;
  /** Text shared or copied by "Share location" (includes the maps link). */
  shareText: string;
  /** Emergency number for the call button. */
  emergencyNumber?: string;
  className?: string;
}

type ShareNotice = { kind: "ok" | "error"; text: string } | null;

/**
 * Ways to get help that don't depend on the ResQ AI server: open the phone's SMS app with
 * the SOS text pre-filled, share the location via any app (Web Share API, falling back to
 * the clipboard, then to a selectable text box) and call the emergency number.
 */
export function FallbackActions({
  smsUri,
  emphasizeSms = false,
  shareText,
  emergencyNumber = "112",
  className,
}: FallbackActionsProps) {
  const [notice, setNotice] = React.useState<ShareNotice>(null);
  const [manualCopy, setManualCopy] = React.useState(false);

  const copy = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(shareText);
      setNotice({ kind: "ok", text: "Copied — paste it into any messaging app." });
      return true;
    } catch {
      setManualCopy(true);
      setNotice({ kind: "error", text: "Couldn't copy automatically. Select the text below and copy it." });
      return false;
    }
  };

  const share = async () => {
    setNotice(null);
    const data: ShareData = { title: "SOS — my location", text: shareText };
    const canShare =
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      (typeof navigator.canShare !== "function" || navigator.canShare(data));
    if (canShare) {
      try {
        await navigator.share(data);
        setNotice({ kind: "ok", text: "Shared." });
        return;
      } catch (error) {
        // The user closed the share sheet: nothing to report.
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copy();
  };

  const secondary =
    "inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none";

  return (
    <div data-slot="sos-fallback-actions" className={cn("space-y-3", className)}>
      <a
        href={smsUri}
        className={cn(
          "flex min-h-14 w-full items-center justify-center gap-3 rounded-2xl px-5 py-4 text-lg font-bold transition-colors focus-visible:ring-4 focus-visible:outline-none",
          emphasizeSms
            ? "bg-red-600 text-white shadow-lg shadow-red-900/40 hover:bg-red-500 focus-visible:ring-white"
            : "border border-slate-600 bg-slate-900/50 text-slate-100 hover:bg-slate-800 focus-visible:ring-slate-300",
        )}
      >
        <MessageSquareText aria-hidden="true" className="size-6" />
        Open SMS app
      </a>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => void share()}
          className={cn(secondary, "border-blue-500/40 bg-blue-600/15 text-blue-100 hover:bg-blue-600/25 focus-visible:ring-blue-300")}
        >
          <Share2 aria-hidden="true" className="size-4" />
          Share location
        </button>
        <a
          href={`tel:${emergencyNumber}`}
          className={cn(secondary, "border-emerald-500/40 bg-emerald-600/15 text-emerald-100 hover:bg-emerald-600/25 focus-visible:ring-emerald-300")}
        >
          <Phone aria-hidden="true" className="size-4" />
          Call {emergencyNumber}
        </a>
      </div>
      {notice && (
        <p
          role="status"
          className={cn(
            "flex items-center gap-2 text-sm",
            notice.kind === "ok" ? "text-emerald-200" : "text-amber-200",
          )}
        >
          {notice.kind === "ok" ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
          {notice.text}
        </p>
      )}
      {manualCopy && (
        <textarea
          readOnly
          value={shareText}
          aria-label="SOS message to copy"
          onFocus={(event) => event.currentTarget.select()}
          rows={3}
          className="w-full rounded-xl border border-slate-700 bg-slate-900/60 p-3 font-mono text-xs text-slate-200"
        />
      )}
    </div>
  );
}

export default FallbackActions;
