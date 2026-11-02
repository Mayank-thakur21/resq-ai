import { Skeleton } from "@/components/ui/skeleton";

/** Route-level skeleton for `/checklist` (matches the page layout). */
export default function ChecklistLoading() {
  return (
    <div className="min-h-[calc(100dvh-7.5rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black p-4 md:p-8">
      <div role="status" className="mx-auto w-full max-w-4xl space-y-8">
        <span className="sr-only">Loading checklists…</span>
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="size-18 rounded-full" />
          <Skeleton className="h-12 w-72" />
          <Skeleton className="h-5 w-full max-w-xl" />
        </div>
        <div className="space-y-4 rounded-3xl border border-slate-800 p-6">
          <div className="flex flex-col gap-4 md:flex-row">
            <Skeleton className="h-14 flex-1 rounded-2xl" />
            <Skeleton className="h-14 rounded-2xl md:w-48" />
            <Skeleton className="h-14 rounded-2xl md:w-40" />
          </div>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-24 rounded-full" />
            ))}
          </div>
        </div>
        <Skeleton className="h-40 rounded-3xl" />
      </div>
    </div>
  );
}
