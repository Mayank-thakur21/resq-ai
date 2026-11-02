"use client";

import { SegmentError } from "@/components/map/SegmentError";

export default function IncidentsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      error={error}
      reset={reset}
      scope="app/incidents"
      title="Incidents ran into a problem"
      message="We couldn't show community incidents right now. Try again, or check the relief map."
      links={["map", "home"]}
    />
  );
}
