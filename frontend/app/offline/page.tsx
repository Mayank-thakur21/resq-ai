import {
  BatteryCharging,
  Flame,
  Flashlight,
  MapPinned,
  MessageSquareText,
  Phone,
  Siren,
  Waves,
  WifiOff,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { OfflineContacts } from "@/app/offline/_components/OfflineContacts";
import { RetryConnectionButton } from "@/app/offline/_components/RetryConnectionButton";

/**
 * `/offline` — static page precached by the service worker (`public/sw.js`) and shown for
 * any navigation that fails without a cached copy. It must work with zero network: no data
 * fetching, only `tel:` links, static tips and the contacts saved on this device.
 */

export const metadata: Metadata = {
  title: "Offline",
  description: "Emergency numbers, offline safety tips and your saved contacts — available without a connection.",
  robots: { index: false },
};

export const dynamic = "force-static";

interface EmergencyNumber {
  number: string;
  label: string;
  region: string;
}

const EMERGENCY_NUMBERS: readonly EmergencyNumber[] = [
  { number: "112", label: "Emergency", region: "International · EU · India" },
  { number: "108", label: "Ambulance", region: "India" },
  { number: "100", label: "Police", region: "India" },
  { number: "101", label: "Fire", region: "India" },
  { number: "911", label: "Emergency", region: "US · Canada" },
  { number: "999", label: "Emergency", region: "UK" },
];

const OFFLINE_TIPS = [
  {
    icon: Phone,
    title: "Calls can work without data",
    text: "112 connects on most mobile networks worldwide, often even without credit or a SIM card.",
  },
  {
    icon: MessageSquareText,
    title: "Text when calls fail",
    text: "SMS needs very little signal and is retried automatically. Keep messages short: who, where, what you need.",
  },
  {
    icon: MapPinned,
    title: "GPS works offline",
    text: "Your phone's maps app can still show your coordinates without internet — read them out or text them.",
  },
  {
    icon: BatteryCharging,
    title: "Save battery",
    text: "Turn on low-power mode, dim the screen and close apps. Switch on airplane mode between calls if signal is poor.",
  },
  {
    icon: Flashlight,
    title: "Signal for help",
    text: "Three whistle blasts, a flashlight or bright cloth help rescuers find you. Stay where you are if it is safe.",
  },
  {
    icon: Waves,
    title: "Flood",
    text: "Move to higher ground. Never walk or drive through moving water — 15 cm can knock you over.",
  },
  {
    icon: Siren,
    title: "Earthquake",
    text: "Drop, cover and hold on. Stay away from windows; after shaking stops, leave damaged buildings carefully.",
  },
  {
    icon: Flame,
    title: "Fire or smoke",
    text: "Stay low under smoke, feel doors for heat before opening, and never use lifts.",
  },
] as const;

const linkButton =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none";

export default function OfflinePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black pb-12 text-white">
      <div className="mx-auto max-w-4xl space-y-8 px-4 pt-8 lg:pt-12">
        <header className="space-y-4 text-center">
          <span
            aria-hidden="true"
            className="mx-auto inline-flex size-16 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/15 text-amber-300"
          >
            <WifiOff className="size-8" />
          </span>
          <h1 className="text-3xl font-extrabold tracking-tight md:text-4xl">You&apos;re offline</h1>
          <p className="mx-auto max-w-2xl text-slate-300">
            ResQ AI can&apos;t reach the internet right now. Emergency calls and text messages usually still work —
            everything on this page is available without a connection.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <RetryConnectionButton />
            <Link href="/contacts" className={`${linkButton} border border-slate-600 text-slate-100 hover:bg-slate-800`}>
              Saved contacts
            </Link>
            <Link href="/sos" className={`${linkButton} bg-red-600 text-white hover:bg-red-500`}>
              <Siren aria-hidden="true" className="size-4" />
              SOS
            </Link>
          </div>
        </header>

        <section aria-labelledby="emergency-numbers" className="space-y-3">
          <h2 id="emergency-numbers" className="text-xl font-bold">
            Emergency numbers
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {EMERGENCY_NUMBERS.map((entry) => (
              <li key={`${entry.number}-${entry.region}`}>
                <a
                  href={`tel:${entry.number}`}
                  aria-label={`Call ${entry.number}, ${entry.label}, ${entry.region}`}
                  className="flex h-full flex-col rounded-2xl border border-red-500/30 bg-red-600/15 p-4 transition-colors hover:bg-red-600/25 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none"
                >
                  <span className="flex items-center gap-2 text-3xl font-extrabold tracking-wider text-white">
                    <Phone aria-hidden="true" className="size-5 text-red-300" />
                    {entry.number}
                  </span>
                  <span className="mt-1 text-sm font-semibold text-red-100">{entry.label}</span>
                  <span className="text-xs text-slate-400">{entry.region}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <OfflineContacts />

        <section aria-labelledby="offline-tips" className="space-y-3">
          <h2 id="offline-tips" className="text-xl font-bold">
            What works without internet
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {OFFLINE_TIPS.map(({ icon: Icon, title, text }) => (
              <li
                key={title}
                className="flex gap-3 rounded-2xl border border-slate-700 bg-slate-800/50 p-4 backdrop-blur-md"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-700/60 text-cyan-300"
                >
                  <Icon className="size-5" />
                </span>
                <div>
                  <h3 className="font-semibold text-white">{title}</h3>
                  <p className="mt-0.5 text-sm text-slate-300">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
