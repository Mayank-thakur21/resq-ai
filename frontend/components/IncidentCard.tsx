"use client";

/**
 * Card for one community incident (list pages) plus the reusable {@link UpvoteButton}.
 *
 * Severity drives the accent colour and badge; verified incidents (enough community
 * confirmations) get a "Verified" badge. Upvotes ("Confirm") update optimistically and roll
 * back with an inline message if the request fails. Signed-out users get a sign-in prompt
 * instead of a failed request.
 */

import { BadgeCheck, Clock, MapPin, MapIcon, ThumbsUp, UserRound } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import * as React from "react";

import { disasterTypeMeta, severityMeta, STATUS_LABELS } from "@/components/map/incident-meta";
import { mapHref, signInHref } from "@/components/map/layers";
import { RelativeTime } from "@/components/map/RelativeTime";
import { Badge } from "@/components/ui/badge";
import { getErrorMessage, isApiError, upvoteIncident } from "@/lib/api";
import { formatDistance } from "@/lib/geo";
import type { Incident } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------------------
// Upvote ("Confirm") button
// ---------------------------------------------------------------------------------------

interface VoteState {
  upvotes: number;
  upvoted_by_me: boolean;
}

export interface UpvoteButtonProps {
  incident: Incident;
  /** Receives the server's updated incident after a successful upvote. */
  onChange?: (updated: Incident) => void;
  /** Where the sign-in prompt returns to (default: this incident in the list). */
  callbackPath?: string;
  size?: "sm" | "md";
  className?: string;
  /**
   * Disables confirming, e.g. while the incident shown is a saved (offline) copy; the
   * `title` explains why.
   */
  disabledReason?: string | null;
}

function upvoteErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403) return "You can't confirm your own report.";
    if (error.status === 404) return "This incident no longer exists.";
  }
  return getErrorMessage(error, "Couldn't record your confirmation. Please try again.");
}

/**
 * Optimistic, idempotent upvote. The local override is tied to the incident values it was
 * based on (`baseKey`): as soon as the parent passes fresher data (SWR mutate/revalidate),
 * the prop wins again — no effects needed to "sync" state.
 */
