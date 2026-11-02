import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Inline callout for notices and errors (replacement for `alert()` dialogs).
 *
 * `destructive` and `warning` use `role="alert"` (announced immediately); `info` and
 * `success` use `role="status"` (polite). Override with the `role` prop if needed.
 */
const alertVariants = cva(
  "relative grid w-full items-start gap-x-3 gap-y-1 rounded-xl border px-4 py-3 text-sm backdrop-blur-md",
  {
    variants: {
      variant: {
        info: "border-blue-500/30 bg-blue-500/10 text-blue-100 [&>[data-slot=alert-icon]]:text-blue-300",
        warning:
          "border-amber-500/30 bg-amber-500/10 text-amber-100 [&>[data-slot=alert-icon]]:text-amber-300",
        destructive:
          "border-red-500/40 bg-red-500/10 text-red-100 [&>[data-slot=alert-icon]]:text-red-300",
        success:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 [&>[data-slot=alert-icon]]:text-emerald-300",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
);

const icons = {
  info: Info,
  warning: TriangleAlert,
  destructive: CircleAlert,
  success: CircleCheck,
} as const;

type AlertProps = React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    /** Custom icon; pass `null` to hide it. */
    icon?: React.ReactNode | null;
  };

function Alert({ className, variant, icon, role, children, ...props }: AlertProps) {
  const resolved = variant ?? "info";
  const Icon = icons[resolved];
  const iconNode =
    icon === null ? null : (
      <span data-slot="alert-icon" className="mt-0.5 [&>svg]:size-4" aria-hidden="true">
        {icon ?? <Icon />}
      </span>
    );
  return (
    <div
      data-slot="alert"
      role={role ?? (resolved === "destructive" || resolved === "warning" ? "alert" : "status")}
      className={cn(
        alertVariants({ variant }),
        iconNode ? "grid-cols-[auto_1fr]" : "grid-cols-1",
        className,
      )}
      {...props}
    >
      {iconNode}
      <div className="grid min-w-0 gap-1">{children}</div>
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-semibold leading-tight", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-sm leading-relaxed opacity-90 [&_p]:leading-relaxed", className)}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle, alertVariants };
export type { AlertProps };
