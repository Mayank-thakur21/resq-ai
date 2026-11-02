"use client";

import { motion, MotionConfig } from "framer-motion";
import {
  Bell,
  Info,
  ListChecks,
  LocateFixed,
  type LucideIcon,
  Map as MapIcon,
  PhoneCall,
  ShieldAlert,
  Siren,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AlertBanner } from "@/components/AlertBanner";
import { DisasterFeed } from "@/components/DisasterFeed";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { WeatherCard } from "@/components/WeatherCard";
import { DEFAULT_COORDS, type GeolocationState, offlineFallbackFix, useGeolocation } from "@/lib/geo";
import type { LatLon } from "@/lib/types";

const safetyTips = [
  "Store at least 3 days of drinking water (1 gallon per person per day).",
  "Keep a printed copy of emergency contacts.",
  "Identify safe spots in your home for earthquakes (under sturdy furniture).",
  "Have a battery-powered radio and extra batteries.",
  "Create an evacuation plan and practice it with your family.",
];

interface ActionTile {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Full class strings (Tailwind needs static names). */
  tone: string;
  iconTone: string;
}

const ACTION_TILES: readonly ActionTile[] = [
  {
    href: "/chat",
    title: "Emergency AI Chat",
    description: "Talk to our multi-agent AI for immediate life-saving protocols and situational awareness.",
    icon: ShieldAlert,
    tone: "bg-red-600/20 hover:bg-red-600/30 border-red-500/30",
    iconTone: "text-red-400",
  },
  {
    href: "/map",
    title: "Live Relief Map",
    description: "Locate nearby hospitals, shelters, fire stations, and police dynamically.",
    icon: MapIcon,
    tone: "bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/30",
    iconTone: "text-blue-400",
  },
  {
    href: "/alerts",
    title: "Disaster Alerts",
    description: "Live GDACS earthquakes, cyclones, floods and wildfires, plus humanitarian news and push alerts.",
    icon: Bell,
    tone: "bg-amber-600/20 hover:bg-amber-600/30 border-amber-500/30",
    iconTone: "text-amber-400",
  },
  {
    href: "/incidents",
    title: "Community Incidents",
    description: "See and report floods, fires and accidents near you, verified by the community.",
    icon: TriangleAlert,
    tone: "bg-orange-600/20 hover:bg-orange-600/30 border-orange-500/30",
    iconTone: "text-orange-400",
  },
  {
    href: "/checklist",
    title: "Smart Checklists",
    description: "Interactive preparedness checklists for floods, earthquakes, fires and more.",
    icon: ListChecks,
    tone: "bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/30",
    iconTone: "text-emerald-400",
  },
  {
    href: "/contacts",
    title: "Emergency Contacts",
    description: "Keep critical contacts offline on this device, ready for SOS messages.",
    icon: PhoneCall,
    tone: "bg-purple-600/20 hover:bg-purple-600/30 border-purple-500/30",
    iconTone: "text-purple-400",
  },
];

/** How long to wait for a location fix before showing data for the default location. */
const LOCATION_GRACE_MS = 6_000;

interface HomeLocation {
  geo: GeolocationState;
  /** Coordinates to query with; `null` while still waiting for the first fix. */
  coords: LatLon | null;
  isDefault: boolean;
  /** Offline without a fix: the last known location is used (see `offlineFallbackFix`). */
  isLastKnown: boolean;
  /** Still locating, and not yet showing anything. */
  waiting: boolean;
}

/**
 * Device location with a grace period: while the permission prompt is open the browser's
 * own timeout does not run, so after {@link LOCATION_GRACE_MS} we fall back to
 * DEFAULT_COORDS (with a visible notice). A fix arriving later replaces the default.
 */
function useHomeLocation(): HomeLocation {
  const geo = useGeolocation({ timeoutMs: 10_000 });
  const [graceExpired, setGraceExpired] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setGraceExpired(true), LOCATION_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const settled = geo.status !== "idle" && geo.status !== "locating";
  if (geo.coords) {
    return {
      geo,
      coords: { lat: geo.coords.lat, lon: geo.coords.lon },
      isDefault: false,
      isLastKnown: false,
      waiting: false,
    };
  }
  if (settled || graceExpired) {
    const lastKnown = offlineFallbackFix(geo, graceExpired);
    if (lastKnown) {
      return {
        geo,
        coords: { lat: lastKnown.lat, lon: lastKnown.lon },
        isDefault: false,
        isLastKnown: true,
        waiting: false,
      };
    }
    return {
      geo,
      coords: { lat: DEFAULT_COORDS.lat, lon: DEFAULT_COORDS.lon },
      isDefault: true,
      isLastKnown: false,
      waiting: false,
    };
  }
  return { geo, coords: null, isDefault: false, isLastKnown: false, waiting: true };
}

