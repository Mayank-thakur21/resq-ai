import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Small status pill. Colour variants cover the app's semantic levels:
 * severity (`low`/`medium`/`high`/`critical`), GDACS alert levels (`green`/`orange`/`red`)
 * and generic `info`/`success`/`warning`/`destructive`.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide transition-colors [&>svg]:size-3 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-slate-700/60 text-slate-100",
        outline: "border-slate-600 bg-transparent text-slate-200",
        info: "border-blue-500/30 bg-blue-500/15 text-blue-300",
        success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
        warning: "border-amber-500/30 bg-amber-500/15 text-amber-300",
        destructive: "border-red-500/30 bg-red-500/15 text-red-300",
        low: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
        medium: "border-amber-500/30 bg-amber-500/15 text-amber-300",
        high: "border-orange-500/30 bg-orange-500/15 text-orange-300",
        critical: "border-red-500/40 bg-red-600/25 text-red-200",
        green: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
        orange: "border-orange-500/30 bg-orange-500/15 text-orange-300",
        red: "border-red-500/40 bg-red-600/25 text-red-200",
      },
      uppercase: {
        true: "uppercase",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      uppercase: false,
    },
  },
);

type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, uppercase, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, uppercase }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
export type { BadgeProps };
