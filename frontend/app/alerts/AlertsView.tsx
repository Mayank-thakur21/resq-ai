"use client";

import { Info, Newspaper, Siren } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import * as React from "react";

import { DisasterEventsPanel } from "@/app/alerts/_components/DisasterEventsPanel";
import { NewsPanel } from "@/app/alerts/_components/NewsPanel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PushToggle } from "@/components/PushToggle";
import { useGeolocation } from "@/lib/geo";
import { cn } from "@/lib/utils";

/**
 * Interactive part of `/alerts`: the "Disasters" / "News" tabs plus the side column
 * (push notification toggle and an alert-level legend).
 *
 * The active tab lives in the URL (`?tab=news`) so it can be linked to (the home feed's
 * "All alerts & news" link does). Switching tabs uses `history.replaceState` — instant, no
 * server round-trip, no extra history entries. Panels mount on first visit and then stay
 * mounted (hidden), so filters and search survive tab switches.
 *
 * `?event=<GDACS id>` (the link in disaster push notifications) highlights that event in the
 * Disasters tab.
 */

export type AlertsTab = "disasters" | "news";

const TABS: readonly { id: AlertsTab; label: string; icon: typeof Siren }[] = [
  { id: "disasters", label: "Disasters", icon: Siren },
  { id: "news", label: "News", icon: Newspaper },
];

export function parseTab(value: string | null | undefined): AlertsTab {
  return value === "news" ? "news" : "disasters";
}

const tabId = (tab: AlertsTab) => `alerts-tab-${tab}`;
const panelId = (tab: AlertsTab) => `alerts-panel-${tab}`;

export default function AlertsView() {
  const searchParams = useSearchParams();
  const urlTab = parseTab(searchParams?.get("tab"));
  // Push notifications link to `/alerts?event=<GDACS id>` (see backend alert_poller).
  const focusEventId = searchParams?.get("event")?.trim() || null;
  const [activeTab, setActiveTab] = React.useState<AlertsTab>(urlTab);
  const [visited, setVisited] = React.useState<ReadonlySet<AlertsTab>>(() => new Set([urlTab]));
  const tabRefs = React.useRef<Record<AlertsTab, HTMLButtonElement | null>>({ disasters: null, news: null });

  // One location request for the whole page (event distances, "near me", push radius).
  const geo = useGeolocation();

  const activate = React.useCallback((tab: AlertsTab) => {
    setActiveTab(tab);
    setVisited((previous) => (previous.has(tab) ? previous : new Set(previous).add(tab)));
  }, []);

  // Follow external URL changes (e.g. clicking a link to /alerts?tab=news while here).
  React.useEffect(() => {
    activate(urlTab);
  }, [urlTab, activate]);

  const selectTab = (tab: AlertsTab) => {
    activate(tab);
    try {
      const url = new URL(window.location.href);
      if (tab === "disasters") url.searchParams.delete("tab");
      else url.searchParams.set("tab", tab);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch (error) {
      console.warn("[alerts] could not update the URL for the selected tab", error);
    }
  };

  /** WAI-ARIA tabs keyboard support: arrows, Home and End move between tabs. */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = TABS[nextIndex].id;
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  const pushCoords = geo.coords ? { lat: geo.coords.lat, lon: geo.coords.lon } : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="min-w-0 lg:col-span-8">
        <div
          role="tablist"
          aria-label="Alert views"
          onKeyDown={onTabKeyDown}
          className="mb-4 inline-flex rounded-xl border border-slate-700 bg-slate-900/60 p-1 backdrop-blur-md"
        >
          {TABS.map((tab) => {
            const selected = tab.id === activeTab;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node;
                }}
                type="button"
                role="tab"
                id={tabId(tab.id)}
                aria-selected={selected}
                aria-controls={panelId(tab.id)}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none",
                  selected ? "bg-slate-700 text-white shadow" : "text-slate-400 hover:text-slate-200",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {TABS.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={panelId(tab.id)}
            aria-labelledby={tabId(tab.id)}
            hidden={tab.id !== activeTab}
            tabIndex={0}
            className="focus-visible:outline-none"
          >
            {(visited.has(tab.id) || tab.id === activeTab) &&
              (tab.id === "disasters" ? (
                <ErrorBoundary title="Disaster events are unavailable">
                  <DisasterEventsPanel geo={geo} focusEventId={focusEventId} />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary title="News is unavailable">
                  <NewsPanel />
                </ErrorBoundary>
              ))}
          </div>
        ))}
      </div>

      <aside className="space-y-4 lg:col-span-4" aria-label="Notifications and alert levels">
        <ErrorBoundary title="Notifications are unavailable" compact>
          <PushToggle coords={pushCoords} />
        </ErrorBoundary>
        <AlertLevelLegend />
      </aside>
    </div>
  );
}

function AlertLevelLegend() {
  const levels = [
    {
      key: "red",
      dot: "bg-red-500",
      label: "Red",
      text: "Severe impact likely. International humanitarian assistance may be needed.",
    },
    {
      key: "orange",
      dot: "bg-orange-500",
      label: "Orange",
      text: "Moderate impact possible. Local response may need outside support.",
    },
    {
      key: "green",
      dot: "bg-emerald-500",
      label: "Green",
      text: "Minor impact expected. Stay informed and follow local guidance.",
    },
  ] as const;

  return (
    <section
      aria-labelledby="alert-levels-title"
      className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-900/40 to-blue-900/40 p-5 backdrop-blur-md"
    >
      <h2
        id="alert-levels-title"
        className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wider text-indigo-300 uppercase"
      >
        <Info aria-hidden="true" className="size-4" /> About alert levels
      </h2>
      <ul className="space-y-3 text-sm">
        {levels.map((level) => (
          <li key={level.key} className="flex gap-3">
            <span aria-hidden="true" className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", level.dot)} />
            <span>
              <span className="font-semibold text-slate-100">{level.label}:</span>{" "}
              <span className="text-slate-300">{level.text}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-indigo-500/20 pt-3 text-xs text-slate-400">
        Data: GDACS (Global Disaster Alert and Coordination System) and ReliefWeb (UN OCHA). In immediate danger? Call{" "}
        <a href="tel:112" className="font-semibold text-red-300 hover:underline">
          112
        </a>{" "}
        or use{" "}
        <Link href="/sos" className="font-semibold text-red-300 hover:underline">
          SOS
        </Link>
        .
      </p>
    </section>
  );
}
