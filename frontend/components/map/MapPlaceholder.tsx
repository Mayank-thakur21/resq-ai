import { MapIcon } from "lucide-react";
import * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Placeholder shown while a Leaflet map bundle loads (the `loading` of `next/dynamic`) or
 * while the page waits for a location. Leaflet-free so it can render on the server.
 */
export function MapPlaceholder({
  label = "Loading map…",
  className,
  children,
}: {
  label?: string;
  className?: string;
  /** Extra content under the label (e.g. a "Skip" button). */
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-slate-900", className)}>
      <Skeleton className="absolute inset-0 rounded-none bg-slate-800/60" />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.08)_1px,transparent_1px)] bg-[size:48px_48px]"
      />
      <div className="relative flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <span aria-hidden="true" className="rounded-full bg-blue-500/15 p-3 text-blue-300">
          <MapIcon className="size-7" />
        </span>
        <Spinner label={label} showLabel className="font-medium text-slate-300" />
        {children}
      </div>
    </div>
  );
}

export default MapPlaceholder;
