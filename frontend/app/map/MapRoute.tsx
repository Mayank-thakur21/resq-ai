"use client";

/**
 * Reads `/map?lat=..&lon=..` on the client so the page itself stays a static shell.
 *
 * Awaiting `searchParams` in the server page made `/map` dynamic (`Cache-Control: no-store`),
 * which the service worker refuses to cache — the map (and its cached tiles, places and
 * incidents) could then never open offline. Reading the query here, inside the page's
 * `<Suspense>` boundary, lets Next.js prerender the page and the worker precache it.
 */

import { useSearchParams } from "next/navigation";

import MapView from "@/app/map/MapView";
import { parseLatLonParams } from "@/components/map/layers";

export default function MapRoute() {
  const params = useSearchParams();
  const initialCenter = parseLatLonParams(params?.get("lat"), params?.get("lon"));
  // Keyed by the requested centre so navigating between centres resets the view.
  const key = initialCenter ? `${initialCenter.lat},${initialCenter.lon}` : "device";
  return <MapView key={key} initialCenter={initialCenter} />;
}
