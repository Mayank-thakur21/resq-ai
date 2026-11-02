import { Skeleton } from "@/components/ui/skeleton";

/** Route-level skeleton for `/profile` (matches the page layout). */
export default function ProfileLoading() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black pb-12">
      <div role="status" className="container mx-auto max-w-5xl space-y-6 px-4 pt-8 lg:pt-12">
        <span className="sr-only">Loading profile…</span>
        <div className="mb-8 flex items-center gap-3">
          <Skeleton className="size-11 rounded-xl" />
          <Skeleton className="h-10 w-56" />
        </div>
        <Skeleton className="h-24 rounded-2xl" />
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <Skeleton className="h-64 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
          </div>
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
