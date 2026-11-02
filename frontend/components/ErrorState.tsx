"use client";

import { CircleAlert, RefreshCw, WifiOff } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  title?: string;
  message?: string;
  /** Renders a "Try again" button when provided. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra technical details (error message, request id) shown in a collapsible block. */
  details?: string | null;
  /** Use the "offline" icon (e.g. for network errors). */
  offline?: boolean;
  /** Smaller variant for widgets/cards. */
  compact?: boolean;
  className?: string;
  /** Additional actions (links/buttons) rendered next to the retry button. */
  children?: React.ReactNode;
}

/**
 * Standard failure UI for pages and widgets: icon, title, message, optional retry and
 * collapsible details. Announced to screen readers via `role="alert"`.
 */
export function ErrorState({
  title = "Something went wrong",
  message = "We couldn't load this content. Please try again.",
  onRetry,
  retryLabel = "Try again",
  details,
  offline = false,
  compact = false,
  className,
  children,
}: ErrorStateProps) {
  const Icon = offline ? WifiOff : CircleAlert;
  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-red-500/25 bg-red-950/20 text-center text-slate-200 backdrop-blur-md",
        compact ? "gap-2 p-4" : "gap-3 p-8",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-red-500/15 text-red-300",
          compact ? "p-2" : "p-3",
        )}
      >
        <Icon className={compact ? "size-5" : "size-7"} />
      </span>
      <div className="space-y-1">
        <h2 className={cn("font-semibold text-white", compact ? "text-base" : "text-lg")}>{title}</h2>
        <p className={cn("mx-auto max-w-md text-slate-300", compact ? "text-xs" : "text-sm")}>{message}</p>
      </div>
      {(onRetry || children) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {retryLabel}
            </button>
          )}
          {children}
        </div>
      )}
      {details && (
        <details className="mt-2 w-full max-w-md text-left text-xs text-slate-400">
          <summary className="cursor-pointer select-none rounded focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none">
            Technical details
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 whitespace-pre-wrap break-words">
            {details}
          </pre>
        </details>
      )}
    </div>
  );
}

export default ErrorState;
