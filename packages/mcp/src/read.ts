/**
 * Read tools for projects, plans and teams.
 *
 * Shapes are built for a reader, not mirrored from storage: ids are kept (so a
 * follow-up call can name things exactly) but every id that points elsewhere
 * comes with the name it points to, and the stored plan is summarised by epic
 * and by person as well as listed assignment by assignment.
 */
import {
  allMembers,
  baselinePlans,
  includedTeams,
  planOptionsFor,
  runPlan,
  type AppState,
  type ID,
  type Plan,
  type Project,
  type Team,
} from "@planner/core";
import type { ToolContext } from "./context";
import { findProject, findTeam } from "./resolve";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function plannable(project: Project) {
  return project.epics.flatMap((e) => e.tasks.filter((t) => !t.excluded));
}

function estimateTotal(project: Project): number {
  return round2(plannable(project).reduce((s, t) => s + t.estimateDays, 0));
}

function span(dates: { start: string; end: string }[]): {
  start: string | null;
  end: string | null;
} {
  let start: string | null = null;
  let end: string | null = null;
  for (const d of dates) {
    if (start === null || d.start < start) start = d.start;
    if (end === null || d.end > end) end = d.end;
  }
  return { start, end };
}

function memberNames(state: AppState): Map<ID, string> {
  const out = new Map<ID, string>();
  for (const m of allMembers(state.teams)) out.set(m.id, m.name);
  return out;
}

/** A plan by epic, by person, and assignment by assignment. */
export function planSummary(plan: Plan, includeAssignments = true) {
  const byEpic = new Map<
    ID,
    { epicId: ID; epicName: string; dates: { start: string; end: string }[] }
  >();
  const byMember = new Map<
    ID,
    {
      memberId: ID;
      memberName: string;
      workDays: number;
      dates: { start: string; end: string }[];
    }
  >();
  for (const a of plan.assignments) {
    const e = byEpic.get(a.epicId) ?? {
      epicId: a.epicId,
      epicName: a.epicName,
      dates: [],
    };
    e.dates.push(a);
    byEpic.set(a.epicId, e);
    const m = byMember.get(a.memberId) ?? {
      memberId: a.memberId,
      memberName: a.memberName,
      workDays: 0,
      dates: [],
    };
    m.workDays += a.workDays;
    m.dates.push(a);
    byMember.set(a.memberId, m);
  }
  const whole = span(plan.assignments);
  return {
    generatedAt: plan.generatedAt,
    start: whole.start,
    end: whole.end,
    roundingBufferDays: round2(plan.roundingBufferDays ?? 0),
    epics: [...byEpic.values()].map(({ dates, ...e }) => ({
      ...e,
      ...span(dates),
      tasks: dates.length,
    })),
    people: [...byMember.values()].map(({ dates, ...m }) => ({
      ...m,
      ...span(dates),
      tasks: dates.length,
    })),
    ...(includeAssignments
      ? {
          assignments: plan.assignments.map((a) => ({
            taskId: a.taskId,
            taskName: a.taskName,
            epicName: a.epicName,
            specialization: a.specialization,
            estimateDays: a.estimateDays,
            workDays: a.workDays,
            memberId: a.memberId,
            memberName: a.memberName,
            start: a.start,
            end: a.end,
          })),
        }
      : {}),
    unassigned: plan.unassigned.map((u) => ({
      taskId: u.id,
      taskName: u.name,
      epicName: u.epicName,
      specialization: u.specialization,
      estimateDays: u.estimateDays,
      reason: u.reason,
    })),
  };
}

function linkedTrackers(state: AppState, projectId: ID) {
  return (state.trackers ?? [])
    .filter((t) => t.projectId === projectId)
    .map((t) => ({ id: t.id, name: t.name, initiativeKey: t.initiativeKey }));
}

export function listProjects(ctx: ToolContext) {
  const { state } = ctx;
  return {
    projects: state.projects.map((p) => {
      const whole = p.plan ? span(p.plan.assignments) : null;
      return {
        id: p.id,
        name: p.name,
        startDate: p.startDate,
        ...(p.note ? { note: p.note } : {}),
        epics: p.epics.length,
        tasks: p.epics.reduce((s, e) => s + e.tasks.length, 0),
        estimateDays: estimateTotal(p),
        bufferPercent: p.buffer ?? 0,
        planMode: p.planMode ?? "balanced",
        teams: includedTeams(p, state.teams).map((t) => t.name),
        plan:
          p.plan && whole
            ? {
                generatedAt: p.plan.generatedAt,
                start: whole.start,
                end: whole.end,
                assignments: p.plan.assignments.length,
                unassigned: p.plan.unassigned.length,
              }
            : null,
        trackers: linkedTrackers(state, p.id),
      };
    }),
  };
}

