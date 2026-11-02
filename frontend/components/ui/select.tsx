import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Native `<select>` styled to match the inputs. Native is deliberate: it is accessible,
 * works with the keyboard and the OS picker on mobile, and needs no JS.
 *
 * `className` styles the wrapper (width / layout); every other prop goes to the `<select>`.
 *
 * @example
 * <Label htmlFor="radius">Radius</Label>
 * <Select id="radius" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
 *   <option value="5">5 km</option>
 * </Select>
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div data-slot="select-wrapper" className={cn("relative w-full", className)}>
      <select
        data-slot="select"
        className={cn(
          "h-9 w-full min-w-0 cursor-pointer appearance-none rounded-lg border border-slate-700 bg-slate-900/60 py-1 pr-9 pl-3 text-sm text-slate-100 transition-colors outline-none",
          "focus-visible:border-blue-400 focus-visible:ring-3 focus-visible:ring-blue-500/40",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "aria-invalid:border-red-500 aria-invalid:ring-3 aria-invalid:ring-red-500/20",
          "[&>option]:bg-slate-900 [&>option]:text-slate-100",
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-slate-400"
      />
    </div>
  );
}

export { Select };
