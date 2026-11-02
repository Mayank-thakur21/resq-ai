"use client";

import { motion } from "framer-motion";
import { ArrowRight, ExternalLink, Newspaper, Radio, RefreshCw } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import useSWR from "swr";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { OfflineDataNotice } from "@/components/OfflineDataNotice";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage, isApiError, swrKeys } from "@/lib/api";
import {
  formatDateTime,
  formatRelativeTime,
  hostnameOf,
  safeHttpUrl,
  toIsoString,
  truncate,
  type DateInput,
} from "@/lib/format";
import type { NewsItem, NewsResponse, NewsSource } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Latest humanitarian / disaster news (ReliefWeb when configured on the backend, otherwise
 * items derived from GDACS events) via `GET /api/alerts/news`.
 *
 * Two layouts:
 * - `variant="widget"` (default, home page): glassy card with a header, a short list and a
 *   "View all" link to `/alerts?tab=news`.
 * - `variant="list"` (alerts page): full-width article cards with summaries and tags.
 *
 * States: skeleton while loading, `ErrorState` with retry on failure, `EmptyState` when the
 * feed (or the search) returned nothing. Wrap it in an `ErrorBoundary` at the call site.
 */

/** News changes slowly and the backend caches feeds for 10 min. */
const NEWS_REFRESH_MS = 15 * 60_000;

const SOURCE_LABELS: Record<NewsSource, string> = {
  reliefweb: "ReliefWeb",
  gdacs: "GDACS",
};

export function newsSourceLabel(source: NewsSource | string): string {
  return SOURCE_LABELS[source as NewsSource] ?? source;
}

// ---------------------------------------------------------------------------------------
// Relative time (shared by the home/alerts widgets)
// ---------------------------------------------------------------------------------------

/**
 * Current time that re-renders the caller every `intervalMs` (default 60 s), so relative
 * timestamps ("5 minutes ago") stay accurate on long-lived pages.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface RelativeTimeProps {
  value: DateInput;
  /** Text before the relative time, e.g. "Updated". */
  prefix?: string;
  style?: Intl.RelativeTimeFormatStyle;
  className?: string;
}

/**
 * `<time>` element showing a self-updating relative time with the absolute date as a
 * tooltip. Renders nothing for missing/invalid dates.
 */
export function RelativeTime({ value, prefix, style = "long", className }: RelativeTimeProps) {
  const now = useNow();
  const iso = toIsoString(value);
  if (!iso) return null;
  const relative = formatRelativeTime(iso, { now, style });
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className} suppressHydrationWarning>
      {prefix ? `${prefix} ${relative}` : relative}
    </time>
  );
}

// ---------------------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------------------

export interface DisasterFeedProps {
  /** Number of items to request (backend max 100). Default 5 (widget) / 30 (list). */
  limit?: number;
  /** Full-text search (trimmed; blank = latest). */
  query?: string;
  /** ISO 3166-1 alpha-3 country filter, e.g. "IND". */
  country?: string;
  variant?: "widget" | "list";
  /** Widget heading. */
  title?: string;
  /** Widget only: show the "View all" link to the alerts page. Default `true`. */
  showViewAll?: boolean;
  className?: string;
}

export function DisasterFeed({
  limit,
  query,
  country,
  variant = "widget",
  title = "Disaster News",
  showViewAll = true,
  className,
}: DisasterFeedProps) {
  const effectiveLimit = Math.min(100, Math.max(1, limit ?? (variant === "list" ? 30 : 5)));
  const cleanQuery = query?.trim() || undefined;
  const cleanCountry = country?.trim().toUpperCase() || undefined;
  const key = swrKeys.news({ limit: effectiveLimit, query: cleanQuery, country: cleanCountry });

  const { data, error, isLoading, isValidating, mutate } = useSWR<NewsResponse>(key, {
    refreshInterval: NEWS_REFRESH_MS,
  });

  const retry = React.useCallback(() => {
    void mutate();
  }, [mutate]);

  const items = data?.items ?? [];
  // `keepPreviousData` shows the previous query's results while a new search loads.
  const showingStale = isLoading && !!data;

  let body: React.ReactNode;
  if (!data && !error) {
    body = <FeedSkeleton variant={variant} rows={variant === "list" ? 4 : 3} />;
  } else if (!data) {
    body = (
      <ErrorState
        compact
        title="News is unavailable"
        message={getErrorMessage(error, "We couldn't load the latest disaster news.")}
        offline={isApiError(error) && error.isNetworkError}
        onRetry={retry}
        className={variant === "widget" ? "border-0 bg-transparent p-2" : undefined}
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<Newspaper />}
        title={cleanQuery ? "No news matches your search" : "No recent disaster news"}
        message={
          cleanQuery
            ? "Try a different keyword, a country name or a disaster type such as “flood”."
            : "There are no recent reports right now. Check back later."
        }
        className={variant === "widget" ? "border-0 bg-transparent p-2" : undefined}
      />
    );
  } else {
    body = (
      <>
        {/* Saved copy from the service worker (offline / slow network): never looks live. */}
        <OfflineDataNotice data={data} compact={variant === "widget"} className="mb-3" />
        {error && (
          <p role="status" className="mb-3 text-xs text-amber-300">
            Couldn&apos;t refresh the news — showing the last results.
          </p>
        )}
        <ul
          className={cn(
            variant === "widget" ? "space-y-4" : "grid gap-3",
            showingStale && "opacity-60 transition-opacity",
          )}
          aria-busy={isValidating}
        >
          {items.map((item) =>
            variant === "widget" ? (
              <WidgetItem key={item.id} item={item} />
            ) : (
              <ListItem key={item.id} item={item} />
            ),
          )}
        </ul>
      </>
    );
  }

  if (variant === "list") {
    return (
      <section aria-label="Disaster news" className={cn("space-y-3", className)}>
        {data && (
          <div className="flex items-start justify-between gap-2 text-xs text-slate-400">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span>
                {items.length} {items.length === 1 ? "item" : "items"}
              </span>
              {data.sources.length > 0 && (
                <span className="flex items-center gap-1">
                  · Sources:
                  {data.sources.map((source) => (
                    <Badge key={source} variant="outline" className="py-0 text-[10px]">
                      {newsSourceLabel(source)}
                    </Badge>
                  ))}
                </span>
              )}
              <RelativeTime value={data.updated_at} prefix="· Updated" />
            </div>
            <RefreshButton onClick={retry} busy={isValidating} label="Refresh news" />
          </div>
        )}
        {body}
      </section>
    );
  }

  return (
    <motion.section
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.4 }}
      aria-labelledby="disaster-feed-title"
      className={cn(
        "flex flex-col rounded-2xl border border-slate-700 bg-slate-800/50 p-6 backdrop-blur-md",
        className,
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2
          id="disaster-feed-title"
          className="flex items-center gap-2 text-sm font-semibold tracking-wider text-slate-400 uppercase"
        >
          <Radio aria-hidden="true" className="size-4" /> {title}
        </h2>
        {data && <RefreshButton onClick={retry} busy={isValidating} label="Refresh news" />}
      </div>
      <div className="flex-grow">{body}</div>
      {showViewAll && (
        <Link
          href="/alerts?tab=news"
          className="mt-4 inline-flex items-center gap-1 self-start rounded text-sm font-medium text-cyan-300 transition-colors hover:text-cyan-200 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
        >
          All alerts &amp; news <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      )}
    </motion.section>
  );
}

