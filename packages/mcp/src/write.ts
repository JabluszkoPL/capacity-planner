/**
 * Write tools: each one turns a request into the store actions the UI would
 * dispatch for the same edit.
 *
 * Nothing here writes anything. A tool returns its {@link Action}s and the
 * window dispatches them, so an AI client's edit is indistinguishable from a
 * click: same reducer, same diff into ops, same HLC stamp, same sync. The tool
 * also runs those actions through the reducer itself to report the outcome
 * (the new finish date, the off-days now on file).
 *
 * Deliberately missing: deleting projects, teams, members, trackers, epics or
 * tasks. There is no undo in the app; a task can be skipped (`excluded`)
 * instead, and `copy_project` gives a scenario to experiment on.
 */
import type { Action } from "@planner/client-runtime/actions";
import {
  addDays,
  fromISO,
  includedTeams,
  isWeekend,
  planOptionsFor,
  runPlan,
  toISO,
  type AppState,
  type ID,
  type Project,
  type TeamInclusion,
} from "@planner/core";
import {
  applyActions,
  ToolError,
  type ToolContext,
  type ToolOutcome,
} from "./context";
import { planSummary } from "./read";
import {
  findEpic,
  findMember,
  findProject,
  findTask,
  findTeam,
} from "./resolve";

/** Longest date range one off-day entry may expand to, in calendar days. */
const MAX_RANGE_DAYS = 366;

function projectAfter(state: AppState, id: ID): Project {
  const p = state.projects.find((x) => x.id === id);
  if (!p) throw new ToolError("The project disappeared while it was changed.");
  return p;
}

function planEnd(project: Project): string | null {
  let end: string | null = null;
  for (const a of project.plan?.assignments ?? []) {
    if (end === null || a.end > end) end = a.end;
  }
  return end;
}

function outcome(
  ctx: ToolContext,
  actions: Action[],
  describe: (next: AppState) => unknown,
  notice: string,
  navigate?: string,
): ToolOutcome {
  const next = applyActions(ctx, actions);
  return {
    result:
      actions.length === 0
        ? { changed: false, ...asObject(describe(next)) }
        : describe(next),
    actions,
    notice: actions.length ? notice : undefined,
    navigate,
  };
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : { value: v };
}

/** Projects whose stored plan involves this member: they want a re-run. */
function plansWithMember(state: AppState, memberId: ID) {
  return state.projects
    .filter((p) => p.plan?.assignments.some((a) => a.memberId === memberId))
    .map((p) => ({ id: p.id, name: p.name }));
}

/* ------------------------------- projects -------------------------------- */

export function createProject(
  ctx: ToolContext,
  args: { name: string; start_date: string; teams?: string[] },
): ToolOutcome {
  const id = ctx.newId();
  const name = args.name.trim();
  const teams = (args.teams ?? []).map((t) => findTeam(ctx.state, t));
  const actions: Action[] = [
    { type: "createProject", id, name, startDate: args.start_date },
    ...[...new Set(teams.map((t) => t.id))].map((teamId): Action => ({
      type: "toggleTeamIncluded",
      projectId: id,
      teamId,
    })),
  ];
  return outcome(
    ctx,
    actions,
    (next) => {
      const p = projectAfter(next, id);
      return {
        project: { id, name: p.name, startDate: p.startDate },
        teams: includedTeams(p, next.teams).map((t) => t.name),
      };
    },
    `Created project "${name}"`,
    `/project/${id}`,
  );
}

export function copyProject(
  ctx: ToolContext,
  args: { project: string; name?: string },
): ToolOutcome {
  const source = findProject(ctx.state, args.project);
  const id = ctx.newId();
  const name = args.name?.trim() || `${source.name} (Copy)`;
  const actions: Action[] = [
    { type: "copyProject", sourceId: source.id, newId: id },
    { type: "renameProject", id, name },
  ];
  return outcome(
    ctx,
    actions,
    () => ({
      project: { id, name },
      copiedFrom: { id: source.id, name: source.name },
      note: "The copy has no plan yet; call run_plan on it. Epic and task ids in the copy are new - read them with get_project.",
    }),
    `Copied "${source.name}" to "${name}"`,
    `/project/${id}`,
  );
}

