import { describe, expect, it } from "vitest";
import { planMarkersOf, visiblePlanMarkers } from "./markers";
import type { PlanMarker, Project } from "./types";

function project(markers: unknown, hideMarkers?: boolean): Project {
  return {
    id: "p1",
    name: "P",
    startDate: "2026-01-05",
    epics: [],
    plan: null,
    planViewMode: "person",
    markers: markers as PlanMarker[],
    hideMarkers,
  };
}

describe("planMarkersOf", () => {
  it("is empty when a project has no markers", () => {
    expect(planMarkersOf(project(undefined))).toEqual([]);
  });

  it("sorts by date, then by name", () => {
    const sorted = planMarkersOf(
      project([
        { id: "b", name: "Beta gate", date: "2026-03-01" },
        { id: "z", name: "Internal test", date: "2026-02-01" },
        { id: "a", name: "Alpha gate", date: "2026-02-01" },
      ]),
    );
    expect(sorted.map((m) => m.id)).toEqual(["a", "z", "b"]);
  });

  it("leaves out malformed entries", () => {
    const kept = planMarkersOf(
      project([
        { id: "ok", name: "Alpha", date: "2026-02-01" },
        { id: "noname", name: "  ", date: "2026-02-01" },
        { id: "nodate", name: "Beta", date: "soon" },
        null,
        "junk",
      ]),
    );
    expect(kept.map((m) => m.id)).toEqual(["ok"]);
  });
});

describe("visiblePlanMarkers", () => {
  const markers = [{ id: "a", name: "Alpha", date: "2026-02-01" }];

  it("shows markers unless the project hides them", () => {
    expect(visiblePlanMarkers(project(markers))).toHaveLength(1);
    expect(visiblePlanMarkers(project(markers, true))).toEqual([]);
  });
});
