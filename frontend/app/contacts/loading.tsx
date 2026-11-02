import { Skeleton } from "@/components/ui/skeleton";

/** Route-level skeleton for `/contacts` (matches the page layout). */
export default function ContactsLoading() {
  return (
    <div className="min-h-[calc(100dvh-7.5rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black p-4 md:p-8">
      <div role="status" className="mx-auto w-full max-w-3xl space-y-8">
        <span className="sr-only">Loading contacts…</span>
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="size-18 rounded-full" />
          <Skeleton className="h-12 w-72" />
          <Skeleton className="h-5 w-full max-w-xl" />
        </div>
        <Skeleton className="h-24 rounded-3xl" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Skeleton className="h-48 rounded-3xl" />
          <Skeleton className="h-48 rounded-3xl" />
        </div>
        <div className="space-y-3 rounded-3xl border border-slate-800 p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-12 w-full" />
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
