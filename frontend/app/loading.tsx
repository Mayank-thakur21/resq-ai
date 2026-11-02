import { Skeleton } from "@/components/ui/skeleton";

/** Generic page skeleton shown while a route segment without its own `loading.tsx` loads. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="mx-auto w-full max-w-6xl px-4 py-10">
      <span className="sr-only">Loading…</span>
      <div className="mx-auto mb-10 flex max-w-2xl flex-col items-center gap-4">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-4/5" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-8">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-40 rounded-2xl" />
          ))}
        </div>
        <div className="flex flex-col gap-4 lg:col-span-4">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-52 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
