import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton of the alerts page body (tabs, filters, event cards and the side column). */
export function AlertsBodySkeleton() {
  return (
    <div role="status" aria-live="polite" className="grid gap-6 lg:grid-cols-12">
      <span className="sr-only">Loading alerts…</span>
      <div className="space-y-4 lg:col-span-8">
        <Skeleton className="h-11 w-56 rounded-xl" />
        <div className="space-y-4 rounded-2xl border border-slate-700 bg-slate-800/40 p-4">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton key={index} className="h-7 w-24 rounded-full" />
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="space-y-3 rounded-2xl border border-slate-700 bg-slate-800/40 p-5">
            <div className="flex items-start gap-3">
              <Skeleton className="size-10 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
      <div className="space-y-4 lg:col-span-4">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    </div>
  );
}

/** Skeleton of the page header (title + subtitle). */
export function AlertsHeaderSkeleton() {
  return (
    <div className="mb-8 space-y-3" aria-hidden="true">
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-xl" />
        <Skeleton className="h-9 w-64" />
      </div>
      <Skeleton className="h-5 w-full max-w-xl" />
    </div>
  );
}
