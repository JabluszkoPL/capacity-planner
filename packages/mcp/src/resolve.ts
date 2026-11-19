/**
 * Finding things by what a person (or a model) would call them.
 *
 * Every tool argument that names an entity takes its id or its name. Ids win;
 * a name matches ignoring case and extra spaces, and must be unique - an
 * ambiguous name is refused with the candidates' ids rather than guessed.
 */
import {
  allMembers,
  findMemberTeam,
  type AppState,
  type Epic,
  type Project,
  type TaskItem,
  type Team,
  type TeamMember,
  type Tracker,
} from "@planner/core";
import { ToolError } from "./context";

export function normName(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pick<T extends { id: string; name: string }>(
  items: readonly T[],
  ref: string,
  kind: string,
  where = "",
): T {
  const byId = items.find((i) => i.id === ref);
  if (byId) return byId;
  const key = normName(ref);
  const hits = items.filter((i) => normName(i.name) === key);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new ToolError(
      `${hits.length} ${kind}s${where} are named "${ref}". Pass one of these ids instead: ${hits
        .map((h) => h.id)
        .join(", ")}.`,
    );
  }
  const known = items.slice(0, 25).map((i) => `"${i.name}"`);
  throw new ToolError(
    `No ${kind}${where} matches "${ref}".${
      known.length
        ? ` Known: ${known.join(", ")}${items.length > 25 ? ", …" : ""}.`
        : ` There are none.`
    }`,
  );
}

export function findProject(state: AppState, ref: string): Project {
  return pick(state.projects, ref, "project");
}

export function findTeam(state: AppState, ref: string): Team {
  return pick(state.teams, ref, "team");
}

export function findTracker(state: AppState, ref: string): Tracker {
  return pick(state.trackers ?? [], ref, "tracker");
}

export function findMember(
  state: AppState,
  ref: string,
): { member: TeamMember; team: Team } {
  const member = pick(allMembers(state.teams), ref, "team member");
  const team = findMemberTeam(state.teams, member.id);
  if (!team) throw new ToolError(`Team member "${ref}" has no team.`);
  return { member, team };
}

export function findEpic(project: Project, ref: string): Epic {
  return pick(project.epics, ref, "epic", ` in "${project.name}"`);
}

/**
 * A task in a project, optionally narrowed to one epic (task names often
 * repeat across epics: "QA pass", "Design").
 */
export function findTask(
  project: Project,
  ref: string,
  epicRef?: string,
): { epic: Epic; task: TaskItem } {
  const epics = epicRef ? [findEpic(project, epicRef)] : project.epics;
  const all = epics.flatMap((epic) =>
    epic.tasks.map((task) => ({ id: task.id, name: task.name, epic, task })),
  );
  const where = epicRef
    ? ` in epic "${epics[0].name}"`
    : ` in "${project.name}"`;
  const hit = pick(all, ref, "task", where);
  return { epic: hit.epic, task: hit.task };
}