export default function Home() {
  const [tipIndex, setTipIndex] = useState(0);
  const location = useHomeLocation();
  const { geo, coords, isDefault } = location;

  useEffect(() => {
    // Randomize tip on load (after hydration, so server and client markup match).
    setTipIndex(Math.floor(Math.random() * safetyTips.length));
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen overflow-hidden bg-gradient-to-b from-slate-900 via-slate-800 to-black pb-12 text-white">
        {/* Live alert banner (hidden when nothing relevant is active) */}
        <ErrorBoundary fallback={() => null} onError={(error) => console.error("[home] alert banner crashed", error)}>
          <AlertBanner coords={coords} isDefaultLocation={isDefault} weatherHref="#weather" />
        </ErrorBoundary>

        <div className="container mx-auto px-4 pt-12 lg:pt-20">
          {/* Hero Section */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.6 }}
            className="mx-auto mb-12 max-w-4xl text-center"
          >
            <h1 className="mb-6 bg-gradient-to-r from-blue-400 via-cyan-300 to-emerald-400 bg-clip-text text-5xl font-extrabold tracking-tight text-transparent drop-shadow-sm md:text-7xl">
              ResQ AI
            </h1>
            <p className="mx-auto max-w-2xl text-xl leading-relaxed font-light text-slate-300 md:text-2xl">
              Your intelligent disaster response platform. Real-time guidance, offline maps, and multi-agent AI
              assistance.
            </p>
          </motion.div>

          {/* Location status */}
          <div className="mx-auto mb-6 max-w-6xl">
            {location.waiting && (
              <Spinner size="sm" showLabel label="Finding your location…" className="text-xs text-slate-400" />
            )}
            {location.isLastKnown && (
              <Alert variant="info" icon={<LocateFixed />}>
                <AlertDescription>
                  You&apos;re offline — showing saved information for your last known location.
                </AlertDescription>
              </Alert>
            )}
            {isDefault && (
              <Alert variant="info" icon={<LocateFixed />}>
                <AlertTitle>Using default location — enable location for local results</AlertTitle>
                <AlertDescription>
                  {geo.status === "locating"
                    ? "Still waiting for your location… "
                    : geo.error
                      ? `${geo.error} `
                      : ""}
                  {geo.status !== "locating" && (
                    <button
                      type="button"
                      onClick={geo.retry}
                      className="font-semibold text-blue-200 underline underline-offset-2 hover:text-white focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none"
                    >
                      Use my location
                    </button>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* Dashboard Grid */}
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Main Actions (Left/Center) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-8">
              <SOSTile />
              {ACTION_TILES.map((tile) => (
                <ActionTileLink key={tile.href} tile={tile} />
              ))}
            </div>

            {/* Info Panels (Right) */}
            <div className="flex flex-col gap-4 lg:col-span-4">
              <ErrorBoundary title="Weather is unavailable" compact resetKeys={[coords?.lat, coords?.lon]}>
                <WeatherCard id="weather" coords={coords} isDefaultLocation={isDefault} />
              </ErrorBoundary>

              {/* Daily Tip */}
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 }}
                className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-900/40 to-blue-900/40 p-6 backdrop-blur-md"
              >
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wider text-indigo-300 uppercase">
                  <Info aria-hidden="true" className="size-4" /> Preparedness Tip
                </h2>
                <p className="text-sm leading-relaxed text-slate-200 italic">&quot;{safetyTips[tipIndex]}&quot;</p>
              </motion.div>

              <ErrorBoundary title="News is unavailable" compact>
                <DisasterFeed className="flex-grow" />
              </ErrorBoundary>
            </div>
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}

function ActionTileLink({ tile }: { tile: ActionTile }) {
  const Icon = tile.icon;
  return (
    <Link
      href={tile.href}
      className="group rounded-2xl focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 focus-visible:outline-none"
    >
      <motion.div
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className={`relative h-full overflow-hidden rounded-2xl border p-6 backdrop-blur-md transition-colors ${tile.tone}`}
      >
        <div aria-hidden="true" className="absolute -top-4 -right-4 opacity-10 transition-transform group-hover:scale-110">
          <Icon size={120} />
        </div>
        <Icon aria-hidden="true" className={`mb-4 h-10 w-10 ${tile.iconTone}`} />
        <h2 className="mb-2 text-2xl font-bold">{tile.title}</h2>
        <p className="text-sm text-slate-300">{tile.description}</p>
      </motion.div>
    </Link>
  );
}

/** Prominent full-width SOS tile with a direct "Call 112" fallback. */
function SOSTile() {
  return (
    <div className="relative flex items-center overflow-hidden rounded-2xl border border-red-400/40 bg-gradient-to-br from-red-600 to-red-800 shadow-lg shadow-red-900/40 sm:col-span-2">
      <div aria-hidden="true" className="absolute -top-6 -right-6 opacity-15">
        <Siren size={140} />
      </div>
      <div className="relative flex w-full flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href="/sos"
          className="group flex flex-1 items-center gap-4 rounded-xl focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
        >
          <span className="relative inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-white/15">
            <span
              aria-hidden="true"
              className="absolute inline-flex size-full animate-ping rounded-full bg-white/20 motion-reduce:animate-none"
            />
            <Siren aria-hidden="true" className="relative size-7 text-white" />
          </span>
          <span>
            <span className="block text-2xl font-extrabold tracking-tight">Send SOS</span>
            <span className="block text-sm text-red-100">
              Share your live location with your emergency contacts in seconds.
            </span>
          </span>
        </Link>
        <a
          href="tel:112"
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/30 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
        >
          <PhoneCall aria-hidden="true" className="size-4" />
          Call 112
        </a>
      </div>
    </div>
  );
}
