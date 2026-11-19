/**
 * The one place that knows both shapes: the domain model from @planner/core and
 * the SQL columns from ./schema.
 *
 * Op payloads use the domain's camelCase names, not column names — the wire
 * protocol should survive a column rename. Every entity is described once here
 * and the generic upsert/read machinery in ./apply drives off these descriptors,
 * so adding a field is a one-line change in one file rather than four.
 */
import type { EntityKind } from "@planner/contracts";
import type {
  Epic,
  Helper,
  JiraSnapshot,
  JiraTeamSource,
  Plan,
  Project,
  SprintDraft,
  TaskItem,
  Team,
  TeamInclusion,
  TeamMember,
  Tracker,
  TrackerDeadlines,
  TrackerSample,
} from "@planner/core";
import { planViewModeOf } from "@planner/core";
import type { SqlValue } from "./driver";

export type Payload = Record<string, unknown>;
export type Row = Record<string, SqlValue>;

/** How one entity kind maps onto one table. */
export interface EntityDescriptor {
  kind: EntityKind;
  table: string;
  /** Data columns, excluding the universal id/hlc/deleted/dirty. */
  columns: string[];
  toRow(p: Payload): Row;
  fromRow(r: Row): Payload;
}

// ---------------------------------------------------------------- helpers --

const json = (v: unknown): string => JSON.stringify(v ?? null);

