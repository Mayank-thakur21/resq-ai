import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton matching the incident detail page: back link, report card and map column. */
export default function IncidentLoading() {
  return (
    <div role="status" aria-live="polite" className="min-h-[calc(100dvh-3.5rem)] lg:min-h-[calc(100dvh-4rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black">
      <span className="sr-only">Loading incident…</span>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:py-12">
        <Skeleton className="mb-6 h-4 w-28" />
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-4 rounded-3xl border border-slate-700/80 bg-slate-900/60 p-6 lg:col-span-3">
            <div className="flex items-center gap-4">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-8 w-56" />
                <Skeleton className="h-5 w-40 rounded-full" />
              </div>
            </div>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <div className="flex gap-3 pt-4">
              <Skeleton className="h-9 w-32 rounded-lg" />
              <Skeleton className="h-9 w-24 rounded-lg" />
            </div>
          </div>
          <div className="space-y-4 lg:col-span-2">
            <Skeleton className="h-96 rounded-3xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
