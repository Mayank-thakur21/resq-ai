"use client";

import { House, List, MapIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { ErrorState } from "@/components/ErrorState";

const secondaryLink =
  "inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none";

export interface SegmentErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** Log prefix, e.g. "app/map". */
  scope: string;
  title: string;
  message: string;
  /** Which escape hatches to offer next to "Try again". */
  links?: readonly ("home" | "map" | "incidents")[];
}

/** Body of the `error.tsx` files of the map and incident route segments. */
export function SegmentError({ error, reset, scope, title, message, links = ["home"] }: SegmentErrorProps) {
  React.useEffect(() => {
    console.error(`[${scope}] route segment crashed`, error);
  }, [error, scope]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl items-center px-4 py-12">
      <ErrorState
        className="w-full"
        title={title}
        message={`${message} Emergency? Call 112 (or your local emergency number).`}
        onRetry={reset}
        details={error.digest ? `Error reference: ${error.digest}` : null}
      >
        {links.includes("incidents") && (
          <Link href="/incidents" className={secondaryLink}>
            <List aria-hidden="true" className="size-4" />
            Incidents
          </Link>
        )}
        {links.includes("map") && (
          <Link href="/map" className={secondaryLink}>
            <MapIcon aria-hidden="true" className="size-4" />
            Relief map
          </Link>
        )}
        {links.includes("home") && (
          <Link href="/" className={secondaryLink}>
            <House aria-hidden="true" className="size-4" />
            Go home
          </Link>
        )}
      </ErrorState>
    </div>
  );
}

export default SegmentError;
