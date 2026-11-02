"use client";

/**
 * The Leaflet map of the `/map` page: place, incident and disaster markers, the search
 * radius circle, the device location, and a click popup with "Report incident here" /
 * "Search this area".
 *
 * Client-only; load with `next/dynamic(() => import("@/components/map/ReliefMap"), { ssr: false })`.
 * All data comes in through props (fetched by `useMapData`), so this component never fetches.
 */

import { ExternalLink, Navigation, Phone, Search, Siren, TriangleAlert } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { Circle, Marker, Popup, useMapEvents } from "react-leaflet";

import BaseMap, { FitRadius, toLatLon } from "@/components/map/BaseMap";
import {
  disasterIcon,
  incidentIcon,
  pinIcon,
  searchCenterIcon,
  userLocationIcon,
} from "@/components/map/icons";
import { disasterTypeMeta, incidentTitle, severityMeta } from "@/components/map/incident-meta";
import { getLayer, reportIncidentHref } from "@/components/map/layers";
import { RelativeTime } from "@/components/map/RelativeTime";
import { formatCoordinates, safeHttpUrl, truncate } from "@/lib/format";
import { formatDistance, haversineKm, type Coordinates } from "@/lib/geo";
import type { DisasterEvent, Incident, LatLon, Place, PlaceType } from "@/lib/types";
import { PLACE_TYPES } from "@/lib/types";

export interface ReliefMapProps {
  /** Centre of the search (device location, default location or a picked area). */
  center: LatLon;
  radiusKm: number;
  /** Device fix, drawn as a blue dot when known. */
  userLocation: Coordinates | null;
  /** Bump to re-fit the view to the search circle (recenter button). */
  viewToken: number;
  places: Partial<Record<PlaceType, readonly Place[]>>;
  incidents: readonly Incident[];
  disasters: readonly DisasterEvent[];
  /** "Search this area" from the click popup. */
  onSearchHere: (point: LatLon) => void;
  /** The centre is the configured fallback, not a real or chosen place (no "report here"). */
  centerIsFallback?: boolean;
}

// Leaflet's own stylesheet (unlayered) sets `.leaflet-container a { color }`, which beats
// Tailwind's layered utilities, so link colours inside popups use the `!` modifier.
const popupPrimary =
  "inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white! no-underline! hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:outline-none";
const popupSecondary =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700! no-underline! hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none";

function PopupBody({ children }: { children: React.ReactNode }) {
  return <div className="min-w-48 max-w-64 space-y-1.5 font-sans text-sm text-slate-800">{children}</div>;
}