export default DisasterFeed;

// ---------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------

function RefreshButton({ onClick, busy, label }: { onClick: () => void; busy: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-700/60 hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none disabled:opacity-60"
    >
      <RefreshCw aria-hidden="true" className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")} />
    </button>
  );
}

function sourceName(item: NewsItem): string {
  return item.source_name?.trim() || newsSourceLabel(item.source);
}

/** External link that opens in a new tab without leaking `window.opener` or the referrer. */
function ExternalTitleLink({ item, className }: { item: NewsItem; className?: string }) {
  const href = safeHttpUrl(item.url);
  if (!href) return <span className={className}>{item.title}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "rounded hover:text-white hover:underline focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none",
        className,
      )}
    >
      {item.title}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function WidgetItem({ item }: { item: NewsItem }) {
  return (
    <li className="border-b border-slate-700/50 pb-3 last:border-0 last:pb-0">
      <ExternalTitleLink item={item} className="line-clamp-2 text-sm text-slate-200" />
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500">
        <span className="font-medium text-slate-400">{sourceName(item)}</span>
        {item.published_at && (
          <>
            <span aria-hidden="true">·</span>
            <RelativeTime value={item.published_at} />
          </>
        )}
        {item.countries.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">{item.countries.slice(0, 2).join(", ")}</span>
          </>
        )}
      </p>
    </li>
  );
}

function ListItem({ item }: { item: NewsItem }) {
  const href = safeHttpUrl(item.url);
  return (
    <li>
      <article className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 backdrop-blur-md transition-colors hover:border-slate-600">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <Badge variant={item.source === "reliefweb" ? "info" : "warning"}>{newsSourceLabel(item.source)}</Badge>
          {item.source_name && item.source_name !== newsSourceLabel(item.source) && (
            <span className="font-medium text-slate-300">{item.source_name}</span>
          )}
          {item.published_at && <RelativeTime value={item.published_at} />}
        </div>
        <h3 className="text-base leading-snug font-semibold text-slate-100">
          <ExternalTitleLink item={item} />
        </h3>
        {item.summary && <p className="mt-2 line-clamp-3 text-sm text-slate-300">{truncate(item.summary, 400)}</p>}
        {(item.countries.length > 0 || item.disaster_types.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {item.disaster_types.slice(0, 3).map((type) => (
              <Badge key={`t-${type}`} variant="default">
                {type}
              </Badge>
            ))}
            {item.countries.slice(0, 4).map((country) => (
              <Badge key={`c-${country}`} variant="outline">
                {country}
              </Badge>
            ))}
          </div>
        )}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 rounded text-xs font-medium text-cyan-300 hover:text-cyan-200 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            Read on {hostnameOf(href) || newsSourceLabel(item.source)}
            <ExternalLink aria-hidden="true" className="size-3" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </article>
    </li>
  );
}

function FeedSkeleton({ variant, rows }: { variant: "widget" | "list"; rows: number }) {
  return (
    <div role="status" aria-live="polite" className={variant === "widget" ? "space-y-4" : "grid gap-3"}>
      <span className="sr-only">Loading news…</span>
      {Array.from({ length: rows }, (_, index) =>
        variant === "widget" ? (
          <div key={index} className="space-y-2 border-b border-slate-700/50 pb-3 last:border-0">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ) : (
          <div key={index} className="space-y-3 rounded-2xl border border-slate-700 bg-slate-800/40 p-5">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ),
      )}
    </div>
  );
}
