import { LoaderCircle } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const sizes = {
  sm: "size-4",
  md: "size-6",
  lg: "size-10",
} as const;

type SpinnerProps = Omit<React.ComponentProps<"span">, "children"> & {
  size?: keyof typeof sizes;
  /** Accessible label announced to screen readers. Default "Loading". */
  label?: string;
  /** Also render the label visibly next to the spinner. */
  showLabel?: boolean;
};

/** Animated loading indicator with a polite live-region label. */
function Spinner({ className, size = "md", label = "Loading", showLabel = false, ...props }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      data-slot="spinner"
      className={cn("inline-flex items-center gap-2 text-slate-300", className)}
      {...props}
    >
      <LoaderCircle aria-hidden="true" className={cn("animate-spin motion-reduce:animate-none", sizes[size])} />
      <span className={showLabel ? "text-sm" : "sr-only"}>{label}</span>
    </span>
  );
}

export { Spinner };
export type { SpinnerProps };
