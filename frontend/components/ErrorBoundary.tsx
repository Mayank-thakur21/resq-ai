"use client";

import * as React from "react";

import { ErrorState } from "@/components/ErrorState";

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Custom fallback. Receives the error and a `reset` function that re-renders children. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** Called once per caught error (defaults to logging to the console). */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** When any of these values change, a caught error is cleared automatically. */
  resetKeys?: readonly unknown[];
  /** Title for the default fallback, e.g. "Weather is unavailable". */
  title?: string;
  /** Use the compact default fallback (for widgets). */
  compact?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === "string" ? value : "Unknown error");
}

function keysChanged(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
  return a.length !== b.length || a.some((item, index) => !Object.is(item, b[index]));
}

/**
 * Catches render/lifecycle errors in its subtree so one broken widget cannot take down the
 * whole page. Wrap every data-driven widget:
 *
 * ```tsx
 * <ErrorBoundary title="Weather is unavailable" compact>
 *   <WeatherCard />
 * </ErrorBoundary>
 * ```
 *
 * Note: React error boundaries do not catch errors in event handlers or async code; show
 * those with `<ErrorState>` from the component's own state (e.g. SWR `error`).
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const err = toError(error);
    if (this.props.onError) {
      this.props.onError(err, info);
    } else {
      console.error("[ErrorBoundary] caught an error", err, info.componentStack);
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <ErrorState
        title={this.props.title ?? "Something went wrong"}
        message="This section failed to load. You can try again or keep using the rest of the page."
        details={process.env.NODE_ENV === "production" ? null : error.message}
        onRetry={this.reset}
        compact={this.props.compact}
      />
    );
  }
}

export default ErrorBoundary;
