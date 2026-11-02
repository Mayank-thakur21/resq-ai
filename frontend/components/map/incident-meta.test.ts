import { describe, expect, it } from "vitest";

import {
  DISASTER_TYPE_META,
  DISASTER_TYPE_OPTIONS,
  SEVERITY_META,
  disasterTypeMeta,
  filterIncidents,
  incidentTitle,
  isDisasterType,
  isSeverity,
  isStatusFilter,
  replaceIncident,
  severityMeta,
} from "@/components/map/incident-meta";
import { makeIncident } from "@/components/map/test-fixtures";
import { DISASTER_TYPES, SEVERITIES } from "@/lib/types";

describe("incident metadata", () => {
  it("has a label and glyph for every disaster type and an option per type", () => {
    for (const type of DISASTER_TYPES) {
      expect(DISASTER_TYPE_META[type].label).not.toBe("");
      expect(DISASTER_TYPE_META[type].glyph).not.toBe("");
    }
    expect(DISASTER_TYPE_OPTIONS.map((option) => option.value)).toEqual([...DISASTER_TYPES]);
  });

  it("ranks severities from low to critical", () => {
    const ranks = SEVERITIES.map((severity) => SEVERITY_META[severity].rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("tolerates unknown values from a newer backend", () => {
    expect(disasterTypeMeta("volcanic_ash")).toEqual({ label: "Volcanic ash", glyph: "⚠️" });
    expect(severityMeta("extreme")).toBe(SEVERITY_META.medium);
  });

  it("builds a short title", () => {
    expect(incidentTitle({ severity: "critical", disaster_type: "medical" })).toBe("Critical medical emergency");
  });

  it("has type guards for filter values", () => {
    expect(isDisasterType("flood")).toBe(true);
    expect(isDisasterType("all")).toBe(false);
    expect(isSeverity("critical")).toBe(true);
    expect(isSeverity("severe")).toBe(false);
    expect(isStatusFilter("all")).toBe(true);
    expect(isStatusFilter("closed")).toBe(false);
  });
});

describe("filterIncidents", () => {
  const incidents = [
    makeIncident({ id: "a", severity: "low", disaster_type: "fire" }),
    makeIncident({ id: "b", severity: "critical", disaster_type: "flood" }),
    makeIncident({ id: "c", severity: "critical", disaster_type: "fire" }),
  ];

  it("returns everything for 'all' filters, preserving order", () => {
    expect(filterIncidents(incidents, {}).map((incident) => incident.id)).toEqual(["a", "b", "c"]);
  });

  it("filters by exact severity and by type", () => {
    expect(filterIncidents(incidents, { severity: "critical" }).map((incident) => incident.id)).toEqual(["b", "c"]);
    expect(filterIncidents(incidents, { severity: "critical", type: "fire" }).map((incident) => incident.id)).toEqual([
      "c",
    ]);
  });
});

describe("replaceIncident", () => {
  it("swaps the matching incident and leaves the others untouched", () => {
    const list = [makeIncident({ id: "a" }), makeIncident({ id: "b", upvotes: 1 })];
    const updated = makeIncident({ id: "b", upvotes: 5 });
    const result = replaceIncident(list, updated);
    expect(result[0]).toBe(list[0]);
    expect(result[1]).toBe(updated);
    expect(list[1]?.upvotes).toBe(1);
  });
});
