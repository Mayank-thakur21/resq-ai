"use client";

import { Download, Share, SquarePlus, X } from "lucide-react";
import { usePathname } from "next/navigation";
import * as React from "react";

import { isIOS, isStandalone } from "@/lib/push";
import { cn } from "@/lib/utils";

/**
 * "Install ResQ AI" card (rendered once by the root layout).
 *
 * - Chromium browsers: captures `beforeinstallprompt` (suppressing the default mini-infobar)
 *   and shows a dismissible card whose "Install" button opens the native install dialog.
 * - iOS / iPadOS: there is no install event, so after a short delay a hint explains
 *   Share → "Add to Home Screen" (also required there for push notifications).
 * - Never shown when already running as an installed app, on `/sos` and `/offline` (no
 *   distractions in an emergency), or within 30 days of the user dismissing it.
 */

/** Chromium's install prompt event (not in the TypeScript DOM lib). */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export const INSTALL_DISMISSED_STORAGE_KEY = "resq_install_dismissed_at";
const DISMISS_FOR_MS = 30 * 24 * 60 * 60 * 1000;
/** Let the user see the app before suggesting installation on iOS. */
const IOS_HINT_DELAY_MS = 15_000;
const HIDDEN_ROUTES = ["/sos", "/offline"];

/** True when the card was dismissed less than 30 days ago. Never throws. */
export function wasRecentlyDismissed(now = Date.now()): boolean {
  try {
    const raw = window.localStorage.getItem(INSTALL_DISMISSED_STORAGE_KEY);
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) && now - at < DISMISS_FOR_MS;
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    window.localStorage.setItem(INSTALL_DISMISSED_STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage unavailable: the card may show again next visit, which is acceptable.
  }
}

type Mode = "hidden" | "prompt" | "ios";

export default function InstallPrompt() {
  const pathname = usePathname();
  const titleId = React.useId();
  const [mode, setMode] = React.useState<Mode>("hidden");
  const [installing, setInstalling] = React.useState(false);
  const deferredRef = React.useRef<BeforeInstallPromptEvent | null>(null);

  React.useEffect(() => {
    if (isStandalone() || wasRecentlyDismissed()) return;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredRef.current = event as BeforeInstallPromptEvent;
      setMode("prompt");
    };
    const onInstalled = () => {
      deferredRef.current = null;
      setMode("hidden");
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (isIOS()) {
      timer = setTimeout(() => setMode((current) => (current === "hidden" ? "ios" : current)), IOS_HINT_DELAY_MS);
    }

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    rememberDismissal();
    setMode("hidden");
  };

  const install = async () => {
    const deferred = deferredRef.current;
    if (!deferred) {
      setMode("hidden");
      return;
    }
    setInstalling(true);
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === "dismissed") rememberDismissal();
    } catch (error) {
      console.warn("[pwa] install prompt failed", error);
    } finally {
      // A captured prompt can only be used once.
      deferredRef.current = null;
      setInstalling(false);
      setMode("hidden");
    }
  };

  const hiddenHere = !!pathname && HIDDEN_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  if (mode === "hidden" || hiddenHere) return null;

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-slot="install-prompt"
      className={cn(
        "fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-3 right-20 z-30 rounded-2xl border border-slate-700 bg-slate-900/95 p-4 text-slate-100 shadow-2xl shadow-black/60 backdrop-blur-md",
        "sm:right-auto sm:w-96 lg:bottom-6 lg:left-6",
        "animate-in fade-in slide-in-from-bottom-4 motion-reduce:animate-none print:hidden",
      )}
    >
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny static icon, no optimisation needed */}
        <img src="/icons/icon-192.png" alt="" width={44} height={44} className="size-11 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold text-white">
            Install ResQ AI
          </h2>
          {mode === "prompt" ? (
            <p className="mt-0.5 text-sm text-slate-300">
              Add it to your home screen for one-tap SOS and offline access to your emergency contacts.
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-slate-300">
              Tap <Share aria-hidden="true" className="inline size-4 align-text-bottom text-blue-300" /> Share, then{" "}
              <span className="whitespace-nowrap font-semibold text-white">
                <SquarePlus aria-hidden="true" className="inline size-4 align-text-bottom" /> Add to Home Screen
              </span>{" "}
              for one-tap SOS, offline contacts and alert notifications.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install suggestion"
          className="-mt-1 -mr-1 shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {mode === "prompt" && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={() => void install()}
            disabled={installing}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-red-900/40 transition-colors hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none disabled:opacity-70"
          >
            <Download aria-hidden="true" className="size-4" />
            {installing ? "Installing…" : "Install"}
          </button>
        </div>
      )}
    </section>
  );
}