export function updateProject(
  ctx: ToolContext,
  args: {
    project: string;
    name?: string;
    start_date?: string;
    buffer_percent?: number;
    note?: string;
    plan_mode?: "balanced" | "smart";
    lookahead?: number;
  },
): ToolOutcome {
  const p = findProject(ctx.state, args.project);
  const actions: Action[] = [];
  if (
    args.name !== undefined &&
    args.name.trim() &&
    args.name.trim() !== p.name
  ) {
    actions.push({ type: "renameProject", id: p.id, name: args.name.trim() });
  }
  if (args.start_date !== undefined && args.start_date !== p.startDate) {
    actions.push({
      type: "setProjectStartDate",
      id: p.id,
      startDate: args.start_date,
    });
  }
  if (
    args.buffer_percent !== undefined &&
    Math.round(args.buffer_percent) !== (p.buffer ?? 0)
  ) {
    actions.push({
      type: "setProjectBuffer",
      id: p.id,
      buffer: args.buffer_percent,
    });
  }
  if (args.note !== undefined && args.note !== (p.note ?? "")) {
    actions.push({ type: "setProjectNote", id: p.id, note: args.note });
  }
  if (args.plan_mode !== undefined || args.lookahead !== undefined) {
    if (
      args.lookahead !== undefined &&
      (args.plan_mode ?? p.planMode) !== "smart"
    ) {
      throw new ToolError('lookahead only applies to plan_mode "smart".');
    }
    actions.push({
      type: "setPlanMode",
      projectId: p.id,
      mode: args.plan_mode ?? p.planMode ?? "balanced",
      lookahead: args.lookahead,
    });
  }
  return outcome(
    ctx,
    actions,
    (next) => {
      const q = projectAfter(next, p.id);
      return {
        project: {
          id: q.id,
          name: q.name,
          startDate: q.startDate,
          bufferPercent: q.buffer ?? 0,
          note: q.note ?? "",
          planMode: q.planMode ?? "balanced",
          ...(q.planMode === "smart"
            ? { lookahead: q.planLookahead ?? 5 }
            : {}),
        },
        planNeedsRerun:
          q.plan !== null &&
          (q.startDate !== p.startDate ||
            q.buffer !== p.buffer ||
            q.planMode !== p.planMode ||
            q.planLookahead !== p.planLookahead),
      };
    },
    `Updated project "${p.name}"`,
  );
}

export function runPlanTool(
  ctx: ToolContext,
  args: { project: string },
): ToolOutcome {
  const p = findProject(ctx.state, args.project);
  const plan = runPlan(p, ctx.state.teams, ctx.now, planOptionsFor(p));
  const previousEnd = planEnd(p);
  const actions: Action[] = [{ type: "setPlan", projectId: p.id, plan }];
  return outcome(
    ctx,
    actions,
    (next) => {
      const q = projectAfter(next, p.id);
      return {
        project: { id: p.id, name: p.name },
        previousEnd,
        end: planEnd(q),
        plan: planSummary(plan, false),
      };
    },
    `Ran the plan for "${p.name}"`,
    `/project/${p.id}`,
  );
}

/* ---------------------------- epics and tasks ----------------------------- */

export function addEpic(
  ctx: ToolContext,
  args: { project: string; name: string; depends_on?: string[] },
): ToolOutcome {
  const p = findProject(ctx.state, args.project);
  const deps = (args.depends_on ?? []).map((e) => findEpic(p, e).id);
  const epicId = ctx.newId();
  const actions: Action[] = [
    { type: "addEpic", projectId: p.id, epicId, name: args.name.trim() },
    ...[...new Set(deps)].map((dependsOnEpicId): Action => ({
      type: "toggleEpicDependency",
      projectId: p.id,
      epicId,
      dependsOnEpicId,
    })),
  ];
  return outcome(
    ctx,
    actions,
    () => ({
      epic: { id: epicId, name: args.name.trim() },
      project: { id: p.id, name: p.name },
    }),
    `Added epic "${args.name.trim()}" to "${p.name}"`,
  );
}

