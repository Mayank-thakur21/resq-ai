import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import IncidentDetailRoute from "@/app/incidents/[id]/IncidentDetailRoute";
import IncidentLoading from "@/app/incidents/[id]/loading";
import { sanitizeIncidentId } from "@/components/map/layers";

export const metadata: Metadata = {
  title: "Incident details",
  description: "Community incident report with location, severity and verification status.",
};

type Params = Promise<{ id: string }>;

/**
 * `/incidents/[id]` — data is fetched client-side (through the proxy, with the viewer's token).
 *
 * Rendered per request on purpose: pre-generating (ISR) arbitrary ids would let anyone fill
 * the server's page cache with random URLs. Offline, the service worker sends unvisited
 * detail pages to the precached `/incidents?focus=<id>` list instead (see `public/sw.js`).
 * `?created=1` is read on the client (`IncidentDetailRoute`).
 */
export default async function IncidentPage({ params }: { params: Params }) {
  const { id: rawId } = await params;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawId);
  } catch {
    notFound();
  }
  const id = sanitizeIncidentId(decoded);
  if (!id) notFound();
  return (
    <Suspense fallback={<IncidentLoading />}>
      <IncidentDetailRoute id={id} />
    </Suspense>
  );
}
