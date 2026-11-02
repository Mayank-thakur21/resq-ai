"use client";

import { RefreshCw, Wifi } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/** ASCII control characters (incl. TAB/CR/LF, which the URL parser silently drops) and "\\". */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f\\]/;

function currentOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "http://localhost";
}

/**
 * Where "Try again" should go. The service worker redirects failed navigations to
 * `/offline?from=<path>`; only paths that resolve to **this origin** are accepted, and
 * without a usable `from` the home page is used.
 *
 * The check resolves `from` against the origin and compares origins instead of looking at
 * prefixes only: the WHATWG URL parser strips TAB/CR/LF, so `/%09/evil.example` would
 * otherwise pass a "starts with / but not //" test and still navigate to
 * `//evil.example` (open redirect from a genuine ResQ link).
 */
export function retryTarget(search: string, origin: string = currentOrigin()): string {
  let from: string | null = null;
  try {
    from = new URLSearchParams(search).get("from");
  } catch {
    from = null;
  }
  if (!from || !from.startsWith("/") || UNSAFE_PATH_CHARS.test(from)) return "/";
  let url: URL;
  let base: URL;
  try {
    base = new URL(origin);
    url = new URL(from, base);
  } catch {
    return "/";
  }
  if (url.origin !== base.origin) return "/";
  if (url.pathname === "/offline") return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * "Try again" for the offline page: returns to the page the user wanted (see
 * {@link retryTarget}). When the browser reports the connection is back the button is
 * highlighted — never an automatic reload, the user may be reading instructions.
 */
export function RetryConnectionButton() {
  const [retrying, setRetrying] = React.useState(false);
  const [online, setOnline] = React.useState(false);

  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", update);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const retry = () => {
    setRetrying(true);
    if (window.location.pathname === "/offline") window.location.assign(retryTarget(window.location.search));
    else window.location.reload();
  };

  const Icon = online && !retrying ? Wifi : RefreshCw;
  return (
    <button
      type="button"
      onClick={retry}
      disabled={retrying}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 focus-visible:outline-none disabled:opacity-70",
        online ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400" : "bg-slate-100 text-slate-900 hover:bg-white",
      )}
    >
      <Icon aria-hidden="true" className={cn("size-4", retrying && "animate-spin motion-reduce:animate-none")} />
      {retrying ? "Reconnecting…" : online ? "Back online — reload" : "Try again"}
    </button>
  );
}

export default RetryConnectionButton;
