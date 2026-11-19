import type { AppState, ID } from "./types";
import { includedTeams } from "./teams";
import { isValidAppState, migrateState } from "./validate";

/** Pretty-printed JSON of the current state. */
export function serializeState(state: AppState): string {
  return JSON.stringify(state, null, 2);
}

/**
 * One project as a self-contained export: the project, the teams it plans
 * with (so its people, speeds and days off come along), and the trackers that
 * use it as their baseline. It is an ordinary `AppState`, so Import reads it
 * back like any other export.
 *
 * Jira credentials are never in `AppState`, so none can leak through this.
 * Tracker snapshots are: they are what makes a tracker reading reproducible.
 */
export function projectExport(state: AppState, projectId: ID): AppState {
  return projectsExport(state, [projectId]);
}

/**
 * Several projects as one self-contained export — {@link projectExport}
 * generalised. Projects keep the order they have in `state` (not the order of
 * `projectIds`), and a team used by more than one selected project appears
 * once. Ids that match no project are ignored.
 *
 * Teams no selected project uses and trackers with no baseline project are
 * left out; when the user wants *everything*, export the whole state instead.
 */
export function projectsExport(
  state: AppState,
  projectIds: Iterable<ID>,
): AppState {
  const wanted = new Set(projectIds);
  const projects = state.projects.filter((p) => wanted.has(p.id));
  const exported = new Set(projects.map((p) => p.id));

  const teamIds = new Set<ID>();
  for (const project of projects) {
    for (const team of includedTeams(project, state.teams)) {
      teamIds.add(team.id);
    }
  }

  return {
    projects,
    teams: state.teams.filter((t) => teamIds.has(t.id)),
    trackers: (state.trackers ?? []).filter(
      (t) => t.projectId != null && exported.has(t.projectId),
    ),
  };
}

/**
 * Parse + validate imported JSON text into an AppState.
 * Throws an Error with a clear, user-facing message on malformed input.
 */
export function parseImportedState(text: string): AppState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  parsed = migrateState(parsed); // accept exports from the pre-multi-team shape
  if (!isValidAppState(parsed)) {
    throw new Error(
      "That file doesn't look like a Planner export (missing projects or team data).",
    );
  }
  return parsed;
}

/** A suggested export filename with today's date. */
export function exportFilename(): string {
  const now = new Date();
  const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
  const stamp =
    now.getFullYear() +
    "-" +
    pad(now.getMonth() + 1) +
    "-" +
    pad(now.getDate());
  return `planner-export-${stamp}.json`;
}