export function addTask(
  ctx: ToolContext,
  args: {
    project: string;
    epic: string;
    name: string;
    estimate_days: number;
    specialization: string;
    excluded?: boolean;
    depends_on?: string[];
  },
): ToolOutcome {
  const p = findProject(ctx.state, args.project);
  const epic = findEpic(p, args.epic);
  const dependsOn = [
    ...new Set((args.depends_on ?? []).map((t) => findTask(p, t).task.id)),
  ];
  const taskId = ctx.newId();
  const actions: Action[] = [
    {
      type: "addTask",
      projectId: p.id,
      epicId: epic.id,
      taskId,
      task: {
        name: args.name.trim(),
        estimateDays: args.estimate_days,
        specialization: args.specialization.trim(),
        excluded: args.excluded ?? false,
        ...(dependsOn.length ? { dependsOn } : {}),
      },
    },
  ];
  return outcome(
    ctx,
    actions,
    () => ({
      task: { id: taskId, name: args.name.trim(), epic: epic.name },
      planNeedsRerun: p.plan !== null,
    }),
    `Added task "${args.name.trim()}" to "${p.name}"`,
  );
}

export function updateTask(
  ctx: ToolContext,
  args: {
    project: string;
    task: string;
    epic?: string;
    name?: string;
    estimate_days?: number;
    specialization?: string;
    excluded?: boolean;
    depends_on?: string[];
  },
): ToolOutcome {
  const p = findProject(ctx.state, args.project);
  const { epic, task } = findTask(p, args.task, args.epic);
  const patch: Record<string, unknown> = {};
  if (args.name !== undefined && args.name.trim())
    patch.name = args.name.trim();
  if (args.estimate_days !== undefined) patch.estimateDays = args.estimate_days;
  if (args.specialization !== undefined && args.specialization.trim()) {
    patch.specialization = args.specialization.trim();
  }
  if (args.excluded !== undefined) patch.excluded = args.excluded;
  const actions: Action[] = [];
  if (Object.keys(patch).length) {
    actions.push({
      type: "editTask",
      projectId: p.id,
      epicId: epic.id,
      taskId: task.id,
      patch,
    });
  }
  if (args.depends_on !== undefined) {
    const ids = args.depends_on.map((t) => findTask(p, t).task.id);
    if (ids.includes(task.id)) {
      throw new ToolError("A task cannot depend on itself.");
    }
    actions.push({
      type: "setTaskDependencies",
      projectId: p.id,
      epicId: epic.id,
      taskId: task.id,
      dependsOnTaskIds: ids,
    });
  }
  return outcome(
    ctx,
    actions,
    (next) => {
      const q = projectAfter(next, p.id);
      const t = q.epics
        .find((e) => e.id === epic.id)
        ?.tasks.find((x) => x.id === task.id);
      return {
        task: t
          ? {
              id: t.id,
              name: t.name,
              epic: epic.name,
              estimateDays: t.estimateDays,
              specialization: t.specialization,
              excluded: t.excluded,
              dependsOn: t.dependsOn ?? [],
            }
          : null,
        planNeedsRerun: p.plan !== null,
      };
    },
    `Updated task "${task.name}" in "${p.name}"`,
  );
}

/* ------------------------------ teams, people ----------------------------- */

/**
 * "2026-12-24" -> that day; "2026-12-22..2026-12-31" -> its weekdays (a
 * weekend is never a working day, so marking one off would change nothing).
 */
export function expandDates(entries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    const [from, to] = entry.split("..");
    if (to === undefined) {
      out.add(from);
      continue;
    }
    let d = fromISO(from);
    const end = fromISO(to);
    for (let i = 0; d <= end; i++, d = addDays(d, 1)) {
      if (i > MAX_RANGE_DAYS) {
        throw new ToolError(`The range ${entry} is longer than a year.`);
      }
      if (!isWeekend(d)) out.add(toISO(d));
    }
  }
  return [...out].sort();
}

