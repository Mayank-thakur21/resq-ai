import { Phone, Siren } from "lucide-react";
import type { Metadata } from "next";

import SOSView from "@/app/sos/SOSView";

export const metadata: Metadata = {
  title: "SOS",
  description:
    "Send an emergency SOS with your live location to your trusted contacts by SMS, or call emergency services.",
};

/**
 * `/sos` — static shell (header + emergency call link) around the interactive SOS view.
 * The shell renders even before JavaScript loads, so "Call 112" always works.
 */
export default function SOSPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-red-950/40 to-black pb-12 text-white">
      <div className="container mx-auto max-w-5xl px-4 pt-6 lg:pt-10">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="inline-flex size-11 items-center justify-center rounded-xl border border-red-500/40 bg-red-600/25 text-red-200"
              >
                <Siren className="size-6" />
              </span>
              <h1 className="bg-gradient-to-r from-red-300 via-orange-200 to-amber-200 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent md:text-4xl">
                Emergency SOS
              </h1>
            </div>
            <p className="mt-3 max-w-2xl text-slate-300">
              Hold the button to text your live location to your trusted contacts. If you are in immediate danger,
              call emergency services first.
            </p>
          </div>
          <a
            href="tel:112"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-600/15 px-4 py-2.5 text-sm font-bold text-emerald-100 transition-colors hover:bg-emerald-600/25 focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:outline-none"
          >
            <Phone aria-hidden="true" className="size-4" />
            Call 112
          </a>
        </header>
        <SOSView />
      </div>
    </div>
  );
}
