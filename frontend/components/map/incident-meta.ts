/**
 * Display metadata and pure helpers for community incidents, shared by the incident pages,
 * `IncidentCard`, `IncidentForm` and the relief map markers.
 *
 * React-free so server components and tests can import it.
 */

import type { BadgeProps } from "@/components/ui/badge";
import {
  DISASTER_TYPES,
  SEVERITIES,
  type DisasterType,
  type Incident,
  type IncidentStatus,
  type Severity,
} from "@/lib/types";

export interface DisasterTypeMeta {
  label: string;
  glyph: string;
}

export const DISASTER_TYPE_META: Record<DisasterType, DisasterTypeMeta> = {
  flood: { label: "Flood", glyph: "🌊" },
  earthquake: { label: "Earthquake", glyph: "🌍" },
  fire: { label: "Fire", glyph: "🔥" },
  cyclone: { label: "Cyclone", glyph: "🌀" },
  landslide: { label: "Landslide", glyph: "⛰️" },
  drought: { label: "Drought", glyph: "🏜️" },
  heatwave: { label: "Heatwave", glyph: "🌡️" },
  tsunami: { label: "Tsunami", glyph: "🌊" },
  storm: { label: "Storm", glyph: "⛈️" },
  accident: { label: "Accident", glyph: "🚗" },
  medical: { label: "Medical emergency", glyph: "🚑" },
  other: { label: "Other", glyph: "⚠️" },
};

/** Tolerates unknown types (a newer backend) instead of crashing the UI. */
export function disasterTypeMeta(type: string): DisasterTypeMeta {
  return (
    DISASTER_TYPE_META[type as DisasterType] ?? {
      label: type ? type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ") : "Incident",
      glyph: "⚠️",
    }
  );
}

export interface SeverityMeta {
  label: string;
  /** Hex colour for map markers. */
  color: string;
  badge: NonNullable<BadgeProps["variant"]>;
  /** Left accent bar on cards. */
  accentClass: string;
  /** Selected state of the severity segmented control. */
  selectedClass: string;
  /** Sort rank (higher = more severe). */
  rank: number;
}

export const SEVERITY_META: Record<Severity, SeverityMeta> = {
  low: {
    label: "Low",
    color: "#16a34a",
    badge: "low",
    accentClass: "bg-emerald-500",
    selectedClass: "border-emerald-400 bg-emerald-500/20 text-emerald-100",
    rank: 1,
  },
  medium: {
    label: "Medium",
    color: "#d97706",
    badge: "medium",
    accentClass: "bg-amber-500",
    selectedClass: "border-amber-400 bg-amber-500/20 text-amber-100",
    rank: 2,
  },
  high: {
    label: "High",
    color: "#ea580c",
    badge: "high",
    accentClass: "bg-orange-500",
    selectedClass: "border-orange-400 bg-orange-500/20 text-orange-100",
    rank: 3,
  },
  critical: {
    label: "Critical",
    color: "#dc2626",
    badge: "critical",
    accentClass: "bg-red-600",
    selectedClass: "border-red-400 bg-red-600/25 text-red-100",
    rank: 4,
  },
};

export function severityMeta(severity: string): SeverityMeta {
  return SEVERITY_META[severity as Severity] ?? SEVERITY_META.medium;
}

export const SEVERITY_HINTS: Record<Severity, string> = {
  low: "Minor, no immediate danger",
  medium: "Disruptive, needs attention",
  high: "Dangerous, people at risk",
  critical: "Life-threatening, act now",
};

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "Open",
  resolved: "Resolved",
};

/** `<select>` options for incident types, in a stable, human-friendly order. */
export const DISASTER_TYPE_OPTIONS: readonly { value: DisasterType; label: string }[] =
  DISASTER_TYPES.map((value) => ({
    value,
    label: `${DISASTER_TYPE_META[value].glyph} ${DISASTER_TYPE_META[value].label}`,
  }));

export const SEVERITY_OPTIONS: readonly { value: Severity; label: string }[] = SEVERITIES.map(
  (value) => ({ value, label: SEVERITY_META[value].label }),
);

export function isDisasterType(value: unknown): value is DisasterType {
  return typeof value === "string" && (DISASTER_TYPES as readonly string[]).includes(value);
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------
// List filtering (severity is filtered client-side; the backend filters type/status/radius)
// ---------------------------------------------------------------------------------------

export type StatusFilter = IncidentStatus | "all";

export const STATUS_FILTER_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All statuses" },
];

export function isStatusFilter(value: unknown): value is StatusFilter {
  return value === "open" || value === "resolved" || value === "all";
}

/** Radius choices for the incident list (km). The backend default is 50 km. */
export const INCIDENT_RADIUS_OPTIONS_KM = [5, 10, 25, 50, 100, 250] as const;
export const DEFAULT_INCIDENT_RADIUS_KM = 50;

export interface IncidentClientFilters {
  /** Exact severity match (`"all"` = no filter). */
  severity?: Severity | "all";
  type?: DisasterType | "all";
}

/** Applies the client-side filters without reordering (the backend sorts newest first). */
export function filterIncidents(
  incidents: readonly Incident[],
  { severity = "all", type = "all" }: IncidentClientFilters,
): Incident[] {
  return incidents.filter(
    (incident) =>
      (severity === "all" || incident.severity === severity) &&
      (type === "all" || incident.disaster_type === type),
  );
}

/** Returns a copy of `list` with `updated` swapped in by id (unchanged when absent). */
export function replaceIncident<T extends { id: string }>(list: readonly T[], updated: T): T[] {
  return list.map((item) => (item.id === updated.id ? updated : item));
}

/** Short, single-line title for an incident, e.g. "Critical flood". */
export function incidentTitle(incident: Pick<Incident, "severity" | "disaster_type">): string {
  const type = disasterTypeMeta(incident.disaster_type).label.toLowerCase();
  return `${severityMeta(incident.severity).label} ${type}`;
}

export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 1000;
export const IMAGE_URL_MAX = 500;