export function setMemberOffDays(
  ctx: ToolContext,
  args: { member: string; add?: string[]; remove?: string[]; set?: string[] },
): ToolOutcome {
  if (args.set !== undefined && (args.add || args.remove)) {
    throw new ToolError("Use either set, or add/remove - not both.");
  }
  if (args.set === undefined && !args.add && !args.remove) {
    throw new ToolError("Pass add, remove or set.");
  }
  const { member, team } = findMember(ctx.state, args.member);
  const current = new Set(team.offDays[member.id] ?? []);
  let target: Set<string>;
  if (args.set !== undefined) {
    target = new Set(expandDates(args.set));
  } else {
    target = new Set(current);
    for (const d of expandDates(args.add ?? [])) target.add(d);
    for (const d of expandDates(args.remove ?? [])) target.delete(d);
  }
  // The reducer's only off-day verb is a toggle, so the change is spelled as
  // the symmetric difference: exactly the days whose state flips.
  const flips = [
    ...[...target].filter((d) => !current.has(d)),
    ...[...current].filter((d) => !target.has(d)),
  ].sort();
  const actions: Action[] = flips.map((dateISO) => ({
    type: "toggleOffDay",
    memberId: member.id,
    dateISO,
  }));
  const added = flips.filter((d) => target.has(d));
  const removed = flips.filter((d) => !target.has(d));
  return outcome(
    ctx,
    actions,
    (next) => {
      const t = next.teams.find((x) => x.id === team.id);
      return {
        member: { id: member.id, name: member.name, team: team.name },
        added,
        removed,
        offDays: [...(t?.offDays[member.id] ?? [])].sort(),
        plansToRerun: plansWithMember(next, member.id),
      };
    },
    `Updated days off for ${member.name} (+${added.length} / −${removed.length})`,
  );
}

export function addTeamMember(
  ctx: ToolContext,
  args: { team: string; name: string; specialization: string; speed?: number },
): ToolOutcome {
  const team = findTeam(ctx.state, args.team);
  const id = ctx.newId();
  const actions: Action[] = [
    {
      type: "addTeamMember",
      teamId: team.id,
      id,
      name: args.name.trim(),
      specialization: args.specialization.trim(),
    },
  ];
  if (args.speed !== undefined && args.speed !== 1) {
    actions.push({ type: "editTeamMember", id, patch: { speed: args.speed } });
  }
  return outcome(
    ctx,
    actions,
    () => ({
      member: {
        id,
        name: args.name.trim(),
        specialization: args.specialization.trim(),
        speed: args.speed ?? 1,
        team: team.name,
      },
    }),
    `Added ${args.name.trim()} to ${team.name}`,
  );
}

export function updateTeamMember(
  ctx: ToolContext,
  args: {
    member: string;
    name?: string;
    specialization?: string;
    speed?: number;
  },
): ToolOutcome {
  const { member, team } = findMember(ctx.state, args.member);
  const patch: { name?: string; specialization?: string; speed?: number } = {};
  if (args.name?.trim()) patch.name = args.name.trim();
  if (args.specialization?.trim())
    patch.specialization = args.specialization.trim();
  if (args.speed !== undefined) patch.speed = args.speed;
  const actions: Action[] = Object.keys(patch).length
    ? [{ type: "editTeamMember", id: member.id, patch }]
    : [];
  return outcome(
    ctx,
    actions,
    (next) => {
      const m = next.teams
        .find((t) => t.id === team.id)
        ?.members.find((x) => x.id === member.id);
      return {
        member: m
          ? {
              id: m.id,
              name: m.name,
              specialization: m.specialization,
              speed: m.speed ?? 1,
              team: team.name,
            }
          : null,
        plansToRerun: plansWithMember(next, member.id),
      };
    },
    `Updated ${member.name}`,
  );
}

export function setMemberStart(
  ctx: ToolContext,
  args: { project: string; member: string; date?: string; clear?: boolean },
): ToolOutcome {
  if ((args.date === undefined) === (args.clear !== true)) {
    throw new ToolError("Pass either date, or clear: true.");
  }
  const p = findProject(ctx.state, args.project);
  const { member } = findMember(ctx.state, args.member);
  const date = args.clear ? null : (args.date ?? null);
  const actions: Action[] =
    (p.memberStarts?.[member.id] ?? null) === date
      ? []
      : [
          {
            type: "setMemberStart",
            projectId: p.id,
            memberId: member.id,
            date,
          },
        ];
  return outcome(
    ctx,
    actions,
    () => ({
      project: { id: p.id, name: p.name },
      member: { id: member.id, name: member.name },
      startsOn: date ?? p.startDate,
      planNeedsRerun: p.plan !== null,
    }),
    `Set when ${member.name} starts on "${p.name}"`,
  );
}

type InclusionField = "available_from" | "available_to" | "velocity" | "epics";

