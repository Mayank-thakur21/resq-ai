import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Loading placeholder block. Decorative only (`aria-hidden`): wrap groups of skeletons in a
 * container with `role="status"` + an `sr-only` label (or use `<Spinner label>`) so screen
 * readers still hear that content is loading.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-slate-700/40 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };
