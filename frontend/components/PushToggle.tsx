"use client";

import { Bell, BellOff, BellRing, LocateFixed, Smartphone } from "lucide-react";
import { SessionContext } from "next-auth/react";
import * as React from "react";
import useSWR from "swr";

import { ErrorState } from "@/components/ErrorState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage, isApiError, swrKeys } from "@/lib/api";
import { formatCoordinates } from "@/lib/format";
import {
  ALL_PUSH_TOPICS,
  DEFAULT_PUSH_RADIUS_KM,
  getPushStatus,
  isPushError,
  PUSH_RADIUS_OPTIONS_KM,
  type PushPreferences,
  type PushSupport,
  resyncSubscription,
  subscribe,
  unsubscribe,
} from "@/lib/push";
import type { LatLon, PushTopic, VapidKeyResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * On/off switch for web push alerts on this device, with radius and topic preferences.
 *
 * Handles every non-happy path inline (never `alert()`):
 * - unsupported browser / insecure context (with the iOS "Add to Home Screen" hint),
 * - push disabled on the backend (`GET /push/vapid-public-key` → `enabled: false`),
 * - notification permission denied or dismissed,
 * - backend / network failures (with retry).
 *
 * Location: uses `coords` when given, otherwise asks for the device location *after* the
 * notification permission was granted. Without a location the backend only delivers red
 * disaster alerts, and the UI says so.
 *
 * Account link: the subscription is re-posted once per browser session *and signed-in
 * identity*, so signing in links this device to the account (test notifications then reach
 * it) and a different user signing in on the same device re-links it.
 *
 * Topics: "Disaster alerts" is only offered when the server actually pushes them
 * (`disaster_alerts` in the VAPID key response; the GDACS poller may be switched off).
 *
 * Works with zero props (e.g. on the profile page).
 */

const TOPIC_LABELS: Record<PushTopic, { label: string; hint: string }> = {
  disasters: { label: "Disaster alerts", hint: "GDACS orange/red earthquakes, cyclones, floods…" },
  incidents: { label: "Nearby incidents", hint: "Reports from people around you" },
};

type Phase =
  | { kind: "checking" }
  | { kind: "unsupported"; support: Extract<PushSupport, { supported: false }> }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on"; prefs: PushPreferences | null };

type Busy = null | "enable" | "disable" | "update";

/**
 * The signed-in user's id, `null` when signed out, or `undefined` while the session is still
 * loading. Reads the NextAuth context directly so the toggle also renders (as signed out)
 * outside a `SessionProvider`, e.g. in isolated component tests.
 */
function useSessionIdentity(): string | null | undefined {
  const session = React.useContext(SessionContext);
  if (!session || session.status === "unauthenticated") return null;
  if (session.status === "loading") return undefined;
  return session.data?.user?.id ?? null;
}

/** One-shot geolocation with a hard deadline (the browser timeout excludes the prompt). */
function locateOnce(timeoutMs = 10_000): Promise<LatLon | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: LatLon | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      resolve(value);
    };
    const deadline = window.setTimeout(() => finish(null), timeoutMs + 5_000);
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => finish({ lat: position.coords.latitude, lon: position.coords.longitude }),
        () => finish(null),
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60_000 },
      );
    } catch {
      finish(null);
    }
  });
}

function unsupportedMessage(support: Extract<PushSupport, { supported: false }>): {
  title: string;
  body: string;
} {
  if (support.reason === "insecure") {
    return {
      title: "Secure connection required",
      body: "Push notifications only work when ResQ AI is opened over HTTPS.",
    };
  }
  if (support.iosNeedsInstall) {
    return {
      title: "Install ResQ AI to get notifications",
      body: "On iPhone and iPad, tap Share → “Add to Home Screen”, then open ResQ AI from your Home Screen and turn notifications on there.",
    };
  }
  return {
    title: "Not supported in this browser",
    body: "This browser can't receive push notifications. Try a recent version of Chrome, Edge, Firefox or Safari.",
  };
}

export interface PushToggleProps {
  /** Centre for nearby alerts. When omitted, the device location is requested on enable. */
  coords?: LatLon | null;
  className?: string;
}

