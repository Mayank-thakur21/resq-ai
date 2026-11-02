"use client";

import { Siren } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Floating red SOS button (rendered once by the root layout) linking to `/sos`.
 *
 * - Hidden on `/sos` itself (and its sub-routes).
 * - Hidden below `lg` on `/chat` and `/map`: on `/chat` the message composer sits at the
 *   bottom-right; on `/map` the button would cover the OpenStreetMap attribution (which the
 *   tile policy requires to stay visible). The mobile tab bar already has a prominent SOS
 *   button right below in both cases.
 * - Placed above the mobile bottom tab bar (`h-16` + safe-area inset) and under the navbar
 *   layer (`z-30` < `z-40`), so the navbar's "More" sheet and dialogs cover it.
 * - The attention pulse uses `motion-safe:` so it is off for `prefers-reduced-motion`.
 */

/** Routes (and their children) where the FAB is never shown. */
const HIDDEN_ROUTES = ["/sos"];
/** Routes where the FAB is shown on large screens only. */
const DESKTOP_ONLY_ROUTES = ["/chat", "/map"];

function matches(pathname: string | null, routes: readonly string[]): boolean {
  if (!pathname) return false;
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** Exported for tests: whether the FAB renders at all for a pathname. */
export function isSOSFabVisible(pathname: string | null): boolean {
  return !matches(pathname, HIDDEN_ROUTES);
}

export default function SOSFab() {
  const pathname = usePathname();
  if (!isSOSFabVisible(pathname)) return null;
  const desktopOnly = matches(pathname, DESKTOP_ONLY_ROUTES);

  return (
    <Link
      href="/sos"
      aria-label="SOS — send an emergency alert with your location"
      title="Emergency SOS"
      data-slot="sos-fab"
      className={cn(
        "group fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 items-center justify-center rounded-full lg:right-6 lg:bottom-6",
        "size-14 bg-gradient-to-br from-red-500 to-red-700 text-white shadow-xl shadow-red-900/50 ring-2 ring-red-300/30",
        "transition-transform duration-150 hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100",
        "focus-visible:ring-4 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 focus-visible:outline-none",
        "print:hidden",
        desktopOnly ? "hidden lg:flex" : "flex",
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-red-500/40 motion-safe:animate-ping motion-safe:[animation-duration:2s]"
      />
      <span className="relative flex flex-col items-center leading-none">
        <Siren aria-hidden="true" className="size-5" />
        <span className="mt-0.5 text-[10px] font-extrabold tracking-wider">SOS</span>
      </span>
    </Link>
  );
}
