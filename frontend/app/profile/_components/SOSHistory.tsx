"use client";

import { History, MapPin, Siren } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage, getSOSHistory, isApiError, swrKeys } from "@/lib/api";
import { formatDateTime, formatRelativeTime, pluralize, truncate } from "@/lib/format";
import { mapsLink } from "@/lib/geo";
import type { SOSHistoryResponse } from "@/lib/types";

/** The signed-in user's SOS alerts (`GET /sos/history`, newest first, max 50). */
export function SOSHistory() {
  // Same key the SOS page revalidates after sending; fetched through the typed helper.
  const { data, error, isLoading, mutate } = useSWR<SOSHistoryResponse>(swrKeys.sosHistory(), () =>
    getSOSHistory(),
  );

  let content: React.ReactNode;
  if (error && !data) {
    const unauthorized = isApiError(error) && error.status === 401;
    content = (
      <ErrorState
        compact
        title={unauthorized ? "Your session has expired" : "SOS history couldn't be loaded"}
        message={unauthorized ? "Sign in again to see your SOS history." : getErrorMessage(error)}
        offline={isApiError(error) && error.isNetworkError}
        onRetry={unauthorized ? undefined : () => void mutate()}
      >
        {unauthorized && (
          <Link
            href="/login?callbackUrl=%2Fprofile"
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none"
          >
            Sign in
          </Link>
        )}
      </ErrorState>
    );
  } else if (isLoading || !data) {
    content = (
      <div role="status" className="space-y-3">
        <span className="sr-only">Loading SOS history…</span>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  } else if (data.events.length === 0) {
    content = (
      <EmptyState
        compact
        icon={<Siren />}
        title="No SOS alerts yet"
        message="When you send an SOS while signed in, it is listed here with its time, location and delivery results."
        action={
          <Link
            href="/sos"
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
          >
            Open SOS
          </Link>
        }
      />
    );
  } else {
    content = (
      <ol className="space-y-3">
        {data.events.map((event) => (
          <li key={event.id} className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-sm font-semibold text-white">
                <time dateTime={event.timestamp} title={formatDateTime(event.timestamp)}>
                  {formatDateTime(event.timestamp)}
                </time>
                <span className="ml-2 text-xs font-normal text-slate-400">{formatRelativeTime(event.timestamp)}</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {event.contacts_count === 0 ? (
                  <Badge variant="outline">No contacts texted</Badge>
                ) : (
                  <Badge variant="default">{pluralize(event.contacts_count, "contact")}</Badge>
                )}
                {event.sms_sent > 0 && <Badge variant="success">{event.sms_sent} delivered</Badge>}
                {event.sms_failed > 0 && <Badge variant="destructive">{event.sms_failed} failed</Badge>}
              </div>
            </div>
            <p className="mt-1 text-sm text-slate-300">{truncate(event.message, 160)}</p>
            <a
              href={mapsLink(event.lat, event.lon)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200 hover:underline focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none"
            >
              <MapPin aria-hidden="true" className="size-3.5" />
              View location
            </a>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <section
      aria-labelledby="sos-history-title"
      className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 backdrop-blur-md"
    >
      <div className="mb-4 flex items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-500/15 text-red-300"
        >
          <History className="size-5" />
        </span>
        <div>
          <h2 id="sos-history-title" className="text-base font-semibold text-white">
            SOS history
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">Alerts you sent while signed in (latest 50).</p>
        </div>
      </div>
      {content}
    </section>
  );
}

export default SOSHistory;
