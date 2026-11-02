"use client";

import { motion } from "framer-motion";
import { Check, Copy, MessageCircle, Share2, ShieldCheck, Siren, TriangleAlert } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { mapsLink, type GeolocationState } from "@/lib/geo";
import { cn } from "@/lib/utils";

type MessageKind = "safe" | "help";

/** The status message shared from the contacts page (with the last known location). */
export function buildStatusMessage(kind: MessageKind, location: { lat: number; lon: number } | null): string {
  const base = kind === "safe" ? "I am safe and currently out of danger." : "EMERGENCY: I need help immediately!";
  const where = location ? ` My last known location is: ${mapsLink(location.lat, location.lon)}` : "";
  return `${base}${where} (Sent via ResQ AI)`;
}

interface Feedback {
  kind: MessageKind;
  ok: boolean;
  text: string;
}

const iconButton =
  "inline-flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors focus-visible:ring-2 focus-visible:outline-none";

/**
 * "I'm safe" / "I need help" share cards. The help card's primary action opens the real SOS
 * flow (`/sos`, which texts contacts automatically); sharing, WhatsApp and copy stay
 * available for any messaging app.
 */
export function ShareStatusCards({ geo }: { geo: GeolocationState }) {
  const [feedback, setFeedback] = React.useState<Feedback | null>(null);
  const location = geo.coords ? { lat: geo.coords.lat, lon: geo.coords.lon } : null;

  React.useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 4000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const copy = async (kind: MessageKind) => {
    try {
      await navigator.clipboard.writeText(buildStatusMessage(kind, location));
      setFeedback({ kind, ok: true, text: "Message copied — paste it into any app." });
    } catch {
      setFeedback({ kind, ok: false, text: "Couldn't copy automatically. Use Share or WhatsApp instead." });
    }
  };

  const share = async (kind: MessageKind) => {
    const text = buildStatusMessage(kind, location);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: kind === "safe" ? "I'm safe" : "I need help", text });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copy(kind);
  };

  const whatsappHref = (kind: MessageKind) =>
    `https://wa.me/?text=${encodeURIComponent(buildStatusMessage(kind, location))}`;

  const locationNote = location
    ? "Your current location is included."
    : geo.status === "idle" || geo.status === "locating"
      ? "Finding your location to include it…"
      : "Location unavailable — the message is sent without it.";

  const renderFeedback = (kind: MessageKind) =>
    feedback?.kind === kind ? (
      <p
        role="status"
        className={cn("mt-3 flex items-center gap-1.5 text-sm", feedback.ok ? "text-emerald-300" : "text-amber-300")}
      >
        {feedback.ok && <Check aria-hidden="true" className="size-4" />}
        {feedback.text}
      </p>
    ) : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <motion.div
          whileHover={{ scale: 1.01 }}
          className="rounded-3xl border-2 border-green-500/30 bg-slate-950/60 p-6 shadow-sm transition-colors hover:border-green-500/70"
        >
          <div className="mb-4 flex items-center gap-3">
            <span aria-hidden="true" className="rounded-full bg-green-900/50 p-3">
              <ShieldCheck className="size-6 text-green-400" />
            </span>
            <h2 className="text-xl font-bold text-slate-100">I&apos;m Safe</h2>
          </div>
          <p className="mb-6 text-sm text-slate-400">Let your family know you are secure and out of harm&apos;s way.</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void share("safe")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-green-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-green-500 focus-visible:ring-2 focus-visible:ring-green-300 focus-visible:outline-none"
            >
              <Share2 aria-hidden="true" className="size-4" />
              Share
            </button>
            <a
              href={whatsappHref("safe")}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Send “I'm safe” on WhatsApp"
              className={cn(iconButton, "border-green-500/40 text-green-300 hover:bg-green-500/10 focus-visible:ring-green-300")}
            >
              <MessageCircle aria-hidden="true" className="size-4" />
            </a>
            <button
              type="button"
              onClick={() => void copy("safe")}
              aria-label="Copy “I'm safe” message"
              className={cn(iconButton, "border-slate-600 text-slate-200 hover:bg-slate-800 focus-visible:ring-slate-300")}
            >
              <Copy aria-hidden="true" className="size-4" />
            </button>
          </div>
          {renderFeedback("safe")}
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.01 }}
          className="rounded-3xl border-2 border-red-500/30 bg-slate-950/60 p-6 shadow-sm transition-colors hover:border-red-500/70"
        >
          <div className="mb-4 flex items-center gap-3">
            <span aria-hidden="true" className="rounded-full bg-red-900/50 p-3">
              <TriangleAlert className="size-6 text-red-400" />
            </span>
            <h2 className="text-xl font-bold text-slate-100">I Need Help</h2>
          </div>
          <p className="mb-6 text-sm text-slate-400">
            Send an SOS that texts your live location to your trusted contacts — or share it yourself.
          </p>
          <div className="flex gap-2">
            <Link
              href="/sos"
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-bold text-white shadow-lg shadow-red-900/40 transition-colors hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none"
            >
              <Siren aria-hidden="true" className="size-4" />
              Open SOS
            </Link>
            <button
              type="button"
              onClick={() => void share("help")}
              aria-label="Share “I need help” message"
              className={cn(iconButton, "border-red-500/40 text-red-200 hover:bg-red-500/10 focus-visible:ring-red-300")}
            >
              <Share2 aria-hidden="true" className="size-4" />
            </button>
            <a
              href={whatsappHref("help")}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Send “I need help” on WhatsApp"
              className={cn(iconButton, "border-red-500/40 text-red-200 hover:bg-red-500/10 focus-visible:ring-red-300")}
            >
              <MessageCircle aria-hidden="true" className="size-4" />
            </a>
            <button
              type="button"
              onClick={() => void copy("help")}
              aria-label="Copy “I need help” message"
              className={cn(iconButton, "border-slate-600 text-slate-200 hover:bg-slate-800 focus-visible:ring-slate-300")}
            >
              <Copy aria-hidden="true" className="size-4" />
            </button>
          </div>
          {renderFeedback("help")}
        </motion.div>
      </div>
      <p className="text-center text-xs text-slate-500">{locationNote}</p>
    </div>
  );
}

export default ShareStatusCards;
