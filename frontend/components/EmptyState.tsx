import { Inbox } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  title: string;
  message?: string;
  /** Icon element (defaults to an inbox). */
  icon?: React.ReactNode;
  /** Call-to-action(s), e.g. a link to widen the search radius. */
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}

/** Neutral "nothing here yet" UI for lists and widgets with no data. */
export function EmptyState({ title, message, icon, action, compact = false, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-900/30 text-center text-slate-300",
        compact ? "gap-2 p-4" : "gap-3 p-8",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-slate-800/80 text-slate-400 [&>svg]:size-6",
          compact ? "p-2" : "p-3",
        )}
      >
        {icon ?? <Inbox />}
      </span>
      <div className="space-y-1">
        <p className={cn("font-semibold text-slate-100", compact ? "text-sm" : "text-base")}>{title}</p>
        {message && (
          <p className={cn("mx-auto max-w-md text-slate-400", compact ? "text-xs" : "text-sm")}>{message}</p>
        )}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export default EmptyState;
