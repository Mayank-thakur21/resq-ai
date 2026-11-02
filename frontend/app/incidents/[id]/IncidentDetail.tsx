"use client";

/**
 * Client view of `/incidents/[id]`: full report, photo, map, community confirmation and —
 * for the reporter — "Mark resolved" / "Reopen".
 *
 * Distance from the viewer is shown only when location permission was already granted (no
 * surprise permission prompt on a page opened from a notification).
 */

import {
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  Clock,
  ExternalLink,
  MapIcon,
  MapPin,
  Navigation,
  RotateCcw,
  Share2,
  Siren,
  UserRound,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSession } from "next-auth/react";
import * as React from "react";
import useSWR, { useSWRConfig } from "swr";

import { EmptyState } from "@/components/EmptyState";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorState } from "@/components/ErrorState";
import { UpvoteButton } from "@/components/IncidentCard";
import { OfflineDataNotice } from "@/components/OfflineDataNotice";
import { disasterTypeMeta, incidentTitle, severityMeta, STATUS_LABELS } from "@/components/map/incident-meta";
import { mapHref, reportIncidentHref } from "@/components/map/layers";
import { MapPlaceholder } from "@/components/map/MapPlaceholder";
import { RelativeTime } from "@/components/map/RelativeTime";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage, isApiError, isSavedCopy, swrKeys, updateIncidentStatus } from "@/lib/api";
import { formatCoordinates, formatDateTime, safeHttpUrl, toTimestamp } from "@/lib/format";
import { formatDistance, haversineKm, mapsLink, useGeolocation, type Coordinates } from "@/lib/geo";
import type { Incident, IncidentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const IncidentMap = dynamic(() => import("@/components/map/IncidentMap"), {
  ssr: false,
  loading: () => <MapPlaceholder label="Loading map…" />,
});

const DETAIL_REFRESH_MS = 60_000;

/** Why actions are disabled while the report shown is a saved (offline) copy. */
export const SAVED_COPY_ACTION_HINT =
  "This is a saved copy — reconnect to confirm the report or change its status.";

const secondaryAction =
  "inline-flex h-9 items-center gap-2 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

/** Device location, but only when permission is already granted (never prompts). */
function useSilentLocation(): Coordinates | null {
  const geo = useGeolocation({ auto: false });
  const { retry } = geo;
  React.useEffect(() => {
    let cancelled = false;
    const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    permissions
      ?.query({ name: "geolocation" as PermissionName })
      .then((state) => {
        if (!cancelled && state.state === "granted") retry();
      })
      .catch(() => {
        // Permissions API unsupported for geolocation: skip the distance.
      });
    return () => {
      cancelled = true;
    };
  }, [retry]);
  return geo.coords ?? null;
}

export interface IncidentDetailProps {
  id: string;
  /** Show the "report submitted" banner (`?created=1` after the form redirects here). */
  justCreated?: boolean;
}

export function IncidentDetail({ id, justCreated = false }: IncidentDetailProps) {
  const { data: session } = useSession();
  const { mutate: globalMutate } = useSWRConfig();
  const { data: incident, error, mutate, isValidating } = useSWR<Incident>(swrKeys.incident(id), {
    refreshInterval: DETAIL_REFRESH_MS,
  });
  const viewer = useSilentLocation();

  const [statusPending, setStatusPending] = React.useState(false);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [shareState, setShareState] = React.useState<"idle" | "copied" | "failed">("idle");
  const [imageFailed, setImageFailed] = React.useState(false);

  /** Lists elsewhere in the cache (e.g. `/incidents`) should pick up our change. */
  const revalidateLists = React.useCallback(() => {
    void globalMutate((key) => Array.isArray(key) && key[0] === "incidents");
  }, [globalMutate]);

  const onUpvoted = React.useCallback(
    (updated: Incident) => {
      void mutate(updated, { revalidate: false });
      revalidateLists();
    },
    [mutate, revalidateLists],
  );

  const changeStatus = async (next: IncidentStatus) => {
    setStatusPending(true);
    setStatusError(null);
    try {
      const updated = await updateIncidentStatus(id, next);
      await mutate(updated, { revalidate: false });
      revalidateLists();
    } catch (statusChangeError) {
      console.error("[IncidentDetail] status change failed", statusChangeError);
      setStatusError(
        isApiError(statusChangeError) && statusChangeError.status === 403
          ? "Only the person who reported this incident can change its status."
          : getErrorMessage(statusChangeError, "Couldn't update the status. Please try again."),
      );
    } finally {
      setStatusPending(false);
    }
  };

  const share = async () => {
    if (!incident) return;
    const url = window.location.origin + `/incidents/${encodeURIComponent(incident.id)}`;
    const title = `${incidentTitle(incident)} reported nearby`;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, text: incident.description.slice(0, 140), url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShareState("copied");
    } catch (shareError) {
      // The user dismissing the share sheet is not an error.
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setShareState("failed");
    }
    window.setTimeout(() => setShareState("idle"), 3_000);
  };

  let content: React.ReactNode;
  if (!incident && !error) {
    content = <DetailSkeleton />;
  } else if (!incident) {
    content =
      isApiError(error) && error.status === 404 ? (
        <EmptyState
          title="Incident not found"
          message="This report may have been removed, or the link is incomplete."
          action={
            <Link
              href="/incidents"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
            >
              Browse incidents
            </Link>
          }
        />
      ) : (
        <ErrorState
          title="Couldn't load this incident"
          message={getErrorMessage(error, "We couldn't load the incident details.")}
          offline={isApiError(error) && error.isNetworkError}
          onRetry={() => void mutate()}
        />
      );
  } else {
    const type = disasterTypeMeta(incident.disaster_type);
    const severity = severityMeta(incident.severity);
    const isReporter = !!session?.user?.id && session.user.id === incident.reporter.id;
    const resolved = incident.status === "resolved";
    const imageUrl = imageFailed ? null : safeHttpUrl(incident.image_url);
    const distance = viewer ? haversineKm(viewer, incident) : incident.distance_km;
    const created = toTimestamp(incident.created_at);
    const updatedAt = toTimestamp(incident.updated_at);
    const wasUpdated = created !== null && updatedAt !== null && updatedAt - created > 60_000;
    const title = incidentTitle(incident);
    // A saved copy served by the service worker (offline / very slow network) may be stale:
    // label it, and disable actions that need the server (they would fail anyway).
    const savedCopy = isSavedCopy(incident);
    const actionsDisabledReason = savedCopy ? SAVED_COPY_ACTION_HINT : null;

    content = (
      <div className="grid gap-6 lg:grid-cols-5">
        <OfflineDataNotice data={incident} className="lg:col-span-5" />
        <article
          aria-labelledby="incident-title"
          className="relative overflow-hidden rounded-3xl border border-slate-700/80 bg-slate-900/60 p-6 pl-7 backdrop-blur-md lg:col-span-3"
        >
          <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-2", severity.accentClass)} />
          <header className="flex items-start gap-4">
            <span aria-hidden="true" className="text-4xl leading-none">
              {type.glyph}
            </span>
            <div className="min-w-0">
              <h1 id="incident-title" className="text-2xl font-extrabold tracking-tight text-white md:text-3xl">
                {title}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge variant={severity.badge}>
                  <span className="sr-only">Severity: </span>
                  {severity.label}
                </Badge>
                <Badge variant={resolved ? "success" : "warning"}>
                  <span className="sr-only">Status: </span>
                  {STATUS_LABELS[incident.status] ?? incident.status}
                </Badge>
                {incident.verified && (
                  <Badge variant="info" title="Confirmed by several community members">
                    <BadgeCheck aria-hidden="true" />
                    Verified
                  </Badge>
                )}
                {isValidating && <Spinner size="sm" label="Refreshing" className="text-slate-500" />}
              </div>
            </div>
          </header>

          <ul className="mt-5 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
            <li className="flex items-center gap-2">
              <UserRound aria-hidden="true" className="size-4 text-slate-500" />
              Reported by <span className="font-semibold text-slate-100">{incident.reporter.name || "Anonymous"}</span>
              {isReporter && <span className="text-xs text-slate-500">(you)</span>}
            </li>
            <li className="flex items-center gap-2">
              <Clock aria-hidden="true" className="size-4 text-slate-500" />
              <RelativeTime value={incident.created_at} prefix="Reported" />
            </li>
            {distance !== null && distance !== undefined && Number.isFinite(distance) && (
              <li className="flex items-center gap-2">
                <MapPin aria-hidden="true" className="size-4 text-slate-500" />
                {formatDistance(distance)} from you
              </li>
            )}
            {wasUpdated && (
              <li className="flex items-center gap-2 text-slate-400">
                <RotateCcw aria-hidden="true" className="size-4 text-slate-500" />
                Updated {formatDateTime(incident.updated_at)}
              </li>
            )}
          </ul>

          <div className="mt-6">
            <h2 className="sr-only">Description</h2>
            <p className="text-base leading-relaxed break-words whitespace-pre-wrap text-slate-200">
              {incident.description}
            </p>
          </div>

          {imageUrl && (
            <figure className="mt-6 overflow-hidden rounded-2xl border border-slate-700/80 bg-black/30">
              {/* User-supplied photo on an arbitrary host: next/image would need every host
                  allow-listed, so a plain lazy <img> without a referrer is used instead. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={`Photo attached to the ${title.toLowerCase()} report`}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={() => setImageFailed(true)}
                className="max-h-[28rem] w-full object-contain"
              />
              <figcaption className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-slate-400">
                Photo provided by the reporter
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-cyan-300 hover:underline"
                >
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                  Open
                </a>
              </figcaption>
            </figure>
          )}

          <div className="mt-6 flex flex-wrap items-start gap-3 border-t border-slate-700/60 pt-5">
            <UpvoteButton
              incident={incident}
              onChange={onUpvoted}
              callbackPath={`/incidents/${encodeURIComponent(id)}`}
              disabledReason={actionsDisabledReason}
            />
            <button type="button" onClick={share} className={secondaryAction}>
              <Share2 aria-hidden="true" className="size-4" />
              {shareState === "copied" ? "Link copied" : shareState === "failed" ? "Couldn't share" : "Share"}
            </button>
            {isReporter && (
              <button
                type="button"
                onClick={() => void changeStatus(resolved ? "open" : "resolved")}
                disabled={statusPending || savedCopy}
                title={actionsDisabledReason ?? undefined}
                className={cn(
                  secondaryAction,
                  !resolved && "border-emerald-500/50 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20",
                )}
              >
                {statusPending ? (
                  <Spinner size="sm" label="Updating status" className="text-current" />
                ) : resolved ? (
                  <RotateCcw aria-hidden="true" className="size-4" />
                ) : (
                  <CheckCircle2 aria-hidden="true" className="size-4" />
                )}
                {resolved ? "Reopen" : "Mark resolved"}
              </button>
            )}
          </div>
          {savedCopy && <p className="mt-2 text-xs text-amber-200/90">{SAVED_COPY_ACTION_HINT}</p>}
          <p className="sr-only" aria-live="polite">
            {shareState === "copied" ? "Link copied to the clipboard." : ""}
          </p>
          {statusError && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{statusError}</AlertDescription>
            </Alert>
          )}
          {incident.verified ? (
            <p className="mt-4 text-xs text-slate-500">
              Verified: several people nearby have confirmed this report.
            </p>
          ) : (
            <p className="mt-4 text-xs text-slate-500">
              Seen it too? Confirm it — reports become verified once enough people confirm them.
            </p>
          )}
        </article>

        <aside className="space-y-4 lg:col-span-2" aria-label="Location">
          <div className="overflow-hidden rounded-3xl border border-slate-700/80 bg-slate-900/60 backdrop-blur-md">
            <div className="h-72">
              <ErrorBoundary compact title="The map couldn't be displayed" resetKeys={[incident.id]}>
                <IncidentMap incident={incident} userLocation={viewer} />
              </ErrorBoundary>
            </div>
            <div className="space-y-3 p-4">
              <p className="text-sm text-slate-300">
                <MapPin aria-hidden="true" className="mr-1 inline size-4 text-slate-500" />
                {formatCoordinates(incident.lat, incident.lon, 5)}
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${incident.lat},${incident.lon}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={secondaryAction}
                >
                  <Navigation aria-hidden="true" className="size-4" />
                  Directions
                </a>
                <a href={mapsLink(incident.lat, incident.lon)} target="_blank" rel="noopener noreferrer" className={secondaryAction}>
                  <ExternalLink aria-hidden="true" className="size-4" />
                  Google Maps
                </a>
                <Link href={mapHref(incident)} className={secondaryAction}>
                  <MapIcon aria-hidden="true" className="size-4" />
                  Relief map
                </Link>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-red-500/25 bg-red-950/20 p-4 text-sm text-slate-300">
            <p className="font-semibold text-white">Nearby and in danger?</p>
            <p className="mt-1">Move to safety first and call 112 (or your local emergency number).</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href="/sos"
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none"
              >
                <Siren aria-hidden="true" className="size-4" />
                SOS
              </Link>
              <Link href={reportIncidentHref(incident)} className={secondaryAction}>
                Report another incident here
              </Link>
            </div>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] lg:min-h-[calc(100dvh-4rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black text-white">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:py-12">
        <Link
          href={`/incidents?focus=${encodeURIComponent(id)}`}
          className="mb-6 inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold text-slate-300 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All incidents
        </Link>
        {justCreated && (
          <Alert variant="success" className="mb-6">
            <AlertTitle>Thank you — your report is live</AlertTitle>
            <AlertDescription>
              People nearby can now see it, and push subscribers in the area are being notified.
            </AlertDescription>
          </Alert>
        )}
        {content}
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" aria-live="polite" className="grid gap-6 lg:grid-cols-5">
      <span className="sr-only">Loading incident…</span>
      <div className="space-y-4 rounded-3xl border border-slate-700/80 bg-slate-900/60 p-6 lg:col-span-3">
        <div className="flex items-center gap-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-5 w-40 rounded-full" />
          </div>
        </div>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <div className="flex gap-3 pt-4">
          <Skeleton className="h-9 w-32 rounded-lg" />
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
      </div>
      <div className="space-y-4 lg:col-span-2">
        <Skeleton className="h-96 rounded-3xl" />
      </div>
    </div>
  );
}

export default IncidentDetail;
