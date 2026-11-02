"use client";

import { SegmentError } from "@/components/map/SegmentError";

export default function MapError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      error={error}
      reset={reset}
      scope="app/map"
      title="The relief map ran into a problem"
      message="We couldn't show the map right now. Try again, or browse reported incidents instead."
      links={["incidents", "home"]}
    />
  );
}