/** Everything about one project, with names next to every id. */
export function projectDetail(
  ctx: ToolContext,
  project: Project,
  includeAssignments = true,
) {
  const { state } = ctx;
  const names = memberNames(state);
  const epicName = new Map(project.epics.map((e) => [e.id, e.name]));
  const taskName = new Map(
    project.epics.flatMap((e) => e.tasks.map((t) => [t.id, t.name] as const)),
  );
  const ref = (map: Map<ID, string>) => (id: ID) => ({
    id,
    name: map.get(id) ?? "(missing)",
  });
  const starts = project.memberStarts ?? {};
  const teamView = (team: Team) =>
    team.members.map((m) => ({
      id: m.id,
      name: m.name,
      specialization: m.specialization,
      speed: m.speed ?? 1,
      ...(starts[m.id] ? { startsOn: starts[m.id] } : {}),
    }));

  const teams = project.teamInclusions
    ? project.teamInclusions.flatMap((inc) => {
        const team = state.teams.find((t) => t.id === inc.teamId);
        if (!team) return [];
        return [
          {
            teamId: team.id,
            name: team.name,
            ...(inc.epicIds?.length
              ? {
                  onlyEpics: inc.epicIds.map(ref(epicName)),
                  exclusive: inc.exclusive ?? false,
                }
              : {}),
            ...(inc.availableFrom ? { availableFrom: inc.availableFrom } : {}),
            ...(inc.availableTo ? { availableTo: inc.availableTo } : {}),
            velocity: inc.velocity ?? 1,
            members: teamView(team),
          },
        ];
      })
    : state.teams.map((team) => ({
        teamId: team.id,
        name: team.name,
        velocity: 1,
        members: teamView(team),
      }));

  let planStale: boolean | null = null;
  if (project.plan) {
    try {
      planStale = baselinePlans(project, state.teams).stale;
    } catch {
      planStale = null;
    }
  }

  return {
    id: project.id,
    name: project.name,
    startDate: project.startDate,
    ...(project.note ? { note: project.note } : {}),
    bufferPercent: project.buffer ?? 0,
    planMode: project.planMode ?? "balanced",
    ...(project.planMode === "smart"
      ? { planLookahead: project.planLookahead ?? 5 }
      : {}),
    planViewMode: project.planViewMode,
    allTeamsParticipate: project.teamInclusions === undefined,
    teams,
    helpers: (project.helpers ?? []).map((h) => ({
      id: h.id,
      name: h.name,
      specialization: h.specialization,
      speed: h.speed,
      availableFrom: h.availableFrom,
      availableTo: h.availableTo,
      offDays: h.offDays ?? [],
    })),
    estimateDays: estimateTotal(project),
    epics: project.epics.map((e) => ({
      id: e.id,
      name: e.name,
      estimateDays: round2(
        e.tasks
          .filter((t) => !t.excluded)
          .reduce((s, t) => s + t.estimateDays, 0),
      ),
      dependsOn: (e.dependsOn ?? []).map(ref(epicName)),
      assignedMembers: (project.epicAssignments?.[e.id] ?? []).map(ref(names)),
      tasks: e.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        estimateDays: t.estimateDays,
        specialization: t.specialization,
        excluded: t.excluded,
        dependsOn: (t.dependsOn ?? []).map(ref(taskName)),
      })),
    })),
    plan: project.plan ? planSummary(project.plan, includeAssignments) : null,
    /** True when re-running the plan now would give a different finish. */
    planStale,
    trackers: linkedTrackers(state, project.id),
  };
}

export function getProject(
  ctx: ToolContext,
  args: { project: string; include_assignments?: boolean },
) {
  const project = findProject(ctx.state, args.project);
  return projectDetail(ctx, project, args.include_assignments ?? true);
}

/** What Run Plan would produce now, compared with the stored plan. Saves nothing. */
export function previewPlan(ctx: ToolContext, args: { project: string }) {
  const project = findProject(ctx.state, args.project);
  const fresh = runPlan(
    project,
    ctx.state.teams,
    ctx.now,
    planOptionsFor(project),
  );
  const stored = project.plan ? span(project.plan.assignments) : null;
  const next = span(fresh.assignments);
  return {
    project: { id: project.id, name: project.name },
    storedPlan: project.plan
      ? {
          generatedAt: project.plan.generatedAt,
          start: stored?.start ?? null,
          end: stored?.end ?? null,
          unassigned: project.plan.unassigned.length,
        }
      : null,
    preview: planSummary(fresh, true),
    endChanged: (stored?.end ?? null) !== next.end,
  };
}

export function listTeams(
  ctx: ToolContext,
  args: { team?: string; off_days_from?: string },
) {
  const { state } = ctx;
  const teams = args.team ? [findTeam(state, args.team)] : state.teams;
  const from = args.off_days_from;
  return {
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      ...(team.jira
        ? {
            jira: {
              teamName: team.jira.teamName,
              site: team.jira.baseUrl,
              syncedAt: team.jira.syncedAt,
            },
          }
        : {}),
      projects: state.projects
        .filter((p) =>
          includedTeams(p, state.teams).some((t) => t.id === team.id),
        )
        .map((p) => ({ id: p.id, name: p.name })),
      members: team.members.map((m) => ({
        id: m.id,
        name: m.name,
        specialization: m.specialization,
        speed: m.speed ?? 1,
        offDays: [...(team.offDays[m.id] ?? [])]
          .filter((d) => !from || d >= from)
          .sort(),
      })),
    })),
  };
}
