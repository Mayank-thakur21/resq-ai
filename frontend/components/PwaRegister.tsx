"use client";

import { RefreshCw, Wifi, WifiOff, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { isResqServiceWorker, serviceWorkerUrl } from "@/lib/sw-url";
import { cn } from "@/lib/utils";

/**
 * PWA runtime glue, rendered once by the root layout:
 *
 * 1. Registers the hand-written service worker as `/sw.js?v=<build id>` (scope `/`) after
 *    page load — in production, or in development when `NEXT_PUBLIC_ENABLE_SW_IN_DEV=true`.
 *    The build id makes every deploy install a fresh worker that re-warms the offline pages
 *    (see `lib/sw-url.ts`). In development without the opt-in, a previously installed ResQ
 *    worker is unregistered so stale caches can't mask code changes.
 * 2. Shows an "Update available — Reload" toast when a new worker is waiting. Reload posts
 *    `{type: "SKIP_WAITING"}` to it and reloads once it takes control.
 * 3. Shows a short "Back online" note from the browser's online/offline events. The
 *    "You're offline" banner itself is {@link OfflineBanner}, rendered by the layout right
 *    under the navbar *in the page flow*, so it pushes the page down instead of covering
 *    its first lines (as a fixed overlay did).
 *
 * Everything is best-effort: registration failures are logged, never shown as errors.
 */

/** Versioned script URL registered by this build (`/sw.js?v=<build id>`). */
export const SERVICE_WORKER_URL = serviceWorkerUrl();
/** Check for a new worker at most this often when the tab becomes visible again. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const BACK_ONLINE_NOTICE_MS = 4000;
/** Reload anyway if the new worker hasn't taken control after this long. */
const CONTROLLER_CHANGE_TIMEOUT_MS = 4000;

/** Whether this build should run the service worker (read at call time for tests). */
export function isServiceWorkerEnabled(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_SW_IN_DEV === "true";
}

function hasServiceWorkerApi(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && !!navigator.serviceWorker;
}

function workerScript(registration: ServiceWorkerRegistration): string {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  return worker?.scriptURL ?? "";
}

/** Dev only: remove a ResQ worker left over from a production run on the same origin. */
async function unregisterStaleWorkers(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const stale = registrations.filter((registration) => isResqServiceWorker(workerScript(registration)));
    if (stale.length === 0) return;
    await Promise.all(stale.map((registration) => registration.unregister()));
    console.info(
      "[pwa] unregistered the ResQ service worker (disabled in development; set NEXT_PUBLIC_ENABLE_SW_IN_DEV=true to test it)",
    );
  } catch (error) {
    console.warn("[pwa] could not inspect service worker registrations", error);
  }
}

/** Online/offline state from browser events. SSR and the first render assume online. */
function useOnlineStatus(): { online: boolean; backOnline: boolean } {
  const [online, setOnline] = React.useState(true);
  const [backOnline, setBackOnline] = React.useState(false);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (isOnline: boolean, fromEvent: boolean) => {
      setOnline(isOnline);
      if (timer) clearTimeout(timer);
      if (isOnline && fromEvent) {
        setBackOnline(true);
        timer = setTimeout(() => setBackOnline(false), BACK_ONLINE_NOTICE_MS);
      } else {
        setBackOnline(false);
      }
    };
    update(typeof navigator === "undefined" || navigator.onLine !== false, false);
    const onOnline = () => update(true, true);
    const onOffline = () => update(false, true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return { online, backOnline };
}

/** Registers the service worker and exposes a worker waiting to activate (if any). */
function useServiceWorker(): { waiting: ServiceWorker | null; applyUpdate: () => void; dismiss: () => void } {
  const [waiting, setWaiting] = React.useState<ServiceWorker | null>(null);
  const updateRequestedRef = React.useRef(false);
  const reloadingRef = React.useRef(false);

  React.useEffect(() => {
    if (!hasServiceWorkerApi()) return;
    if (!isServiceWorkerEnabled()) {
      void unregisterStaleWorkers();
      return;
    }

    let cancelled = false;
    let registration: ServiceWorkerRegistration | undefined;
    let lastUpdateCheck = Date.now();
    const container = navigator.serviceWorker;

    const offerUpdate = (worker: ServiceWorker | null | undefined) => {
      // Only an *update* needs the prompt: on first install there is no controller yet.
      if (!cancelled && worker && container.controller) setWaiting(worker);
    };

    const trackInstalling = (worker: ServiceWorker) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") offerUpdate(worker);
      });
    };

    const onUpdateFound = () => {
      if (registration?.installing) trackInstalling(registration.installing);
    };

    const checkForUpdate = () => {
      lastUpdateCheck = Date.now();
      registration?.update().catch((error: unknown) => {
        console.debug("[pwa] update check failed", error);
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && Date.now() - lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS) {
        checkForUpdate();
      }
    };

    const onControllerChange = () => {
      // Reload only when the user asked for the update (not on the first install's claim()).
      if (!updateRequestedRef.current || reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };

    const register = async () => {
      try {
        registration = await container.register(SERVICE_WORKER_URL, { scope: "/", updateViaCache: "none" });
        if (cancelled) return;
        offerUpdate(registration.waiting);
        if (registration.installing) trackInstalling(registration.installing);
        registration.addEventListener("updatefound", onUpdateFound);
      } catch (error) {
        console.warn("[pwa] service worker registration failed", error);
      }
    };

    const onLoad = () => void register();
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", onLoad, { once: true });

    container.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.removeEventListener("load", onLoad);
      container.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      registration?.removeEventListener("updatefound", onUpdateFound);
    };
  }, []);

  const applyUpdate = React.useCallback(() => {
    if (!waiting) return;
    updateRequestedRef.current = true;
    try {
      waiting.postMessage({ type: "SKIP_WAITING" });
    } catch (error) {
      console.warn("[pwa] could not message the waiting service worker", error);
    }
    // Safety net: some browsers never fire controllerchange for an already-open tab.
    setTimeout(() => {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    }, CONTROLLER_CHANGE_TIMEOUT_MS);
  }, [waiting]);

  const dismiss = React.useCallback(() => setWaiting(null), []);

  return { waiting, applyUpdate, dismiss };
}

