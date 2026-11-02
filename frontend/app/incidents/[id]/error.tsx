"use client";

import { SegmentError } from "@/components/map/SegmentError";

export default function IncidentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      error={error}
      reset={reset}
      scope="app/incidents/[id]"
      title="This incident ran into a problem"
      message="We couldn't show this incident report. Try again, or go back to the list."
      links={["incidents", "map"]}
    />
  );
}
