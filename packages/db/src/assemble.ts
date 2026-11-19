/**
 * Entries -> AppState.
 *
 * An "entry" is one synced row's identity plus its payload, which is the same
 * thing whether it came out of SQLite or was projected from an in-memory
 * AppState. Assembling from entries — rather than from rows — means the
 * database read path and the canonicalisation used by the differ are literally
 * the same code, so they can't disagree about, say, whether an empty helper
 * list is `[]` or absent.
 */
import type { EntityKind } from "@planner/contracts";
import type {
  AppState,
  Epic,
  Helper,
  JiraSnapshot,
  JiraTeamSource,
  Plan,
  Project,
  SprintDraft,
  TrackerDeadlines,
  TaskItem,
  Team,
  TeamInclusion,
  TeamMember,
  Tracker,
  TrackerSample,
} from "@planner/core";
import { planViewModeOf } from "@planner/core";
import type { Payload } from "./rows";

export interface Entry {
  entity: EntityKind;
  id: string;
  payload: Payload;
}

const pos = (e: Entry): number => {
  const p = e.payload.position;
  return typeof p === "number" ? p : 0;
};

function ordered(entries: Entry[]): Entry[] {
  return [...entries].sort(
    (a, b) => pos(a) - pos(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Strip keys whose value is undefined, so "absent means default" holds. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] === undefined) delete o[k];
  }
  return o;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

const optString = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/**
 * A team's Jira origin, read defensively: it arrives from other devices, and a
 * malformed one should make the team read as hand-made, not break the roster.
 */
function jiraTeamSource(v: unknown): JiraTeamSource | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const baseUrl = optString(o.baseUrl);
  const teamName = optString(o.teamName);
  if (!baseUrl || !teamName) return undefined;
  return compact({
    baseUrl,
    orgId: optString(o.orgId),
    teamId: optString(o.teamId),
    teamName,
    syncedAt: typeof o.syncedAt === "string" ? o.syncedAt : "",
  });
}

