"use client";

import { useNow } from "@/components/map/hooks";
import { formatDateTime, formatRelativeTime, toIsoString, type DateInput } from "@/lib/format";

export interface RelativeTimeProps {
  value: DateInput;
  /** Text before the relative time, e.g. "Reported". */
  prefix?: string;
  className?: string;
}

/**
 * `<time>` element showing "5 minutes ago" (refreshed every minute) with the absolute date
 * as a tooltip. Renders nothing for invalid dates.
 */
export function RelativeTime({ value, prefix, className }: RelativeTimeProps) {
  const now = useNow();
  const iso = toIsoString(value);
  if (!iso) return null;
  const relative = formatRelativeTime(iso, { now });
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className} suppressHydrationWarning>
      {prefix ? `${prefix} ${relative}` : relative}
    </time>
  );
}

export default RelativeTime;