/**
 * "You're offline" banner. Rendered by the root layout between the navbar and `<main>`:
 * sticky under the navbar but part of the page flow, so while it is shown the page starts
 * below it instead of under it.
 */
export function OfflineBanner() {
  const { online } = useOnlineStatus();
  if (online) return null;

  return (
    <div
      data-slot="offline-banner"
      className="sticky top-14 z-30 flex justify-center px-3 pt-2 lg:top-16 print:hidden"
    >
      <div
        role="status"
        className="flex w-full max-w-xl items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-950/90 px-4 py-2.5 text-sm text-amber-100 shadow-lg shadow-black/40 backdrop-blur-md animate-in fade-in slide-in-from-top-2 motion-reduce:animate-none"
      >
        <WifiOff aria-hidden="true" className="size-4 shrink-0 text-amber-300" />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">You&apos;re offline.</span> Saved contacts and emergency numbers still
          work.
        </p>
        <Link
          href="/offline"
          className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-amber-200 underline underline-offset-2 hover:text-white focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:outline-none"
        >
          Offline help
        </Link>
      </div>
    </div>
  );
}

export default function PwaRegister() {
  const { online, backOnline } = useOnlineStatus();
  const { waiting, applyUpdate, dismiss } = useServiceWorker();
  const [applying, setApplying] = React.useState(false);

  if (!(online && backOnline) && !waiting) return null;

  return (
    <div
      data-slot="pwa-status"
      className="pointer-events-none fixed inset-x-0 top-14 z-30 flex flex-col items-center gap-2 px-3 pt-2 lg:top-16 print:hidden"
    >
      {online && backOnline && (
        <div
          role="status"
          className="pointer-events-auto flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-950/90 px-4 py-1.5 text-sm font-medium text-emerald-100 shadow-lg shadow-black/40 backdrop-blur-md animate-in fade-in motion-reduce:animate-none"
        >
          <Wifi aria-hidden="true" className="size-4 text-emerald-300" />
          Back online
        </div>
      )}
      {waiting && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border border-blue-500/40 bg-slate-900/95 px-4 py-3 text-sm text-slate-100 shadow-xl shadow-black/50 backdrop-blur-md",
            "animate-in fade-in slide-in-from-top-2 motion-reduce:animate-none",
          )}
        >
          <RefreshCw aria-hidden="true" className="size-4 shrink-0 text-blue-300" />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">Update available.</span> Reload to get the latest version.
          </p>
          <button
            type="button"
            disabled={applying}
            onClick={() => {
              setApplying(true);
              applyUpdate();
            }}
            className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none disabled:opacity-70"
          >
            {applying ? "Reloading…" : "Reload"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss update notice"
            className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