export function PushToggle({ coords, className }: PushToggleProps) {
  const titleId = React.useId();
  const statusId = React.useId();
  const radiusId = React.useId();

  const [phase, setPhase] = React.useState<Phase>({ kind: "checking" });
  const [busy, setBusy] = React.useState<Busy>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [radiusKm, setRadiusKm] = React.useState<number>(DEFAULT_PUSH_RADIUS_KM);
  const [topics, setTopics] = React.useState<PushTopic[]>([...ALL_PUSH_TOPICS]);

  const vapid = useSWR<VapidKeyResponse>(
    phase.kind === "unsupported" ? null : swrKeys.vapidPublicKey(),
  );
  const { mutate: refreshVapid } = vapid;
  const serverEnabled = !!vapid.data?.enabled && !!vapid.data.public_key;
  // Older backends do not report it: assume disaster alerts are available.
  const disastersAvailable = vapid.data?.disaster_alerts !== false;
  const offeredTopics = React.useMemo<readonly PushTopic[]>(
    () => ALL_PUSH_TOPICS.filter((topic) => topic !== "disasters" || disastersAvailable),
    [disastersAvailable],
  );
  const identity = useSessionIdentity();

  const applyPrefs = React.useCallback((prefs: PushPreferences | null) => {
    if (!prefs) return;
    setRadiusKm(prefs.radiusKm);
    setTopics(prefs.topics);
  }, []);

  // Browser-side status (support, permission, existing subscription) — client only.
  React.useEffect(() => {
    let cancelled = false;
    getPushStatus()
      .then((status) => {
        if (cancelled) return;
        switch (status.state) {
          case "unsupported":
            setPhase({ kind: "unsupported", support: status.support });
            break;
          case "denied":
            setPhase({ kind: "denied" });
            break;
          case "subscribed":
            applyPrefs(status.prefs);
            setPhase({ kind: "on", prefs: status.prefs });
            break;
          default:
            setPhase({ kind: "off" });
        }
      })
      .catch((err: unknown) => {
        console.warn("[PushToggle] could not read push status", err);
        if (!cancelled) setPhase({ kind: "off" });
      });
    return () => {
      cancelled = true;
    };
  }, [applyPrefs]);

  // Once per session and identity, make sure the server knows this device's subscription
  // and links it to whoever is signed in now (waits until the session has loaded).
  const isOn = phase.kind === "on";
  React.useEffect(() => {
    if (isOn && serverEnabled && identity !== undefined) void resyncSubscription({ identity });
  }, [isOn, serverEnabled, identity]);

  const handleError = React.useCallback(
    (err: unknown, fallback: string) => {
      if (isPushError(err)) {
        switch (err.code) {
          case "denied":
            setPhase({ kind: "denied" });
            return;
          case "unsupported":
          case "insecure":
            setPhase({
              kind: "unsupported",
              support: { supported: false, reason: err.code === "insecure" ? "insecure" : "no_api", iosNeedsInstall: false },
            });
            return;
          case "disabled":
            void refreshVapid();
            break;
          default:
            break;
        }
        setError(err.message);
        return;
      }
      if (isApiError(err) && err.code === "not_configured") {
        void refreshVapid();
        setError("Push notifications aren't set up on this server yet.");
        return;
      }
      console.error("[PushToggle]", err);
      setError(getErrorMessage(err, fallback));
    },
    [refreshVapid],
  );

  const locate = React.useCallback(
    () => (coords ? Promise.resolve({ lat: coords.lat, lon: coords.lon }) : locateOnce()),
    [coords],
  );

  const noLocationNotice = disastersAvailable
    ? "We couldn't get your location, so you'll only receive red disaster alerts. Allow location access and choose “Update location” for nearby alerts."
    : "We couldn't get your location, so no nearby alerts can be matched yet. Allow location access and choose “Update location”.";

  const save = React.useCallback(
    async (mode: "enable" | "update", next: { radiusKm: number; topics: PushTopic[]; relocate: boolean }) => {
      if (!vapid.data?.public_key) return;
      setBusy(mode);
      setError(null);
      setNotice(null);
      const previous = phase.kind === "on" ? phase.prefs : null;
      const stored =
        previous && previous.lat !== undefined && previous.lon !== undefined
          ? { lat: previous.lat, lon: previous.lon }
          : null;
      // Never subscribe to a topic the server does not deliver.
      const wanted = next.topics.filter((topic) => offeredTopics.includes(topic));
      try {
        // Called straight from the click handler: the permission prompt stays in the gesture.
        const result = await subscribe({
          vapidPublicKey: vapid.data.public_key,
          radiusKm: next.radiusKm,
          topics: wanted.length ? wanted : [...offeredTopics],
          locate: next.relocate || !stored ? locate : () => Promise.resolve(stored),
          identity,
        });
        applyPrefs(result.prefs);
        setPhase({ kind: "on", prefs: result.prefs });
        if (result.prefs.lat === undefined) setNotice(noLocationNotice);
      } catch (err) {
        handleError(err, "Couldn't turn on notifications. Please try again.");
      } finally {
        setBusy(null);
      }
    },
    [applyPrefs, handleError, identity, locate, noLocationNotice, offeredTopics, phase, vapid.data?.public_key],
  );

  const disable = React.useCallback(async () => {
    setBusy("disable");
    setError(null);
    setNotice(null);
    try {
      await unsubscribe();
      setPhase({ kind: "off" });
    } catch (err) {
      handleError(err, "Couldn't turn off notifications. Please try again.");
    } finally {
      setBusy(null);
    }
  }, [handleError]);

  const toggle = () => {
    if (busy) return;
    if (phase.kind === "on") void disable();
    else void save("enable", { radiusKm, topics, relocate: true });
  };

  const changeRadius = (value: number) => {
    setRadiusKm(value);
    if (phase.kind === "on") void save("update", { radiusKm: value, topics, relocate: false });
  };

  // Topics the user effectively gets (a topic the server does not deliver never counts).
  const activeTopics = topics.filter((topic) => offeredTopics.includes(topic));

  const toggleTopic = (topic: PushTopic) => {
    if (!offeredTopics.includes(topic)) return;
    const next = activeTopics.includes(topic)
      ? activeTopics.filter((t) => t !== topic)
      : [...activeTopics, topic];
    if (next.length === 0) return; // at least one topic
    const ordered = ALL_PUSH_TOPICS.filter((t) => next.includes(t));
    setTopics(ordered);
    if (phase.kind === "on") void save("update", { radiusKm, topics: ordered, relocate: false });
  };

  // ---- render -------------------------------------------------------------------------

  const header = (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-10 shrink-0 items-center justify-center rounded-xl",
          isOn ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700/60 text-slate-300",
        )}
      >
        {isOn ? <BellRing className="size-5" /> : phase.kind === "denied" ? <BellOff className="size-5" /> : <Bell className="size-5" />}
      </span>
      <div className="min-w-0">
        <h2 id={titleId} className="text-base font-semibold text-white">
          Alert notifications
        </h2>
        <p className="mt-0.5 text-sm text-slate-400">
          Get notified about major disasters and incidents near you — even when ResQ AI is closed.
        </p>
      </div>
    </div>
  );

  let content: React.ReactNode;
  if (phase.kind === "checking" || (phase.kind !== "unsupported" && !vapid.data && !vapid.error)) {
    content = (
      <div role="status" aria-live="polite" className="mt-4 space-y-3">
        <span className="sr-only">Checking notification support…</span>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (phase.kind === "unsupported") {
    const message = unsupportedMessage(phase.support);
    content = (
      <Alert variant="info" className="mt-4" icon={<Smartphone />}>
        <AlertTitle>{message.title}</AlertTitle>
        <AlertDescription>{message.body}</AlertDescription>
      </Alert>
    );
  } else if (!vapid.data) {
    content = (
      <ErrorState
        compact
        className="mt-4"
        title="Couldn't check notification settings"
        message={getErrorMessage(vapid.error, "The server didn't respond.")}
        offline={isApiError(vapid.error) && vapid.error.isNetworkError}
        onRetry={() => void refreshVapid()}
      />
    );
  } else if (!serverEnabled) {
    content = (
      <div className="mt-4 space-y-3">
        <Alert variant="info">
          <AlertTitle>Notifications aren&apos;t available yet</AlertTitle>
          <AlertDescription>
            Push notifications aren&apos;t set up on this server. Check the Alerts page for the latest events.
          </AlertDescription>
        </Alert>
        {isOn && (
          <button
            type="button"
            onClick={() => void disable()}
            disabled={!!busy}
            className="text-xs font-semibold text-slate-300 underline-offset-2 hover:underline disabled:opacity-60"
          >
            Remove this device&apos;s old subscription
          </button>
        )}
      </div>
    );
  } else if (phase.kind === "denied") {
    content = (
      <Alert variant="warning" className="mt-4" icon={<BellOff />}>
        <AlertTitle>Notifications are blocked</AlertTitle>
        <AlertDescription>
          You&apos;ve blocked notifications for this site. Open your browser&apos;s site settings (the icon next to the
          address bar), allow notifications, then reload this page.
        </AlertDescription>
      </Alert>
    );
  } else {
    const prefs = phase.kind === "on" ? phase.prefs : null;
    const hasLocation = prefs?.lat !== undefined && prefs?.lon !== undefined;
    const statusText = isOn
      ? hasLocation
        ? `On for this device · alerts within ${prefs?.radiusKm ?? radiusKm} km of your saved location`
        : disastersAvailable
          ? "On for this device · red disaster alerts only (no location saved)"
          : "On for this device · no location saved yet"
      : "Off on this device";

    content = (
      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-700 bg-slate-900/40 px-4 py-3">
          <p
            id={statusId}
            role="status"
            title={hasLocation ? formatCoordinates(prefs?.lat, prefs?.lon) : undefined}
            className={cn("text-sm", isOn ? "text-emerald-200" : "text-slate-300")}
          >
            {busy === "enable"
              ? "Turning on…"
              : busy === "disable"
                ? "Turning off…"
                : busy === "update"
                  ? "Saving preferences…"
                  : statusText}
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={isOn}
            aria-labelledby={titleId}
            aria-describedby={statusId}
            onClick={toggle}
            disabled={!!busy}
            className={cn(
              "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 focus-visible:outline-none disabled:cursor-wait disabled:opacity-70",
              isOn ? "bg-emerald-500" : "bg-slate-600",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex size-6 items-center justify-center rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
                isOn ? "translate-x-5" : "translate-x-0",
              )}
            >
              {busy && busy !== "update" && <Spinner size="sm" label="Working" className="text-slate-500" />}
            </span>
          </button>
        </div>

        {notice && (
          <Alert variant="warning">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <fieldset className="space-y-3" disabled={!!busy}>
          <legend className="sr-only">Notification preferences</legend>
          <div className="grid gap-1.5">
            <Label htmlFor={radiusId}>Alert radius</Label>
            <Select
              id={radiusId}
              value={String(radiusKm)}
              onChange={(event) => changeRadius(Number(event.target.value))}
            >
              {PUSH_RADIUS_OPTIONS_KM.map((km) => (
                <option key={km} value={km}>
                  Within {km} km
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium text-slate-200">Notify me about</span>
            {ALL_PUSH_TOPICS.map((topic) => {
              const available = offeredTopics.includes(topic);
              const checked = available && activeTopics.includes(topic);
              const onlyOne = checked && activeTopics.length === 1;
              return (
                <label
                  key={topic}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border border-slate-700/70 px-3 py-2 text-sm transition-colors hover:border-slate-600",
                    (onlyOne || !available) && "cursor-not-allowed",
                    !available && "opacity-60",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={onlyOne || !available}
                    onChange={() => toggleTopic(topic)}
                    className="mt-0.5 size-4 accent-emerald-500"
                  />
                  <span>
                    <span className="block font-medium text-slate-100">{TOPIC_LABELS[topic].label}</span>
                    <span className="block text-xs text-slate-400">
                      {available
                        ? TOPIC_LABELS[topic].hint
                        : "Not available on this server yet (the disaster alert service is switched off)."}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {isOn && (
            <button
              type="button"
              onClick={() => void save("update", { radiusKm, topics: activeTopics, relocate: true })}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700/50 focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none disabled:opacity-60"
            >
              <LocateFixed aria-hidden="true" className="size-3.5" />
              Update location
            </button>
          )}
        </fieldset>
      </div>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className={cn("rounded-2xl border border-slate-700 bg-slate-800/50 p-5 backdrop-blur-md", className)}
    >
      {header}
      {content}
    </section>
  );
}

export default PushToggle;
