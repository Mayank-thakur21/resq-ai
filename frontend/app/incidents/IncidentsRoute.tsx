"use client";

/**
 * Reads `/incidents?focus=<id>` on the client so the page itself stays a static shell that
 * the service worker can precache and serve offline (awaiting `searchParams` in the server
 * page made it dynamic and `no-store`).
 */

import { useSearchParams } from "next/navigation";

import { IncidentsView } from "@/app/incidents/IncidentsView";
import { sanitizeIncidentId } from "@/components/map/layers";

export default function IncidentsRoute() {
  const params = useSearchParams();
  const focusId = sanitizeIncidentId(params?.get("focus"));
  return <IncidentsView key={focusId ?? "list"} focusId={focusId} />;
}
