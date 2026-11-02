import type { Metadata } from "next";
import { Suspense } from "react";

import MapLoading from "@/app/map/loading";
import MapRoute from "@/app/map/MapRoute";

export const metadata: Metadata = {
  title: "Relief map",
  description:
    "Live map of nearby hospitals, shelters, police and fire stations, pharmacies, community incident reports and GDACS disaster alerts.",
};

/**
 * `/map` — optional `?lat=..&lon=..` centres the map on a point (e.g. "View on map" from an
 * incident). Static shell: the query is read on the client (`MapRoute`), so the page is
 * prerendered and the service worker can serve it offline.
 */
export default function MapPage() {
  return (
    <Suspense fallback={<MapLoading />}>
      <MapRoute />
    </Suspense>
  );
}
