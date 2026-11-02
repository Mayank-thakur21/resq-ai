"use client";

/**
 * Reads `?created=1` (set after submitting a report) on the client, so the detail page does
 * not depend on `searchParams` and can be cached instead of rendered `no-store` per request.
 */

import { useSearchParams } from "next/navigation";

import { IncidentDetail } from "@/app/incidents/[id]/IncidentDetail";

export default function IncidentDetailRoute({ id }: { id: string }) {
  const params = useSearchParams();
  return <IncidentDetail key={id} id={id} justCreated={params?.get("created") === "1"} />;
}