export function setTeamInclusion(
  ctx: ToolContext,
  args: {
    project: string;
    team: string;
    included?: boolean;
    available_from?: string;
    available_to?: string;
    velocity?: number;
    epics?: string[];
    exclusive?: boolean;
    clear?: InclusionField[];
  },
): ToolOutcome {
  const p = findProject(ctx.state, args.project);
  const team = findTeam(ctx.state, args.team);
  const isIn = includedTeams(p, ctx.state.teams).some((t) => t.id === team.id);
  const actions: Action[] = [];
  const wantsIn = args.included ?? true;
  const hasPatch =
    args.available_from !== undefined ||
    args.available_to !== undefined ||
    args.velocity !== undefined ||
    args.epics !== undefined ||
    args.exclusive !== undefined ||
    (args.clear?.length ?? 0) > 0;

  if (!wantsIn) {
    if (hasPatch) {
      throw new ToolError("Settings only apply to an included team.");
    }
    if (isIn) {
      actions.push({
        type: "toggleTeamIncluded",
        projectId: p.id,
        teamId: team.id,
      });
    }
  } else {
    if (!isIn) {
      actions.push({
        type: "toggleTeamIncluded",
        projectId: p.id,
        teamId: team.id,
      });
    }
    const patch: Partial<Omit<TeamInclusion, "teamId">> = {};
    if (args.available_from !== undefined)
      patch.availableFrom = args.available_from;
    if (args.available_to !== undefined) patch.availableTo = args.available_to;
    if (args.velocity !== undefined) patch.velocity = args.velocity;
    if (args.epics !== undefined) {
      patch.epicIds = [...new Set(args.epics.map((e) => findEpic(p, e).id))];
    }
    if (args.exclusive !== undefined) patch.exclusive = args.exclusive;
    for (const field of args.clear ?? []) {
      if (field === "available_from") patch.availableFrom = undefined;
      if (field === "available_to") patch.availableTo = undefined;
      if (field === "velocity") patch.velocity = undefined;
      if (field === "epics") {
        patch.epicIds = undefined;
        patch.exclusive = undefined;
      }
    }
    if (
      patch.availableFrom &&
      patch.availableTo &&
      patch.availableFrom > patch.availableTo
    ) {
      throw new ToolError("available_from must not be after available_to.");
    }
    if (Object.keys(patch).length) {
      actions.push({
        type: "updateTeamInclusion",
        projectId: p.id,
        teamId: team.id,
        patch,
      });
    }
  }
  return outcome(
    ctx,
    actions,
    (next) => {
      const q = projectAfter(next, p.id);
      const inc = q.teamInclusions?.find((i) => i.teamId === team.id);
      const epicName = new Map(q.epics.map((e) => [e.id, e.name]));
      return {
        project: { id: p.id, name: p.name },
        team: { id: team.id, name: team.name },
        included: includedTeams(q, next.teams).some((t) => t.id === team.id),
        ...(inc
          ? {
              availableFrom: inc.availableFrom ?? null,
              availableTo: inc.availableTo ?? null,
              velocity: inc.velocity ?? 1,
              onlyEpics: (inc.epicIds ?? []).map(
                (id) => epicName.get(id) ?? id,
              ),
              exclusive: inc.exclusive ?? false,
            }
          : {}),
        planNeedsRerun: p.plan !== null,
      };
    },
    `Updated ${team.name} on "${p.name}"`,
  );
}

export function addHelper(
  ctx: ToolContext,
  args: {
    project: string;
    name: string;
    specialization: string;
    speed?: number;
    available_from: string;
    available_to: string;
    off_days?: string[];
  },
): ToolOutcome {
  const p = findProject(ctx.state, args.project);
  if (args.available_from > args.available_to) {
    throw new ToolError("available_from must not be after available_to.");
  }
  const helperId = ctx.newId();
  const offDays = expandDates(args.off_days ?? []);
  const actions: Action[] = [
    {
      type: "addHelper",
      projectId: p.id,
      helperId,
      helper: {
        name: args.name.trim(),
        specialization: args.specialization.trim(),
        speed: args.speed ?? 1,
        availableFrom: args.available_from,
        availableTo: args.available_to,
        ...(offDays.length ? { offDays } : {}),
      },
    },
  ];
  return outcome(
    ctx,
    actions,
    () => ({
      helper: { id: helperId, name: args.name.trim() },
      project: { id: p.id, name: p.name },
      planNeedsRerun: p.plan !== null,
    }),
    `Added helper ${args.name.trim()} to "${p.name}"`,
  );
}
