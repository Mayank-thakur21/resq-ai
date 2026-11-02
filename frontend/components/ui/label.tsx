import * as React from "react";

import { cn } from "@/lib/utils";

/** Form label. Pass `htmlFor` matching the control's `id`; `required` adds a visual marker. */
function Label({
  className,
  children,
  required,
  ...props
}: React.ComponentProps<"label"> & { required?: boolean }) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-1 text-sm font-medium leading-none text-slate-200 select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
        className,
      )}
      {...props}
    >
      {children}
      {required && (
        <span aria-hidden="true" className="text-red-400">
          *
        </span>
      )}
    </label>
  );
}

export { Label };
