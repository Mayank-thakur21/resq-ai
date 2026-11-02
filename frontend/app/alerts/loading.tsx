import { AlertsBodySkeleton, AlertsHeaderSkeleton } from "@/app/alerts/_components/AlertsSkeleton";

/** Route-level skeleton for `/alerts` (matches the page layout). */
export default function AlertsLoading() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black pb-12">
      <div className="container mx-auto max-w-6xl px-4 pt-8 lg:pt-12">
        <AlertsHeaderSkeleton />
        <AlertsBodySkeleton />
      </div>
    </div>
  );
}