function directionsHref(point: LatLon): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lon}`;
}

function telHref(phone: string): string | null {
  const cleaned = phone.split(/[;,]/)[0]?.replace(/[^\d+]/g, "") ?? "";
  return cleaned.length >= 3 ? `tel:${cleaned}` : null;
}

export default function ReliefMap({
  center,
  radiusKm,
  userLocation,
  viewToken,
  places,
  incidents,
  disasters,
  onSearchHere,
  centerIsFallback = false,
}: ReliefMapProps) {
  const isUserCenter =
    !!userLocation &&
    Math.abs(userLocation.lat - center.lat) < 1e-6 &&
    Math.abs(userLocation.lon - center.lon) < 1e-6;

  return (
    <BaseMap center={center} zoom={13} label="Relief map" zoomPosition="topright">
      <FitRadius center={center} radiusKm={radiusKm} token={viewToken} />

      <Circle
        center={[center.lat, center.lon]}
        radius={radiusKm * 1000}
        interactive={false}
        pathOptions={{ color: "#3b82f6", weight: 1.5, dashArray: "6 6", fillColor: "#3b82f6", fillOpacity: 0.06 }}
      />

      {userLocation && (
        <Marker
          position={[userLocation.lat, userLocation.lon]}
          icon={userLocationIcon()}
          title="Your location"
          zIndexOffset={1000}
        >
          <Popup>
            <PopupBody>
              <div className="font-semibold">You are here</div>
              {userLocation.accuracy !== null && (
                <div className="text-xs text-slate-500">Accuracy ±{Math.round(userLocation.accuracy)} m</div>
              )}
              <div className="pt-1">
                <Link href={reportIncidentHref(userLocation)} className={popupPrimary}>
                  <Siren aria-hidden="true" className="size-3.5" /> Report incident here
                </Link>
              </div>
            </PopupBody>
          </Popup>
        </Marker>
      )}

      {!isUserCenter && (
        <Marker
          position={[center.lat, center.lon]}
          icon={searchCenterIcon()}
          title={centerIsFallback ? "Default location" : "Search centre"}
        >
          <Popup>
            <PopupBody>
              <div className="font-semibold">{centerIsFallback ? "Default location" : "Search centre"}</div>
              <div className="text-xs text-slate-500">{formatCoordinates(center.lat, center.lon, 4)}</div>
              {centerIsFallback ? (
                <div className="text-xs text-slate-600">
                  Your location is unknown. Enable location access for results around you.
                </div>
              ) : (
                <div className="pt-1">
                  <Link href={reportIncidentHref(center)} className={popupPrimary}>
                    <Siren aria-hidden="true" className="size-3.5" /> Report incident here
                  </Link>
                </div>
              )}
            </PopupBody>
          </Popup>
        </Marker>
      )}

      {PLACE_TYPES.map((type) =>
        (places[type] ?? []).map((place) => <PlaceMarker key={`${type}:${place.id}`} place={place} />),
      )}

      {incidents.map((incident) => (
        <IncidentMarker key={`incident:${incident.id}`} incident={incident} />
      ))}

      {disasters.map((event) => (
        <DisasterMarker key={`disaster:${event.id}`} event={event} center={center} />
      ))}

      <ClickPopup onSearchHere={onSearchHere} />
    </BaseMap>
  );
}

const PlaceMarker = React.memo(function PlaceMarker({ place }: { place: Place }) {
  const layer = getLayer(place.type);
  const phoneHref = place.phone ? telHref(place.phone) : null;
  return (
    <Marker
      position={[place.lat, place.lon]}
      icon={pinIcon(layer.color, layer.glyph)}
      title={`${layer.singular}: ${place.name}`}
      riseOnHover
    >
      <Popup>
        <PopupBody>
          <div className="font-semibold leading-snug">
            <span aria-hidden="true">{layer.glyph} </span>
            {place.name}
          </div>
          <div className="text-xs text-slate-500">
            {layer.singular}
            {Number.isFinite(place.distance_km) && ` · ${formatDistance(place.distance_km)} away`}
          </div>
          {place.address && <div className="text-xs text-slate-600">{place.address}</div>}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <a href={directionsHref(place)} target="_blank" rel="noopener noreferrer" className={popupSecondary}>
              <Navigation aria-hidden="true" className="size-3.5" /> Directions
            </a>
            {phoneHref && (
              <a href={phoneHref} className={popupSecondary}>
                <Phone aria-hidden="true" className="size-3.5" /> Call
              </a>
            )}
          </div>
        </PopupBody>
      </Popup>
    </Marker>
  );
});

const IncidentMarker = React.memo(function IncidentMarker({ incident }: { incident: Incident }) {
  const meta = disasterTypeMeta(incident.disaster_type);
  const severity = severityMeta(incident.severity);
  const title = incidentTitle(incident);
  return (
    <Marker
      position={[incident.lat, incident.lon]}
      icon={incidentIcon(severity.color, meta.glyph, { verified: incident.verified })}
      title={`Incident: ${title}`}
      riseOnHover
      zIndexOffset={500}
    >
      <Popup>
        <PopupBody>
          <div className="font-semibold leading-snug">
            <span aria-hidden="true">{meta.glyph} </span>
            {title}
          </div>
          <div className="text-xs text-slate-500">
            <RelativeTime value={incident.created_at} prefix="Reported" />
            {` · ${incident.upvotes} confirmation${incident.upvotes === 1 ? "" : "s"}`}
            {incident.verified && " · Verified"}
          </div>
          <div className="text-xs text-slate-700">{truncate(incident.description, 140)}</div>
          <div className="pt-1">
            <Link href={`/incidents/${encodeURIComponent(incident.id)}`} className={popupPrimary}>
              View details
            </Link>
          </div>
        </PopupBody>
      </Popup>
    </Marker>
  );
});

const DisasterMarker = React.memo(function DisasterMarker({
  event,
  center,
}: {
  event: DisasterEvent;
  center: LatLon;
}) {
  const url = safeHttpUrl(event.url);
  const distance = event.distance_km ?? haversineKm(center, event);
  const levelLabel = `${event.alert_level.charAt(0).toUpperCase()}${event.alert_level.slice(1)} alert`;
  return (
    <Marker
      position={[event.lat, event.lon]}
      icon={disasterIcon(event.alert_level, event.event_type)}
      title={`${event.event_type_label}: ${event.title} (${levelLabel})`}
      riseOnHover
      zIndexOffset={event.alert_level === "red" ? 800 : 300}
    >
      <Popup>
        <PopupBody>
          <div className="font-semibold leading-snug">{event.title}</div>
          <div className="text-xs text-slate-500">
            {event.event_type_label} · {levelLabel}
            {event.country && ` · ${event.country}`}
          </div>
          {event.severity_text && <div className="text-xs text-slate-700">{event.severity_text}</div>}
          <div className="text-xs text-slate-500">
            {formatDistance(distance)} from the search centre
            {event.from_date && (
              <>
                {" · "}
                <RelativeTime value={event.from_date} prefix="since" />
              </>
            )}
          </div>
          {url && (
            <div className="pt-1">
              <a href={url} target="_blank" rel="noopener noreferrer" className={popupSecondary}>
                <ExternalLink aria-hidden="true" className="size-3.5" /> GDACS report
              </a>
            </div>
          )}
        </PopupBody>
      </Popup>
    </Marker>
  );
});

/**
 * Clicking empty map space opens a popup at that point. Each popup instance only clears
 * its own state when closed, so opening a new one never closes itself by accident.
 */
function ClickPopup({ onSearchHere }: { onSearchHere: (point: LatLon) => void }) {
  const [clicked, setClicked] = React.useState<{ point: LatLon; position: [number, number] } | null>(
    null,
  );

  useMapEvents({
    click(event) {
      const point = toLatLon(event.latlng);
      setClicked({ point, position: [point.lat, point.lon] });
    },
  });

  if (!clicked) return null;
  const current = clicked;

  return (
    <Popup
      key={`${current.point.lat},${current.point.lon}`}
      position={current.position}
      eventHandlers={{ remove: () => setClicked((value) => (value === current ? null : value)) }}
    >
      <PopupBody>
        <div className="flex items-center gap-1.5 font-semibold">
          <TriangleAlert aria-hidden="true" className="size-4 text-amber-600" /> This spot
        </div>
        <div className="text-xs text-slate-500">{formatCoordinates(current.point.lat, current.point.lon, 4)}</div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Link href={reportIncidentHref(current.point)} className={popupPrimary}>
            <Siren aria-hidden="true" className="size-3.5" /> Report incident here
          </Link>
          <button
            type="button"
            className={popupSecondary}
            onClick={() => {
              setClicked(null);
              onSearchHere(current.point);
            }}
          >
            <Search aria-hidden="true" className="size-3.5" /> Search this area
          </button>
        </div>
      </PopupBody>
    </Popup>
  );
}
