import {
  autoTaskMap,
  jiraTasks,
  trackerSpecializations,
  untrackedIssueKeys,
  type JiraSnapshot,
  type Project,
  type Team,
  type Tracker,
} from "@planner/core";
import {
  issueTagSpecialization,
  tagLookup,
  type TagAlias,
} from "./importProject";

export interface TrackerMapping {
  /** Jira issue -> the plan task it matched by name; `null` for added scope. */
  taskMap: NonNullable<Tracker["taskMap"]>;
  /** Jira issue -> the specialization doing it, for work not in the plan. */
  addedScope: NonNullable<Tracker["addedScope"]>;
}

/**
 * Where each Jira task of a tracker goes, worked out without asking.
 *
 * A task whose name matches a plan task counts as that plan task
 * ({@link autoTaskMap}). A task with no match is new work: added scope. Its
 * specialization comes from its tags — a Jira label, else a bracketed tag in
 * its summary — read with the same vocabulary as the Jira import (every
 * specialization the project knows, plus the built-in and the caller's
 * aliases). A new task whose tags name none is left out of both maps, and the
 * tracker shows it as unmapped until someone picks its specialization.
 *
 * A specialization already in `addedScope` is never replaced: it was either
 * picked by hand or read from the tags when the task first appeared. A `null`
 * in `taskMap` means nothing on its own any more; one without added scope is
 * dropped, so the task is matched by name again.
 *
 * Issues under untracked epics are left as they are.
 */
export function trackerMapping(input: {
  project: Project;
  teams: Team[];
  snapshot: JiraSnapshot;
  tracker: Pick<Tracker, "taskMap" | "addedScope" | "untrackedEpics">;
  tagAliases?: readonly TagAlias[];
}): TrackerMapping {
  const { project, teams, snapshot, tracker } = input;
  const skip = untrackedIssueKeys(snapshot, tracker.untrackedEpics);
  const addedScope: TrackerMapping["addedScope"] = {};
  for (const [key, spec] of Object.entries(tracker.addedScope ?? {})) {
    if (spec.trim() !== "") addedScope[key] = spec;
  }

  // Added scope is not a plan task, so name matching must never claim it.
  const seeded: TrackerMapping["taskMap"] = {};
  for (const [key, target] of Object.entries(tracker.taskMap ?? {})) {
    if (target !== null || addedScope[key]) seeded[key] = target;
  }
  for (const key of Object.keys(addedScope)) seeded[key] = null;
  const taskMap = autoTaskMap(project, snapshot, seeded, skip);

  const lookup = tagLookup(
    trackerSpecializations(project, teams),
    input.tagAliases,
  );
  for (const issue of jiraTasks(snapshot)) {
    if (skip.has(issue.key)) continue;
    if (typeof taskMap[issue.key] === "string") continue;
    if (addedScope[issue.key]) continue;
    const spec = issueTagSpecialization(issue, lookup);
    if (!spec) continue;
    addedScope[issue.key] = spec;
    taskMap[issue.key] = null;
  }
  return { taskMap, addedScope };
}
