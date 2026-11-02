import { Siren } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import AlertsView from "@/app/alerts/AlertsView";
import { AlertsBodySkeleton } from "@/app/alerts/_components/AlertsSkeleton";

export const metadata: Metadata = {
  title: "Alerts",
  description:
    "Live disaster alerts from GDACS (earthquakes, cyclones, floods, volcanoes, droughts, wildfires) and humanitarian news from ReliefWeb, with push notifications for events near you.",
};

/**
 * `/alerts` — statically rendered shell (header) with the interactive tabs below.
 * `AlertsView` reads `?tab=` via `useSearchParams`, which requires a Suspense boundary for
 * static rendering; its fallback is the same skeleton as `loading.tsx`.
 */
export default function AlertsPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black pb-12 text-white">
      <div className="container mx-auto max-w-6xl px-4 pt-8 lg:pt-12">
        <header className="mb-8">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-flex size-11 items-center justify-center rounded-xl border border-red-500/30 bg-red-600/20 text-red-300"
            >
              <Siren className="size-6" />
            </span>
            <h1 className="bg-gradient-to-r from-red-300 via-orange-200 to-amber-200 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent md:text-4xl">
              Disaster Alerts
            </h1>
          </div>
          <p className="mt-3 max-w-2xl text-slate-300">
            Live disaster events from GDACS and humanitarian news from ReliefWeb — real data, refreshed every few
            minutes. Filter by type, alert level or distance, and get notified about events near you.
          </p>
        </header>
        <Suspense fallback={<AlertsBodySkeleton />}>
          <AlertsView />
        </Suspense>
      </div>
    </div>
  );
}
