import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What ResQ AI stores (SOS events, incident reports, push subscriptions, accounts), for how long, who can see it, and which services receive your data.",
};

/**
 * `/privacy` — the privacy statement linked from the footer on every page.
 *
 * Keep it in sync with what the backend actually persists (`backend/app/db/models.py`) and
 * with the device storage listed in the README ("Browser storage").
 */

interface Section {
  id: string;
  title: string;
  body: React.ReactNode;
}

const listClass = "mt-3 list-disc space-y-2 pl-5 marker:text-slate-500";

const SECTIONS: readonly Section[] = [
  {
    id: "summary",
    title: "In short",
    body: (
      <ul className={listClass}>
        <li>
          Your <strong>location</strong> is used to find nearby help, weather and alerts. It is only{" "}
          <strong>stored</strong> when you send an SOS, report an incident or turn on nearby push notifications (details
          below).
        </li>
        <li>
          Your <strong>emergency contacts stay on your device.</strong> Their numbers only leave it when you send an
          SOS, and they are never stored on our server.
        </li>
        <li>
          <strong>Incident reports are public:</strong> anyone can see their location, description and your display
          name.
        </li>
        <li>We do not sell data, show ads or use tracking cookies.</li>
      </ul>
    ),
  },
  {
    id: "stored",
    title: "What our server stores",
    body: (
      <>
        <h3 className="mt-4 font-semibold text-white">SOS events</h3>
        <p className="mt-1">
          Each SOS is recorded with the time, your exact location and its accuracy, the message, how many contacts it
          was sent to and how many text messages succeeded or failed, your account and display name (if you are signed
          in), and a keyed hash of your IP address (used only to investigate abuse). Your contacts&apos; phone numbers
          are <strong>not</strong> stored. Signed-in users can see their own SOS history on their profile.
        </p>
        <h3 className="mt-4 font-semibold text-white">Incident reports</h3>
        <p className="mt-1">
          A report stores its location, type, severity, description, optional image link, status, your account id and
          display name, and which accounts confirmed it (so each person can upvote only once). Reports are{" "}
          <strong>visible to everyone</strong>, including people who are not signed in. You can mark your own report as
          resolved.
        </p>
        <h3 className="mt-4 font-semibold text-white">Push notification subscriptions</h3>
        <p className="mt-1">
          When you turn on notifications we store the subscription your browser creates (an address at your browser&apos;s
          push service plus encryption keys), your chosen radius and topics, your location <strong>rounded to about
          110 m</strong>, the account it is linked to (if you are signed in) and a delivery-failure counter. Turning
          notifications off deletes it; signing out unlinks it from your account. Subscriptions the push service
          reports as expired, or that fail repeatedly, are deleted automatically.
        </p>
        <h3 className="mt-4 font-semibold text-white">Accounts</h3>
        <p className="mt-1">
          Email sign-up stores your email address, name and a bcrypt hash of your password (never the password itself).
          If you sign in with GitHub or Google we store nothing about you on our server beyond what you create (SOS
          events, reports, subscriptions); your session lives in a secure cookie in your browser.
        </p>
        <h3 className="mt-4 font-semibold text-white">How long</h3>
        <p className="mt-1">
          SOS events, incident reports and accounts are kept until the operator of this ResQ AI installation deletes
          them; there is currently no automatic expiry and no self-service deletion. To have your data removed, use the{" "}
          <Link href="/contact" className="font-semibold text-red-300 underline-offset-2 hover:underline">
            contact page
          </Link>
          . Server logs record request ids, paths and status codes; phone numbers are masked and tokens are never
          logged. Rate-limit counters are kept in memory only.
        </p>
      </>
    ),
  },
  {
    id: "device",
    title: "What stays on your device",
    body: (
      <ul className={listClass}>
        <li>Emergency contacts, checklist progress, dismissed alerts, map and notification preferences (local storage).</li>
        <li>The current chat conversation and an unsent incident report draft (cleared when you close the tab or sign out).</li>
        <li>
          For offline use, the app&apos;s service worker saves pages, map tiles and recent public data (weather, alerts,
          incidents, nearby places). Saved data is labelled when it is shown offline; cached incident data is cleared
          when you sign out.
        </li>
        <li>
          Your last known location (local storage), so that offline pages can show the information saved for your area.
          It never leaves your device and is cleared when you sign out.
        </li>
      </ul>
    ),
  },
  {
    id: "third-parties",
    title: "Services that receive data",
    body: (
      <ul className={listClass}>
        <li>
          <strong>OpenStreetMap</strong> — your browser loads map tiles directly from tile.openstreetmap.org, which sees
          your IP address and the map area. Our server asks the <strong>Overpass API</strong> for hospitals, shelters,
          police, fire stations and pharmacies around a point.
        </li>
        <li>
          <strong>Open-Meteo</strong> or <strong>OpenWeatherMap</strong> — our server sends coordinates to get the
          weather.
        </li>
        <li>
          <strong>GDACS</strong> and <strong>ReliefWeb</strong> — disaster alerts and news; no personal data is sent.
        </li>
        <li>
          <strong>Google Gemini</strong> (when AI is enabled) — your chat messages, plus your approximate location when
          you share it, are sent to generate answers.
        </li>
        <li>
          <strong>Twilio</strong> (when SMS is enabled) — the SOS text, including your location link, and your
          contacts&apos; numbers are sent to deliver the messages.
        </li>
        <li>
          <strong>Your browser&apos;s push service</strong> (Google, Mozilla, Apple or Microsoft) delivers encrypted
          notifications.
        </li>
      </ul>
    ),
  },
  {
    id: "choices",
    title: "Your choices",
    body: (
      <ul className={listClass}>
        <li>You can use ResQ AI without sharing your location; a default location is used and the app tells you so.</li>
        <li>You can use the SOS page without an account. When SMS is unavailable it opens your phone&apos;s SMS app instead.</li>
        <li>You can turn notifications off at any time on the Alerts or Profile page.</li>
      </ul>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <h1 className="mb-3 text-4xl font-bold tracking-tight text-white">Privacy</h1>
      <p className="mb-8 text-slate-300">
        ResQ AI is built for emergencies, so it collects as little as it can. This page explains exactly what is stored,
        where, for how long, and who can see it.
      </p>
      <div className="space-y-5">
        {SECTIONS.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`${section.id}-title`}
            className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 leading-relaxed text-slate-300 backdrop-blur-md sm:p-6"
          >
            <h2 id={`${section.id}-title`} className="text-xl font-semibold text-white">
              {section.title}
            </h2>
            {section.body}
          </section>
        ))}
      </div>
      <p className="mt-8 text-sm text-slate-400">
        ResQ AI is not a replacement for emergency services. In danger, call your local emergency number (112, 911,
        999…) first.
      </p>
    </div>
  );
}