export function UpvoteButton({
  incident,
  onChange,
  callbackPath,
  size = "md",
  className,
  disabledReason = null,
}: UpvoteButtonProps) {
  const { data: session, status } = useSession();
  const baseKey = `${incident.id}|${incident.upvotes}|${incident.upvoted_by_me}`;
  // Prop values at the time an in-flight upvote resolves (they may change meanwhile).
  const latestKey = React.useRef(baseKey);
  React.useEffect(() => {
    latestKey.current = baseKey;
  }, [baseKey]);

  const [local, setLocal] = React.useState<{ key: string; vote: VoteState } | null>(null);
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<{ kind: "error" | "signin"; text: string } | null>(null);
  const messageId = React.useId();

  const view: VoteState = local && local.key === baseKey ? local.vote : incident;
  const isReporter = !!session?.user?.id && session.user.id === incident.reporter.id;
  const signedIn = status === "authenticated";
  const returnTo = callbackPath ?? `/incidents?focus=${encodeURIComponent(incident.id)}`;

  const onClick = async () => {
    if (pending || view.upvoted_by_me || isReporter || disabledReason) return;
    if (!signedIn) {
      setMessage({ kind: "signin", text: "Sign in to confirm incidents you can see." });
      return;
    }

    const key = baseKey;
    setMessage(null);
    setPending(true);
    setLocal({ key, vote: { upvotes: incident.upvotes + 1, upvoted_by_me: true } });
    try {
      const updated = await upvoteIncident(incident.id);
      // Keep showing the server's numbers until the parent re-renders with them.
      setLocal({ key: latestKey.current, vote: { upvotes: updated.upvotes, upvoted_by_me: true } });
      onChange?.(updated);
    } catch (error) {
      setLocal(null);
      if (isApiError(error) && error.status === 401) {
        setMessage({ kind: "signin", text: "Your session has expired. Sign in again to confirm." });
      } else {
        setMessage({ kind: "error", text: upvoteErrorMessage(error) });
      }
    } finally {
      setPending(false);
    }
  };

  const label = isReporter ? "Your report" : view.upvoted_by_me ? "Confirmed" : "Confirm";
  const accessibleName = isReporter
    ? `Your report, ${view.upvotes} confirmations`
    : view.upvoted_by_me
      ? `You confirmed this incident, ${view.upvotes} confirmations`
      : `Confirm this incident, ${view.upvotes} confirmations`;

  return (
    <div className={cn("flex flex-col items-start gap-1", className)}>
      <button
        type="button"
        onClick={onClick}
        disabled={pending || isReporter || status === "loading" || !!disabledReason}
        aria-pressed={view.upvoted_by_me}
        aria-label={accessibleName}
        aria-describedby={message ? messageId : undefined}
        title={isReporter ? "You can't confirm your own report" : (disabledReason ?? undefined)}
        className={cn(
          "inline-flex items-center gap-2 rounded-lg border font-semibold transition-colors focus-visible:ring-3 focus-visible:ring-blue-400/60 focus-visible:outline-none disabled:cursor-not-allowed",
          size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 text-sm",
          view.upvoted_by_me
            ? "border-blue-500/50 bg-blue-500/20 text-blue-100"
            : "border-slate-600 bg-slate-800/60 text-slate-100 hover:border-slate-500 hover:bg-slate-700/70",
          (isReporter || status === "loading" || !!disabledReason) && "opacity-60",
        )}
      >
        <ThumbsUp aria-hidden="true" className={cn("size-4", view.upvoted_by_me && "fill-current")} />
        <span aria-hidden="true">{label}</span>
        <span
          aria-hidden="true"
          className="rounded-full bg-black/30 px-1.5 text-xs tabular-nums"
          data-testid="upvote-count"
        >
          {view.upvotes}
        </span>
      </button>
      {message && (
        <p
          id={messageId}
          role={message.kind === "error" ? "alert" : "status"}
          className={cn("text-xs", message.kind === "error" ? "text-red-300" : "text-slate-300")}
        >
          {message.text}{" "}
          {message.kind === "signin" && (
            <Link
              href={signInHref(returnTo)}
              className="font-semibold text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline"
            >
              Sign in
            </Link>
          )}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------------------

export interface IncidentCardProps {
  incident: Incident;
  /** Called with the server's copy after an upvote (update your SWR cache with it). */
  onChange?: (updated: Incident) => void;
  /** Emphasise the card (e.g. `?focus=<id>` from a push notification). */
  highlighted?: boolean;
  className?: string;
}

export function IncidentCard({ incident, onChange, highlighted = false, className }: IncidentCardProps) {
  const type = disasterTypeMeta(incident.disaster_type);
  const severity = severityMeta(incident.severity);
  const titleId = React.useId();
  const detailHref = `/incidents/${encodeURIComponent(incident.id)}`;
  const distance = formatDistance(incident.distance_km);
  const resolved = incident.status === "resolved";

  return (
    <article
      id={`incident-${incident.id}`}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-highlighted={highlighted || undefined}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-2xl border bg-slate-900/60 p-5 pl-6 text-slate-100 backdrop-blur-md transition-colors focus:outline-none",
        highlighted
          ? "border-amber-400/70 ring-2 ring-amber-400/60 shadow-lg shadow-amber-900/20"
          : "border-slate-700/80 hover:border-slate-600",
        resolved && "opacity-80",
        className,
      )}
    >
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1.5", severity.accentClass)} />

      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden="true" className="mt-0.5 text-2xl leading-none">
            {type.glyph}
          </span>
          <div className="min-w-0">
            <h3 id={titleId} className="text-base font-semibold text-white">
              <Link
                href={detailHref}
                className="rounded underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
              >
                {type.label}
              </Link>
            </h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant={severity.badge}>
                <span className="sr-only">Severity: </span>
                {severity.label}
              </Badge>
              {incident.verified && (
                <Badge variant="info" title="Confirmed by several community members">
                  <BadgeCheck aria-hidden="true" />
                  Verified
                </Badge>
              )}
              {resolved && <Badge variant="success">{STATUS_LABELS.resolved}</Badge>}
            </div>
          </div>
        </div>
        {highlighted && (
          <Badge variant="warning" className="shrink-0">
            Highlighted
          </Badge>
        )}
      </header>

      <p className="mt-3 line-clamp-3 text-sm break-words whitespace-pre-line text-slate-300">
        {incident.description}
      </p>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        {distance && (
          <li className="inline-flex items-center gap-1">
            <MapPin aria-hidden="true" className="size-3.5" />
            {distance} away
          </li>
        )}
        <li className="inline-flex items-center gap-1">
          <Clock aria-hidden="true" className="size-3.5" />
          <RelativeTime value={incident.created_at} prefix="Reported" />
        </li>
        <li className="inline-flex min-w-0 items-center gap-1">
          <UserRound aria-hidden="true" className="size-3.5" />
          <span className="truncate">{incident.reporter.name || "Anonymous"}</span>
        </li>
      </ul>

      <footer className="mt-4 flex flex-wrap items-start justify-between gap-3 border-t border-slate-700/60 pt-4">
        <UpvoteButton incident={incident} onChange={onChange} size="sm" />
        <div className="flex items-center gap-2">
          <Link
            href={mapHref(incident)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
          >
            <MapIcon aria-hidden="true" className="size-3.5" />
            Map
          </Link>
          <Link
            href={detailHref}
            className="inline-flex h-8 items-center rounded-lg bg-slate-700/70 px-3 text-xs font-semibold text-white transition-colors hover:bg-slate-600 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
          >
            Details<span className="sr-only">{` about this ${type.label.toLowerCase()} report`}</span>
          </Link>
        </div>
      </footer>
    </article>
  );
}

export default IncidentCard;