export function assemble(source: Iterable<Entry>): AppState {
  const byKind = new Map<EntityKind, Entry[]>();
  for (const e of source) {
    const list = byKind.get(e.entity);
    if (list) list.push(e);
    else byKind.set(e.entity, [e]);
  }
  const of = (k: EntityKind): Entry[] => ordered(byKind.get(k) ?? []);

  const groupBy = (entries: Entry[], key: string): Map<string, Entry[]> => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      const k = String(e.payload[key] ?? "");
      const list = m.get(k);
      if (list) list.push(e);
      else m.set(k, [e]);
    }
    return m;
  };

  const membersByTeam = groupBy(of("member"), "teamId");
  const epicsByProject = groupBy(of("epic"), "projectId");
  const tasksByEpic = groupBy(of("task"), "epicId");
  const helpersByProject = groupBy(of("helper"), "projectId");
  const inclusionsByProject = groupBy(of("team_inclusion"), "projectId");
  const planById = new Map(
    of("plan").map((e) => [e.id, e.payload.plan as Plan | null]),
  );

  const teams: Team[] = of("team").map((te) => {
    const members: TeamMember[] = [];
    const offDays: Record<string, string[]> = {};
    for (const me of membersByTeam.get(te.id) ?? []) {
      members.push(
        compact({
          id: me.id,
          name: String(me.payload.name ?? ""),
          specialization: String(me.payload.specialization ?? ""),
          speed: me.payload.speed as number | undefined,
          jiraAccountId: optString(me.payload.jiraAccountId),
        }),
      );
      const days = arr(me.payload.offDays);
      if (days.length > 0) offDays[me.id] = days;
    }
    return compact({
      id: te.id,
      name: String(te.payload.name ?? ""),
      members,
      offDays,
      jira: jiraTeamSource(te.payload.jira),
    });
  });

  const projects: Project[] = of("project").map((pe) => {
    const epicAssignments: Record<string, string[]> = {};

    const epics: Epic[] = (epicsByProject.get(pe.id) ?? []).map((ee) => {
      const assigned = arr(ee.payload.assignedMemberIds);
      if (assigned.length > 0) epicAssignments[ee.id] = assigned;
      const tasks: TaskItem[] = (tasksByEpic.get(ee.id) ?? []).map((te) => {
        const dependsOn = arr(te.payload.dependsOn);
        return compact({
          id: te.id,
          name: String(te.payload.name ?? ""),
          estimateDays: Number(te.payload.estimateDays ?? 0),
          specialization: String(te.payload.specialization ?? ""),
          excluded: te.payload.excluded === true,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        });
      });
      const deps = arr(ee.payload.dependsOn);
      return compact({
        id: ee.id,
        name: String(ee.payload.name ?? ""),
        tasks,
        dependsOn: deps.length > 0 ? deps : undefined,
      });
    });

    const helpers: Helper[] = (helpersByProject.get(pe.id) ?? []).map((he) => {
      const days = arr(he.payload.offDays);
      return compact({
        id: he.id,
        name: String(he.payload.name ?? ""),
        specialization: String(he.payload.specialization ?? ""),
        speed: Number(he.payload.speed ?? 1),
        availableFrom: String(he.payload.availableFrom ?? ""),
        availableTo: String(he.payload.availableTo ?? ""),
        offDays: days.length > 0 ? days : undefined,
      });
    });

    const inclusionEntries = inclusionsByProject.get(pe.id) ?? [];
    const teamInclusions: TeamInclusion[] = inclusionEntries.map((ie) =>
      compact({
        teamId: String(ie.payload.teamId ?? ""),
        epicIds: ie.payload.epicIds as string[] | undefined,
        exclusive: ie.payload.exclusive as boolean | undefined,
        availableFrom: ie.payload.availableFrom as string | undefined,
        availableTo: ie.payload.availableTo as string | undefined,
        velocity: ie.payload.velocity as number | undefined,
      }),
    );

    const memberStarts = (pe.payload.memberStarts ?? {}) as Record<
      string,
      string
    >;

    return compact({
      id: pe.id,
      name: String(pe.payload.name ?? ""),
      startDate: String(pe.payload.startDate ?? ""),
      note: pe.payload.note as string | undefined,
      titleColor: pe.payload.titleColor as string | undefined,
      epics,
      plan: planById.get(pe.id) ?? null,
      planViewMode: planViewModeOf(pe.payload.planViewMode),
      planMode: pe.payload.planMode as "balanced" | "smart" | undefined,
      planLookahead: pe.payload.planLookahead as number | undefined,
      buffer: pe.payload.buffer as number | undefined,
      helpers: helpers.length > 0 ? helpers : undefined,
      memberStarts:
        Object.keys(memberStarts).length > 0 ? memberStarts : undefined,
      epicAssignments:
        Object.keys(epicAssignments).length > 0 ? epicAssignments : undefined,
      teamInclusions: teamInclusions.length > 0 ? teamInclusions : undefined,
    });
  });

  const trackers: Tracker[] = of("tracker").map((tr) => {
    const epicMap = (tr.payload.epicMap ?? {}) as Record<string, string | null>;
    const taskMap = (tr.payload.taskMap ?? {}) as Record<string, string | null>;
    const addedScope = (tr.payload.addedScope ?? {}) as Record<string, string>;
    const untrackedEpics = Array.isArray(tr.payload.untrackedEpics)
      ? (tr.payload.untrackedEpics as string[])
      : [];
    const viewTeams = Array.isArray(tr.payload.viewTeams)
      ? (tr.payload.viewTeams as string[])
      : [];
    const taskTeams = (tr.payload.taskTeams ?? {}) as Record<string, string>;
    const samples = Array.isArray(tr.payload.samples)
      ? (tr.payload.samples as TrackerSample[])
      : [];
    return compact({
      id: tr.id,
      name: String(tr.payload.name ?? ""),
      initiativeUrl: String(tr.payload.initiativeUrl ?? ""),
      initiativeKey: String(tr.payload.initiativeKey ?? ""),
      baseUrl: String(tr.payload.baseUrl ?? ""),
      projectId: tr.payload.projectId as string | undefined,
      hoursPerDay: tr.payload.hoursPerDay as number | undefined,
      epicMap: Object.keys(epicMap).length > 0 ? epicMap : undefined,
      taskMap: Object.keys(taskMap).length > 0 ? taskMap : undefined,
      addedScope: Object.keys(addedScope).length > 0 ? addedScope : undefined,
      untrackedEpics: untrackedEpics.length > 0 ? untrackedEpics : undefined,
      viewTeams: viewTeams.length > 0 ? viewTeams : undefined,
      taskTeams: Object.keys(taskTeams).length > 0 ? taskTeams : undefined,
      snapshot: (tr.payload.snapshot ?? undefined) as JiraSnapshot | undefined,
      samples: samples.length > 0 ? samples : undefined,
      sprintDraft: (tr.payload.sprintDraft ?? undefined) as
        SprintDraft | undefined,
      deadlines: (tr.payload.deadlines ?? undefined) as
        TrackerDeadlines | undefined,
    });
  });

  // Absent rather than `[]`, so a state that predates tracking and one whose
  // trackers were all deleted are the same value — the model reads an absent
  // list as an empty one, and `toEqual` does not.
  return compact({
    projects,
    teams,
    trackers: trackers.length > 0 ? trackers : undefined,
  });
}
