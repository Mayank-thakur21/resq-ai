"use client";

/**
 * Small map for the incident detail page: the incident marker (severity colour) and, when
 * known, the viewer's location.
 *
 * Client-only; load with `next/dynamic(..., { ssr: false })`.
 */

import { Marker } from "react-leaflet";

import BaseMap from "@/components/map/BaseMap";
import { incidentIcon, userLocationIcon } from "@/components/map/icons";
import { disasterTypeMeta, incidentTitle, severityMeta } from "@/components/map/incident-meta";
import type { Coordinates } from "@/lib/geo";
import type { Incident } from "@/lib/types";

export interface IncidentMapProps {
  incident: Incident;
  userLocation?: Coordinates | null;
}

export default function IncidentMap({ incident, userLocation }: IncidentMapProps) {
  const meta = disasterTypeMeta(incident.disaster_type);
  return (
    <BaseMap
      center={{ lat: incident.lat, lon: incident.lon }}
      zoom={15}
      label={`Map showing the ${incidentTitle(incident).toLowerCase()} location`}
      scrollWheelZoom={false}
    >
      <Marker
        position={[incident.lat, incident.lon]}
        icon={incidentIcon(severityMeta(incident.severity).color, meta.glyph, {
          verified: incident.verified,
          highlighted: true,
        })}
        title={`Incident: ${incidentTitle(incident)}`}
        keyboard={false}
      />
      {userLocation && (
        <Marker
          position={[userLocation.lat, userLocation.lon]}
          icon={userLocationIcon()}
          title="Your location"
          keyboard={false}
        />
      )}
    </BaseMap>
  );
}
