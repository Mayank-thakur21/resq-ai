"use client";

import { CircleAlert, CircleCheck, Copy, ExternalLink, MapPin, Send, TriangleAlert } from "lucide-react";
import * as React from "react";

import { FallbackActions } from "@/app/sos/_components/FallbackActions";
import { needsSmsFallback, type RecipientOutcome, safeSmsUri } from "@/app/sos/sos-helpers";
import { Badge } from "@/components/ui/badge";
import { formatTime, humanize, pluralize, safeHttpUrl } from "@/lib/format";
import type { SOSResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface SOSResultPanelProps {
  response: SOSResponse;
  outcomes: readonly RecipientOutcome[];
  /** Number of contacts the SOS was addressed to. */
  recipientCount: number;
  /** Text for "Share location" (the SOS message with the maps link). */
  shareText: string;
  /** Locally built `sms:` URI used if the server's `fallback_sms_uri` is unusable. */
  localSmsUri: string;
  onDone: () => void;
}

type Tone = "success" | "warning" | "error";

function summarise(response: SOSResponse, recipientCount: number): { tone: Tone; title: string; body: string } {
  const { configured, sent, failed } = response.sms;
  if (!configured) {
    return {
      tone: "warning",
      title: "SOS saved — now send it from your phone",
      body:
        recipientCount > 0
          ? "Automatic texting isn't set up on this server. Tap “Open SMS app” to send the prepared message to your contacts."
          : "Your location was recorded. Tap “Open SMS app” or “Share location” to send it to someone.",
    };
  }
  if (recipientCount === 0) {
    return {
      tone: "warning",
      title: "SOS recorded",
      body: "No contacts were selected, so no texts were sent. Share your location or open your SMS app below.",
    };
  }
  if (failed.length === 0) {
    return {
      tone: "success",
      title: `SOS sent to ${pluralize(sent.length, "contact")}`,
      body: "They received your message and a map link to your location. Stay where you are if it is safe.",
    };
  }
  if (sent.length === 0) {
    return {
      tone: "error",
      title: "Texts couldn't be delivered",
      body: "Tap “Open SMS app” to send the message from your phone instead.",
    };
  }
  return {
    tone: "warning",
    title: `Sent to ${sent.length} of ${sent.length + failed.length} contacts`,
    body: "Some texts failed. Tap “Open SMS app” to send the message to the remaining contacts.",
  };
}

const toneStyles: Record<Tone, { box: string; icon: React.ReactNode }> = {
  success: {
    box: "border-emerald-500/40 bg-emerald-500/10",
    icon: <CircleCheck className="size-7 text-emerald-300" />,
  },
  warning: {
    box: "border-amber-500/40 bg-amber-500/10",
    icon: <TriangleAlert className="size-7 text-amber-300" />,
  },
  error: { box: "border-red-500/50 bg-red-500/10", icon: <CircleAlert className="size-7 text-red-300" /> },
};

/** Outcome of a successful `POST /sos`: delivery summary, per-number results, map link, fallbacks. */
export function SOSResultPanel({
  response,
  outcomes,
  recipientCount,
  shareText,
  localSmsUri,
  onDone,
}: SOSResultPanelProps) {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = React.useState(false);
  const summary = summarise(response, recipientCount);
  const style = toneStyles[summary.tone];
  const mapUrl = safeHttpUrl(response.maps_link);

  // Move focus to the result so screen-reader and keyboard users hear what happened.
  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(response.maps_link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-labelledby="sos-result-title" className="space-y-5">
      <div className={cn("flex gap-4 rounded-2xl border p-5", style.box)}>
        <span aria-hidden="true" className="shrink-0">
          {style.icon}
        </span>
        <div className="min-w-0 space-y-1">
          <h2
            id="sos-result-title"
            ref={headingRef}
            tabIndex={-1}
            className="text-xl font-bold text-white focus:outline-none"
          >
            {summary.title}
          </h2>
          <p className="text-sm text-slate-200">{summary.body}</p>
          <p className="text-xs text-slate-400">
            <time dateTime={response.timestamp}>{formatTime(response.timestamp)}</time> · “{response.message}”
          </p>
        </div>
      </div>

      {outcomes.length > 0 && (
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Send aria-hidden="true" className="size-4 text-slate-400" />
            Delivery
          </h3>
          <ul className="divide-y divide-slate-700/70">
            {outcomes.map((outcome, index) => (
              <li key={`${outcome.to}-${index}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-100">{outcome.name ?? outcome.to}</span>
                  {outcome.name && <span className="block font-mono text-xs text-slate-400">{outcome.to}</span>}
                  {outcome.status === "failed" && (
                    <span className="block text-xs text-red-200">{outcome.detail}</span>
                  )}
                </span>
                <Badge variant={outcome.status === "sent" ? "success" : "destructive"}>
                  {outcome.status === "sent" ? humanize(outcome.detail) || "Sent" : "Failed"}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {mapUrl && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm">
          <MapPin aria-hidden="true" className="size-4 shrink-0 text-red-300" />
          <a
            href={mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-cyan-300 hover:text-cyan-200 hover:underline focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none"
          >
            <span className="truncate">{response.maps_link}</span>
            <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
          </a>
          <button
            type="button"
            onClick={() => void copyLink()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700/60 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
          >
            <Copy aria-hidden="true" className="size-3.5" />
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      <FallbackActions
        smsUri={safeSmsUri(response.fallback_sms_uri, localSmsUri)}
        emphasizeSms={needsSmsFallback(response)}
        shareText={shareText}
      />

      <button
        type="button"
        onClick={onDone}
        className="w-full rounded-xl border border-slate-600 px-4 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
      >
        Done — back to SOS
      </button>
    </section>
  );
}

export default SOSResultPanel;
