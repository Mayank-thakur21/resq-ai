import { Skeleton } from "@/components/ui/skeleton";

/** Route-level skeleton for `/sos`; keeps "Call 112" usable while the page loads. */
export default function SOSLoading() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-red-950/40 to-black pb-12">
      <div className="container mx-auto max-w-5xl px-4 pt-6 lg:pt-10">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-3">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-5 w-full max-w-xl" />
          </div>
          <a
            href="tel:112"
            className="inline-flex items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-600/15 px-4 py-2.5 text-sm font-bold text-emerald-100"
          >
            Call 112
          </a>
        </div>
        <div role="status" className="grid gap-6 lg:grid-cols-2">
          <span className="sr-only">Loading SOS…</span>
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-4 rounded-3xl border border-red-500/20 bg-red-950/10 p-6">
              <Skeleton className="size-56 rounded-full sm:size-64" />
              <Skeleton className="h-4 w-60" />
            </div>
            <Skeleton className="h-24 rounded-2xl" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-44 rounded-2xl" />
            <Skeleton className="h-64 rounded-2xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
