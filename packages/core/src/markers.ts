/**
 * Plan markers: named dates (an alpha gate, a beta gate, an internal test)
 * drawn on a project's timelines. They are annotations only; the scheduler
 * never reads them.
 */
import type { PlanMarker, Project } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every well-formed marker of a project, sorted by date then name. An entry
 * with no name or no ISO date (an imported file, a newer client) is left out
 * rather than breaking a timeline.
 */
export function planMarkersOf(project: Project): PlanMarker[] {
  const list = Array.isArray(project.markers) ? project.markers : [];
  return list
    .filter(
      (m): m is PlanMarker =>
        typeof m === "object" &&
        m !== null &&
        typeof m.id === "string" &&
        typeof m.name === "string" &&
        m.name.trim() !== "" &&
        typeof m.date === "string" &&
        ISO_DATE.test(m.date),
    )
    .sort((a, b) =>
      a.date === b.date
        ? a.name.localeCompare(b.name)
        : a.date < b.date
          ? -1
          : 1,
    );
}

/** The markers the timelines draw: none while the project hides them. */
export function visiblePlanMarkers(project: Project): PlanMarker[] {
  return project.hideMarkers ? [] : planMarkersOf(project);
}
