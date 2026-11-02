import { Hospital, MapPin, Navigation, Phone, Tent } from "lucide-react";

import { formatDistance, mapsLink } from "@/lib/geo";
import { telHref } from "@/lib/phone";
import type { Place } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND = {
  hospitals: {
    title: "Nearby hospitals",
    icon: Hospital,
    tone: "border-rose-500/30 bg-rose-500/5",
    iconTone: "text-rose-300",
  },
  shelters: {
    title: "Nearby shelters",
    icon: Tent,
    tone: "border-emerald-500/30 bg-emerald-500/5",
    iconTone: "text-emerald-300",
  },
} as const;

/** Hospitals / shelters found by the chat agents, with call and directions links. */
export function PlacesList({ kind, places }: { kind: keyof typeof KIND; places: readonly Place[] }) {
  if (places.length === 0) return null;
  const { title, icon: Icon, tone, iconTone } = KIND[kind];

  return (
    <div className={cn("rounded-xl border p-3", tone)}>
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-100">
        <Icon aria-hidden="true" className={cn("size-4", iconTone)} />
        {title}
      </h4>
      <ul className="space-y-2">
        {places.map((place) => {
          const distance = formatDistance(place.distance_km);
          return (
            <li key={place.id} className="rounded-lg bg-slate-900/60 p-2.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-slate-100">{place.name}</p>
                {distance && <span className="shrink-0 font-medium text-slate-300">{distance}</span>}
              </div>
              {place.address && (
                <p className="mt-0.5 flex items-start gap-1 text-slate-400">
                  <MapPin aria-hidden="true" className="mt-px size-3 shrink-0" />
                  {place.address}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <a
                  href={mapsLink(place.lat, place.lon)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 font-semibold text-cyan-200 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none"
                >
                  <Navigation aria-hidden="true" className="size-3" />
                  Directions
                </a>
                {place.phone && (
                  <a
                    href={telHref(place.phone)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 font-semibold text-emerald-200 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:outline-none"
                  >
                    <Phone aria-hidden="true" className="size-3" />
                    {place.phone}
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default PlacesList;
