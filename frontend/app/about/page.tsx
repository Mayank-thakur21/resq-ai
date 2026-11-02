import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About",
  description:
    "ResQ AI is a disaster-response assistant built on real, open data: GDACS, ReliefWeb, OpenStreetMap, Open-Meteo and OpenWeatherMap.",
};

/** Data sources and services the app relies on (keep in sync with the README). */
const DATA_SOURCES: readonly { name: string; href: string; use: string }[] = [
  { name: "GDACS", href: "https://www.gdacs.org/", use: "Global disaster alerts (earthquakes, cyclones, floods, volcanoes, droughts, wildfires)." },
  { name: "ReliefWeb", href: "https://reliefweb.int/", use: "Humanitarian news and situation reports (when configured)." },
  { name: "OpenWeatherMap", href: "https://openweathermap.org/", use: "Current weather, forecast and official alerts (when configured)." },
  { name: "Open-Meteo", href: "https://open-meteo.com/", use: "Free weather data used when OpenWeatherMap is not configured." },
  { name: "OpenStreetMap", href: "https://www.openstreetmap.org/", use: "Map tiles, plus hospitals, shelters, police, fire stations and pharmacies via the Overpass API." },
  { name: "Google Gemini", href: "https://ai.google.dev/", use: "AI chat answers, checklists and translations (deterministic built-in guidance otherwise)." },
  { name: "Twilio", href: "https://www.twilio.com/", use: "SOS text messages to your emergency contacts (your phone's SMS app otherwise)." },
];

export default function AboutPage() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <h1 className="mb-6 text-4xl font-bold tracking-tight text-white">About ResQ AI</h1>
      <div className="space-y-4 leading-relaxed text-slate-300">
        <p>
          ResQ AI is an intelligent disaster response assistant designed to provide real-time, actionable, and
          life-saving information during emergencies.
        </p>
        <p>
          Our goal is to make emergency preparedness and response accessible to everyone, everywhere — including when
          the network is poor: the SOS, contacts, offline and map pages keep working with saved data.
        </p>
      </div>

      <section aria-labelledby="sources-title" className="mt-10 rounded-2xl border border-slate-700 bg-slate-800/50 p-5 backdrop-blur-md sm:p-6">
        <h2 id="sources-title" className="text-xl font-semibold text-white">
          Data sources
        </h2>
        <p className="mt-1 text-sm text-slate-400">Every alert, forecast and place comes from a real, public source.</p>
        <ul className="mt-4 space-y-3">
          {DATA_SOURCES.map((source) => (
            <li key={source.name} className="text-slate-300">
              <a
                href={source.href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-red-300 underline-offset-2 hover:underline"
              >
                {source.name}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>{" "}
              — {source.use}
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-8 text-sm text-slate-400">
        Read how your data is handled in the{" "}
        <Link href="/privacy" className="font-semibold text-red-300 underline-offset-2 hover:underline">
          privacy statement
        </Link>
        .
      </p>
    </div>
  );
}
