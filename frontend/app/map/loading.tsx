import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton matching the map page: header bar, full-height map, floating layer panel. */
export default function MapLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-[calc(100dvh-7.5rem-1px-env(safe-area-inset-bottom)-var(--offline-banner-h))] flex-col bg-slate-950 lg:h-[calc(100dvh-4rem-1px-var(--offline-banner-h))]"
    >
      <span className="sr-only">Loading the relief map…</span>
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-slate-900 px-4 py-3 lg:px-6">
        <div className="space-y-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-9 w-36 rounded-lg" />
      </div>
      <div className="relative flex-1 bg-slate-900">
        <Skeleton className="absolute inset-0 rounded-none bg-slate-800/50" />
        <div className="absolute top-4 left-4 hidden w-72 space-y-3 rounded-2xl border border-slate-700/80 bg-slate-900/90 p-4 lg:block">
          <Skeleton className="h-4 w-28" />
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-7 rounded-full" />
            </div>
          ))}
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
