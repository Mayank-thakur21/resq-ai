"use client";

import { BellRing, ExternalLink, MapPin } from "lucide-react";
import * as React from "react";

import { disasterEventIcon } from "@/components/AlertBanner";
import { RelativeTime } from "@/components/DisasterFeed";
import { Badge } from "@/components/ui/badge";
import { safeHttpUrl, truncate } from "@/lib/format";
import { formatDistance, mapsLink } from "@/lib/geo";
import type { AlertLevel, DisasterEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEVEL_STYLES: Record<AlertLevel, { border: string; icon: string; label: string }> = {
  red: { border: "border-l-red-500", icon: "bg-red-500/15 text-red-300", label: "Red alert" },
  orange: { border: "border-l-orange-500", icon: "bg-orange-500/15 text-orange-300", label: "Orange alert" },
  green: { border: "border-l-emerald-500", icon: "bg-emerald-500/15 text-emerald-300", label: "Green alert" },
};

export interface DisasterEventCardProps {
  event: DisasterEvent;
  /** Distance to show (backend `distance_km`, or computed client-side); `null` hides it. */
  distanceKm?: number | null;
  /** The event a push notification linked to (`/alerts?event=<id>`): ring + label. */
  highlighted?: boolean;
}

/** One GDACS event: type icon, alert-level badge, key facts and links to the report/map. */
export function DisasterEventCard({
  event,
  distanceKm = event.distance_km,
  highlighted = false,
}: DisasterEventCardProps) {
  const styles = LEVEL_STYLES[event.alert_level] ?? LEVEL_STYLES.green;
  const Icon = disasterEventIcon(event.event_type);
  const report = safeHttpUrl(event.url);
  const titleId = `event-${event.id}-title`;
  const description =
    event.description && event.description.trim() !== event.title.trim() ? truncate(event.description, 280) : "";

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        "rounded-2xl border border-l-4 border-slate-700 bg-slate-800/50 p-5 backdrop-blur-md transition-colors hover:border-slate-600",
        styles.border,
        highlighted && "ring-2 ring-cyan-400/70 ring-offset-2 ring-offset-slate-900",
      )}
    >
      {highlighted && (
        <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-cyan-500/15 px-2.5 py-1 text-xs font-semibold text-cyan-200">
          <BellRing aria-hidden="true" className="size-3.5" />
          From your notification
        </p>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-xl", styles.icon)}
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 id={titleId} className="text-base leading-snug font-semibold text-slate-100">
              {event.title}
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {[event.event_type_label || event.event_type, event.country].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
        <Badge variant={event.alert_level} uppercase className="shrink-0" title={styles.label}>
          {event.alert_level}
          <span className="sr-only"> alert level</span>
        </Badge>
      </div>

      {description && <p className="mt-3 line-clamp-3 text-sm text-slate-300">{description}</p>}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        {event.severity_text && (
          <div className="col-span-2">
            <dt className="text-slate-500">Severity</dt>
            <dd className="text-slate-200">{event.severity_text}</dd>
          </div>
        )}
        {event.from_date && (
          <div>
            <dt className="text-slate-500">Started</dt>
            <dd className="text-slate-200">
              <RelativeTime value={event.from_date} />
            </dd>
          </div>
        )}
        {event.to_date && (
          <div>
            <dt className="text-slate-500">Last update</dt>
            <dd className="text-slate-200">
              <RelativeTime value={event.to_date} />
            </dd>
          </div>
        )}
        {typeof distanceKm === "number" && Number.isFinite(distanceKm) && (
          <div>
            <dt className="text-slate-500">Distance</dt>
            <dd className="text-slate-200">{formatDistance(distanceKm)} away</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-500">Status</dt>
          <dd className={event.is_current ? "text-amber-200" : "text-slate-400"}>
            {event.is_current ? "Ongoing" : "Ended"}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-semibold">
        {report && (
          <a
            href={report}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded text-cyan-300 hover:text-cyan-200 hover:underline focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            GDACS report <ExternalLink aria-hidden="true" className="size-3" />
            <span className="sr-only"> for {event.title} (opens in a new tab)</span>
          </a>
        )}
        <a
          href={mapsLink(event.lat, event.lon)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded text-slate-300 hover:text-white hover:underline focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
        >
          <MapPin aria-hidden="true" className="size-3" /> Open in Maps
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </article>
  );
}

export default DisasterEventCard;
