"use client";

import { SegmentError } from "@/components/map/SegmentError";

export default function NewIncidentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      error={error}
      reset={reset}
      scope="app/incidents/new"
      title="The report form ran into a problem"
      message="We couldn't show the incident form. Your draft is saved on this device — try again."
      links={["incidents", "home"]}
    />
  );
}
