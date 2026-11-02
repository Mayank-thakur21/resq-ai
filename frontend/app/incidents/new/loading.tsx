import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton matching the report form: heading, then the form card. */
export default function NewIncidentLoading() {
  return (
    <div role="status" aria-live="polite" className="min-h-[calc(100dvh-3.5rem)] lg:min-h-[calc(100dvh-4rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black">
      <span className="sr-only">Loading the report form…</span>
      <div className="mx-auto w-full max-w-3xl px-4 py-8 lg:py-12">
        <Skeleton className="mb-6 h-4 w-28" />
        <div className="mb-8 flex items-start gap-4">
          <Skeleton className="size-14 rounded-2xl" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
        <div className="space-y-6 rounded-3xl border border-slate-700/80 bg-slate-900/60 p-5 sm:p-8">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-16 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
          <div className="flex justify-end">
            <Skeleton className="h-11 w-40 rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
