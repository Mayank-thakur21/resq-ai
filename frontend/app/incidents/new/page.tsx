import { ArrowLeft, Siren } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { IncidentForm } from "@/components/IncidentForm";
import { parseLatLonParams } from "@/components/map/layers";

export const metadata: Metadata = {
  title: "Report an incident",
  description: "Report a flood, fire, accident or other emergency so people nearby can stay safe.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/incidents/new` (signed-in users only — enforced by `middleware.ts`).
 * `?lat=..&lon=..` (from the map's "Report incident here") pre-fills the location.
 */
export default async function NewIncidentPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const initialLocation = parseLatLonParams(params.lat, params.lon);

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] lg:min-h-[calc(100dvh-4rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black text-white">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 lg:py-12">
        <Link
          href="/incidents"
          className="mb-6 inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold text-slate-300 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All incidents
        </Link>
        <div className="mb-8 flex items-start gap-4">
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-red-700 p-3 shadow-lg shadow-red-900/40"
          >
            <Siren className="size-7 text-white" />
          </span>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white">Report an incident</h1>
            <p className="mt-2 text-slate-300">
              Share what is happening so people nearby can avoid danger. Subscribers in the area are
              notified when you submit.
            </p>
          </div>
        </div>
        <div className="rounded-3xl border border-slate-700/80 bg-slate-900/60 p-5 shadow-2xl shadow-black/40 backdrop-blur-md sm:p-8">
          <IncidentForm initialLocation={initialLocation} />
        </div>
      </div>
    </div>
  );
}
