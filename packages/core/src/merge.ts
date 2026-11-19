import type { AppState, ID, Project, Team, Tracker } from "./types";
import { newId } from "./ids";

/** What a merge did, so the UI can report it without re-deriving anything. */
export interface MergeReport {
  state: AppState;
  /** Projects appended from the incoming state. */
  addedProjects: number;
  /** Names of appended projects that had to be renamed to stay distinguishable. */
  renamedProjects: string[];
  /** Incoming teams appended because this state had never seen their id. */
  addedTeams: number;
  /** Incoming teams dropped in favour of the team already here. */
  reusedTeams: number;
  /** Incoming trackers appended because this state had never seen their id. */
  addedTrackers: number;
  /** Incoming trackers dropped in favour of the tracker already here. */
  reusedTrackers: number;
}

/**
 * Fold an imported state into the current one *additively* — nothing already
 * here is replaced, renamed, or dropped.
 *
 * This is the import path for states exported from the old browser-only
 * Planner, whose shared types are identical to ours. The point is to sit an old
 * timeline draft next to the drafts already in this app so the two can be
 * compared, which rules out the obvious "replace everything" import.
 *
 * The rules, and why:
 *
 *  - **Teams are matched by id and the local one wins.** Both states almost
 *    always describe the same real people, so appending the incoming copy would
 *    double every roster. The local team is the live one — it may have been
 *    edited here since the export — so incoming projects are simply re-pointed
 *    at it. A team whose id is genuinely new is appended.
 *
 *  - **Projects are always appended, never matched.** A project *is* the draft
 *    being compared; silently merging two drafts with the same id would destroy
 *    the comparison. On an id collision the incoming project takes a fresh id,
 *    so re-importing the same file twice yields two side-by-side copies rather
 *    than an overwrite. The only thing that refers to a project by id is a
 *    tracker's baseline, and incoming trackers are re-pointed along with it.
 *
 *  - **Colliding project names get a suffix**, because two rows reading
 *    "Q3 Draft" in the dashboard are useless for comparison.
 *
 *  - **Trackers are matched by id and the local one wins**, like teams. A
 *    tracker's `samples` are the only record of how its buffer was spent, so a
 *    tracker that came across with the file must not be lost — but the same
 *    tracker arriving twice must not be doubled either. An appended tracker
 *    follows its baseline project: if that project was imported (and maybe
 *    re-ided) it points at the imported copy; if it names a project that is
 *    in neither state, the baseline is cleared rather than left dangling.
 *    Existing trackers are never touched. An old-Planner export has none.
 *
 * A caveat worth knowing: when an incoming team is dropped as a duplicate, an
 * imported project may reference a member id the local team no longer has. The
 * scheduler just won't assign that person on a re-plan; the imported `plan` is
 * preserved verbatim and still renders, because every assignment carries
 * `memberName` alongside `memberId`.
 *
 * Pure: `makeId` is injected so tests can pin ids and so this stays free of
 * the reducer's determinism rules.
 */
export function mergeImportedState(
  current: AppState,
  incoming: AppState,
  makeId: () => ID = newId,
): MergeReport {
  const localTeamIds = new Set(current.teams.map((t) => t.id));

  const addedTeams: Team[] = [];
  let reusedTeams = 0;
  for (const team of incoming.teams) {
    if (localTeamIds.has(team.id)) {
      reusedTeams++;
    } else {
      addedTeams.push(team);
      localTeamIds.add(team.id); // an incoming list could repeat an id
    }
  }

  const usedProjectIds = new Set(current.projects.map((p) => p.id));
  const usedNames = new Set(current.projects.map((p) => p.name));

  const renamedProjects: string[] = [];
  const addedProjects: Project[] = [];
  /** Incoming project id -> the id it has after the merge. */
  const projectIdMap = new Map<ID, ID>();
  for (const project of incoming.projects) {
    let next = project;

    if (usedProjectIds.has(next.id)) {
      next = { ...next, id: makeId() };
    }
    usedProjectIds.add(next.id);
    if (!projectIdMap.has(project.id)) projectIdMap.set(project.id, next.id);

    if (usedNames.has(next.name)) {
      const name = distinctName(next.name, usedNames);
      renamedProjects.push(name);
      next = { ...next, name };
    }
    usedNames.add(next.name);

    addedProjects.push(next);
  }

  const currentTrackers = current.trackers ?? [];
  const localTrackerIds = new Set(currentTrackers.map((t) => t.id));
  const addedTrackers: Tracker[] = [];
  let reusedTrackers = 0;
  for (const tracker of incoming.trackers ?? []) {
    if (localTrackerIds.has(tracker.id)) {
      reusedTrackers++;
      continue;
    }
    localTrackerIds.add(tracker.id);
    addedTrackers.push(repointTracker(tracker, projectIdMap, usedProjectIds));
  }

  const merged: AppState = {
    ...current,
    projects: [...current.projects, ...addedProjects],
    teams: [...current.teams, ...addedTeams],
  };
  if (addedTrackers.length > 0) {
    merged.trackers = [...currentTrackers, ...addedTrackers];
  }

  return {
    state: merged,
    addedProjects: addedProjects.length,
    renamedProjects,
    addedTeams: addedTeams.length,
    reusedTeams,
    addedTrackers: addedTrackers.length,
    reusedTrackers,
  };
}

/** Point an appended tracker at its baseline as it exists after the merge. */
function repointTracker(
  tracker: Tracker,
  projectIdMap: Map<ID, ID>,
  knownProjectIds: Set<ID>,
): Tracker {
  if (tracker.projectId == null) return tracker;
  const mapped = projectIdMap.get(tracker.projectId);
  if (mapped !== undefined) {
    return mapped === tracker.projectId
      ? tracker
      : { ...tracker, projectId: mapped };
  }
  if (knownProjectIds.has(tracker.projectId)) return tracker;
  const { projectId: _gone, ...rest } = tracker;
  return rest;
}

/** "Q3 Draft" -> "Q3 Draft (imported)" -> "Q3 Draft (imported 2)" -> ... */
function distinctName(name: string, taken: Set<string>): string {
  const first = `${name} (imported)`;
  if (!taken.has(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = `${name} (imported ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
