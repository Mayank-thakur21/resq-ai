import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton matching the incidents list: title, actions, filter card, two-column cards. */
export default function IncidentsLoading() {
  return (
    <div role="status" aria-live="polite" className="min-h-[calc(100dvh-3.5rem)] lg:min-h-[calc(100dvh-4rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black">
      <span className="sr-only">Loading incidents…</span>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:py-12">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-3">
            <Skeleton className="h-10 w-72" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-10 w-28 rounded-xl" />
            <Skeleton className="h-10 w-36 rounded-xl" />
          </div>
        </div>
        <div className="mb-6 grid grid-cols-2 gap-3 rounded-2xl border border-slate-700/80 bg-slate-900/60 p-4 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="space-y-3 rounded-2xl border border-slate-700/80 bg-slate-900/60 p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-20 rounded-full" />
                </div>
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <div className="flex justify-between pt-2">
                <Skeleton className="h-8 w-28 rounded-lg" />
                <Skeleton className="h-8 w-20 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