function parseJson<T>(v: SqlValue, fallback: T): T {
  if (typeof v !== "string" || v === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;
const optStr = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const optNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const optBool = (v: unknown): number | null =>
  typeof v === "boolean" ? (v ? 1 : 0) : null;
const bool = (v: SqlValue): boolean => v === 1 || v === 1n;

/** Drop keys whose value is null/undefined, so absent optional fields stay
 *  absent in the domain object (the model treats absent as "default"). */
function compact<T extends Payload>(p: T): T {
  for (const k of Object.keys(p)) {
    if (p[k] === null || p[k] === undefined) delete p[k];
  }
  return p;
}

// ------------------------------------------------------------ descriptors --

export const PROJECT: EntityDescriptor = {
  kind: "project",
  table: "projects",
  columns: [
    "name",
    "start_date",
    "note",
    "title_color",
    "plan_view_mode",
    "plan_mode",
    "plan_lookahead",
    "buffer",
    "member_starts",
    "position",
  ],
  toRow: (p) => ({
    name: str(p.name),
    start_date: str(p.startDate),
    note: optStr(p.note),
    title_color: optStr(p.titleColor),
    plan_view_mode: planViewModeOf(p.planViewMode),
    plan_mode: optStr(p.planMode),
    plan_lookahead: optNum(p.planLookahead),
    buffer: optNum(p.buffer),
    member_starts: json(p.memberStarts ?? {}),
    position: num(p.position),
  }),
  fromRow: (r) => ({
    name: str(r.name),
    startDate: str(r.start_date),
    note: r.note ?? undefined,
    titleColor: r.title_color ?? undefined,
    planViewMode: planViewModeOf(r.plan_view_mode),
    planMode: r.plan_mode ?? undefined,
    planLookahead: r.plan_lookahead ?? undefined,
    buffer: r.buffer ?? undefined,
    memberStarts: parseJson<Record<string, string>>(r.member_starts, {}),
    position: num(r.position),
  }),
};

export const EPIC: EntityDescriptor = {
  kind: "epic",
  table: "epics",
  columns: [
    "project_id",
    "name",
    "depends_on",
    "assigned_member_ids",
    "position",
  ],
  toRow: (p) => ({
    project_id: str(p.projectId),
    name: str(p.name),
    depends_on: json(p.dependsOn ?? []),
    assigned_member_ids: json(p.assignedMemberIds ?? []),
    position: num(p.position),
  }),
  fromRow: (r) => ({
    projectId: str(r.project_id),
    name: str(r.name),
    dependsOn: parseJson<string[]>(r.depends_on, []),
    assignedMemberIds: parseJson<string[]>(r.assigned_member_ids, []),
    position: num(r.position),
  }),
};

export const TASK: EntityDescriptor = {
  kind: "task",
  table: "tasks",
  columns: [
    "epic_id",
    "project_id",
    "name",
    "estimate_days",
    "specialization",
    "excluded",
    "depends_on",
    "position",
  ],
  toRow: (p) => ({
    epic_id: str(p.epicId),
    project_id: str(p.projectId),
    name: str(p.name),
    estimate_days: num(p.estimateDays),
    specialization: str(p.specialization),
    excluded: p.excluded ? 1 : 0,
    depends_on: json(p.dependsOn ?? []),
    position: num(p.position),
  }),
  fromRow: (r) => ({
    epicId: str(r.epic_id),
    projectId: str(r.project_id),
    name: str(r.name),
    estimateDays: num(r.estimate_days),
    specialization: str(r.specialization),
    excluded: bool(r.excluded),
    dependsOn: parseJson<string[]>(r.depends_on, []),
    position: num(r.position),
  }),
};

export const HELPER: EntityDescriptor = {
  kind: "helper",
  table: "helpers",
  columns: [
    "project_id",
    "name",
    "specialization",
    "speed",
    "available_from",
    "available_to",
    "off_days",
    "position",
  ],
  toRow: (p) => ({
    project_id: str(p.projectId),
    name: str(p.name),
    specialization: str(p.specialization),
    speed: num(p.speed),
    available_from: str(p.availableFrom),
    available_to: str(p.availableTo),
    off_days: json(p.offDays ?? []),
    position: num(p.position),
  }),
  fromRow: (r) => ({
    projectId: str(r.project_id),
    name: str(r.name),
    specialization: str(r.specialization),
    speed: num(r.speed),
    availableFrom: str(r.available_from),
    availableTo: str(r.available_to),
    offDays: parseJson<string[]>(r.off_days, []),
    position: num(r.position),
  }),
};

export const TEAM_INCLUSION: EntityDescriptor = {
  kind: "team_inclusion",
  table: "team_inclusions",
  columns: [
    "project_id",
    "team_id",
    "epic_ids",
    "exclusive",
    "available_from",
    "available_to",
    "velocity",
    "position",
  ],
  toRow: (p) => ({
    project_id: str(p.projectId),
    team_id: str(p.teamId),
    epic_ids: p.epicIds === undefined ? null : json(p.epicIds),
    exclusive: optBool(p.exclusive),
    available_from: optStr(p.availableFrom),
    available_to: optStr(p.availableTo),
    velocity: optNum(p.velocity),
    position: num(p.position),
  }),
  fromRow: (r) => ({
    projectId: str(r.project_id),
    teamId: str(r.team_id),
    epicIds:
      r.epic_ids === null ? undefined : parseJson<string[]>(r.epic_ids, []),
    exclusive: r.exclusive === null ? undefined : bool(r.exclusive),
    availableFrom: r.available_from ?? undefined,
    availableTo: r.available_to ?? undefined,
    velocity: r.velocity ?? undefined,
    position: num(r.position),
  }),
};

export const TEAM: EntityDescriptor = {
  kind: "team",
  table: "teams",
  columns: ["name", "position", "jira"],
  toRow: (p) => ({
    name: str(p.name),
    position: num(p.position),
    jira: p.jira == null ? null : json(p.jira),
  }),
  fromRow: (r) => ({
    name: str(r.name),
    position: num(r.position),
    jira:
      r.jira === null
        ? undefined
        : (parseJson<JiraTeamSource | null>(r.jira, null) ?? undefined),
  }),
};

export const MEMBER: EntityDescriptor = {
  kind: "member",
  table: "members",
  columns: [
    "team_id",
    "name",
    "specialization",
    "speed",
    "off_days",
    "position",
    "jira_account_id",
  ],
  toRow: (p) => ({
    team_id: str(p.teamId),
    name: str(p.name),
    specialization: str(p.specialization),
    speed: optNum(p.speed),
    off_days: json(p.offDays ?? []),
    position: num(p.position),
    jira_account_id: optStr(p.jiraAccountId),
  }),
  fromRow: (r) => ({
    teamId: str(r.team_id),
    name: str(r.name),
    specialization: str(r.specialization),
    speed: r.speed ?? undefined,
    offDays: parseJson<string[]>(r.off_days, []),
    position: num(r.position),
    jiraAccountId: r.jira_account_id ?? undefined,
  }),
};

export const PLAN: EntityDescriptor = {
  kind: "plan",
  table: "plans",
  columns: ["payload"],
  toRow: (p) => ({ payload: p.plan == null ? null : json(p.plan) }),
  fromRow: (r) => ({
    plan: r.payload === null ? null : parseJson<Plan | null>(r.payload, null),
  }),
};

/**
 * A tracker's snapshot, samples, epic map and sprint draft are all JSON on the
 * row, not tables of their own. Two devices refreshing the same tracker produce
 * two whole readings of Jira, and half of one merged into half of the other
 * would describe a state of the world that never existed — so the row is the
 * unit, and the later refresh wins outright.
 */
export const TRACKER: EntityDescriptor = {
  kind: "tracker",
  table: "trackers",
  columns: [
    "name",
    "initiative_url",
    "initiative_key",
    "base_url",
    "project_id",
    "hours_per_day",
    "epic_map",
    "task_map",
    "added_scope",
    "untracked_epics",
    "nice_to_have_epics",
    "view_teams",
    "task_teams",
    "snapshot",
    "samples",
    "sprint_draft",
    "deadlines",
    "position",
  ],
  toRow: (p) => ({
    name: str(p.name),
    initiative_url: str(p.initiativeUrl),
    initiative_key: str(p.initiativeKey),
    base_url: str(p.baseUrl),
    project_id: optStr(p.projectId),
    hours_per_day: optNum(p.hoursPerDay),
    epic_map: json(p.epicMap ?? {}),
    task_map: json(p.taskMap ?? {}),
    added_scope: json(p.addedScope ?? {}),
    untracked_epics: json(p.untrackedEpics ?? []),
    nice_to_have_epics: json(p.niceToHaveEpics ?? []),
    view_teams: json(p.viewTeams ?? []),
    task_teams: json(p.taskTeams ?? {}),
    // Nullable JSON: "never refreshed" has to survive the round trip as absent,
    // which `json(undefined)` would turn into the string "null" instead.
    snapshot: p.snapshot == null ? null : json(p.snapshot),
    samples: json(p.samples ?? []),
    sprint_draft: p.sprintDraft == null ? null : json(p.sprintDraft),
    deadlines: p.deadlines == null ? null : json(p.deadlines),
    position: num(p.position),
  }),
  fromRow: (r) => ({
    name: str(r.name),
    initiativeUrl: str(r.initiative_url),
    initiativeKey: str(r.initiative_key),
    baseUrl: str(r.base_url),
    projectId: r.project_id ?? undefined,
    hoursPerDay: r.hours_per_day ?? undefined,
    epicMap: parseJson<Record<string, string | null>>(r.epic_map, {}),
    taskMap: parseJson<Record<string, string | null>>(r.task_map, {}),
    addedScope: parseJson<Record<string, string>>(r.added_scope, {}),
    untrackedEpics: parseJson<string[]>(r.untracked_epics, []),
    niceToHaveEpics: parseJson<string[]>(r.nice_to_have_epics, []),
    viewTeams: parseJson<string[]>(r.view_teams, []),
    taskTeams: parseJson<Record<string, string>>(r.task_teams, {}),
    snapshot:
      r.snapshot === null
        ? undefined
        : parseJson<JiraSnapshot | undefined>(r.snapshot, undefined),
    samples: parseJson<TrackerSample[]>(r.samples, []),
    sprintDraft:
      r.sprint_draft === null
        ? undefined
        : parseJson<SprintDraft | undefined>(r.sprint_draft, undefined),
    deadlines:
      r.deadlines == null
        ? undefined
        : parseJson<TrackerDeadlines | undefined>(r.deadlines, undefined),
    position: num(r.position),
  }),
};

export const DESCRIPTORS: Record<EntityKind, EntityDescriptor> = {
  project: PROJECT,
  epic: EPIC,
  task: TASK,
  helper: HELPER,
  team_inclusion: TEAM_INCLUSION,
  team: TEAM,
  member: MEMBER,
  plan: PLAN,
  tracker: TRACKER,
};

// ------------------------------------------- domain -> payload projections --
//
// These are the inverse of the assembly in ./apply#readAppState. They exist so
// ./diff can compare "what the payload for this entity would be" between two
// AppStates without going through SQL at all.

export function projectPayload(p: Project, position: number): Payload {
  return compact({
    name: p.name,
    startDate: p.startDate,
    note: p.note,
    titleColor: p.titleColor,
    planViewMode: p.planViewMode,
    planMode: p.planMode,
    planLookahead: p.planLookahead,
    buffer: p.buffer,
    memberStarts: p.memberStarts ?? {},
    position,
  });
}

export function epicPayload(
  e: Epic,
  projectId: string,
  position: number,
  assignedMemberIds: string[],
): Payload {
  return {
    projectId,
    name: e.name,
    dependsOn: e.dependsOn ?? [],
    assignedMemberIds,
    position,
  };
}

export function taskPayload(
  t: TaskItem,
  epicId: string,
  projectId: string,
  position: number,
): Payload {
  return {
    epicId,
    projectId,
    name: t.name,
    estimateDays: t.estimateDays,
    specialization: t.specialization,
    excluded: t.excluded,
    dependsOn: t.dependsOn ?? [],
    position,
  };
}

export function helperPayload(
  h: Helper,
  projectId: string,
  position: number,
): Payload {
  return {
    projectId,
    name: h.name,
    specialization: h.specialization,
    speed: h.speed,
    availableFrom: h.availableFrom,
    availableTo: h.availableTo,
    offDays: h.offDays ?? [],
    position,
  };
}

export function inclusionPayload(
  i: TeamInclusion,
  projectId: string,
  position: number,
): Payload {
  return compact({
    projectId,
    teamId: i.teamId,
    epicIds: i.epicIds,
    exclusive: i.exclusive,
    availableFrom: i.availableFrom,
    availableTo: i.availableTo,
    velocity: i.velocity,
    position,
  });
}

export function teamPayload(t: Team, position: number): Payload {
  return compact({ name: t.name, position, jira: t.jira });
}

export function memberPayload(
  m: TeamMember,
  teamId: string,
  position: number,
  offDays: string[],
): Payload {
  return compact({
    teamId,
    name: m.name,
    specialization: m.specialization,
    speed: m.speed,
    offDays,
    position,
    jiraAccountId: m.jiraAccountId,
  });
}

export function planPayload(plan: Plan | null): Payload {
  return { plan };
}

/** Mapping fields and `samples` are normalised to `{}` / `[]` here — like
 *  `memberStarts` and `offDays` — so that a tracker whose map was emptied
 *  diffs equal to one that never had a map, rather than emitting an op. */
export function trackerPayload(t: Tracker, position: number): Payload {
  return compact({
    name: t.name,
    initiativeUrl: t.initiativeUrl,
    initiativeKey: t.initiativeKey,
    baseUrl: t.baseUrl,
    projectId: t.projectId,
    hoursPerDay: t.hoursPerDay,
    epicMap: t.epicMap ?? {},
    taskMap: t.taskMap ?? {},
    addedScope: t.addedScope ?? {},
    untrackedEpics: t.untrackedEpics ?? [],
    niceToHaveEpics: t.niceToHaveEpics ?? [],
    viewTeams: t.viewTeams ?? [],
    taskTeams: t.taskTeams ?? {},
    snapshot: t.snapshot,
    samples: t.samples ?? [],
    sprintDraft: t.sprintDraft,
    deadlines: t.deadlines,
    position,
  });
}

/** Team inclusions have no natural id in the domain model; the (project, team)
 *  pair is the identity, so that pair *is* the row id. */
export function inclusionId(projectId: string, teamId: string): string {
  return `${projectId}:${teamId}`;
}
