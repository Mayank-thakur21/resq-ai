import type { Metadata } from "next";
import { Suspense } from "react";

import IncidentsRoute from "@/app/incidents/IncidentsRoute";
import IncidentsLoading from "@/app/incidents/loading";

export const metadata: Metadata = {
  title: "Incidents",
  description:
    "Community-reported incidents near you — floods, fires, accidents and more — with severity, verification and distance.",
};

/**
 * `/incidents` — optional `?focus=<id>` highlights one incident (push notification links).
 * Static shell: the query is read on the client (`IncidentsRoute`) so the page is prerendered
 * and available offline.
 */
export default function IncidentsPage() {
  return (
    <Suspense fallback={<IncidentsLoading />}>
      <IncidentsRoute />
    </Suspense>
  );
}
