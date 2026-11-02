import { Skeleton } from "@/components/ui/skeleton";

/** Route-level skeleton for `/chat` (header, a few bubbles, composer). */
export default function ChatLoading() {
  return (
    <div className="mx-auto flex h-[calc(100dvh-7.5rem-env(safe-area-inset-bottom))] w-full max-w-5xl flex-col bg-slate-900/50 lg:h-[calc(100dvh-4rem)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="h-6 w-48" />
        </div>
        <Skeleton className="h-9 w-28 sm:w-44" />
      </div>
      <div role="status" className="flex-1 space-y-6 px-4 py-6 md:px-6">
        <span className="sr-only">Loading chat…</span>
        <div className="mx-auto max-w-3xl space-y-6">
          <Skeleton className="h-20 w-4/5 rounded-2xl" />
          <Skeleton className="ml-auto h-12 w-1/2 rounded-2xl" />
          <Skeleton className="h-32 w-11/12 rounded-2xl" />
        </div>
      </div>
      <div className="border-t border-slate-800 p-4">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <Skeleton className="size-12 rounded-full" />
          <Skeleton className="h-12 flex-1 rounded-3xl" />
          <Skeleton className="size-12 rounded-full" />
          <Skeleton className="size-12 rounded-full" />
        </div>
      </div>
    </div>
  );
}
