/**
 * The work left, planned forward from today: who should pick up which task
 * next, and when each person runs out of work. Pure, like the rest of core —
 * `today` always arrives as a parameter.
 *
 * It is the baseline project re-run by the same scheduler, with these changes:
 *
 * - **Only To Do and In Progress.** Tasks Jira has finished are gone, and so
 *   are tasks waiting to be closed (in review or ready to deploy): nobody
 *   needs to pick them up. They are counted per specialization, because the
 *   tracker's status still counts them as work left until they are Done;
 *   `countWaiting: true` plans them too, at their whole estimate, to finish
 *   on the same work as the status. A task with no estimate — in the plan or in Jira — is never planned, only
 *   counted. A Jira task with no plan task is planned too, on Jira's
 *   estimate, so the finish covers all the work in the initiative, not just
 *   what was planned up front.
 * - **From today, without buffer.** Every remaining task gets its plain
 *   estimate, the same plan days the tracker measures progress in.
 * - **Work someone holds stays with them.** A task in progress in Jira,
 *   assigned to someone on the plan, is booked to that person from today for
 *   what Jira says is left of it (never more than its estimate); they are free
 *   for anything else only once it is done. A task assigned in Jira but not
 *   started yet goes to its assignee too, in its turn. Everything nobody holds
 *   is handed out by the scheduler, and marked as its suggestion. A Jira
 *   assignee is matched to a person by Jira account, by full name, or by a
 *   short name ("Michał K" for "Michał Kowalski") when only one person fits.
 *
 * A Jira task with no plan task needs a specialization to be handed out: a
 * label naming one, else a tag in its summary ("[Backend] Wallet API"), else
 * its assignee's, else the one most of its Jira epic's planned tasks have.
 * One with none of those is listed, not guessed.
 *
 * Nothing open drops out of sight: a task with no estimate is named (and, in
 * progress, shown with whoever has it) even though it cannot be laid out, and
 * work in progress Jira has nothing left on keeps its whole estimate.
 *
 * One approximation: a task that depends on a task still in progress is not
 * held back until that one finishes, since the scheduler has no way to say
 * "not before this date" for a single task.
 */

import type {
  Assignment,
  Epic,
  ID,
  JiraIssue,
  Project,
  Team,
  TaskItem,
  Tracker,
  UnassignedTask,
} from "./types";
import { addDays, fromISO, toISO } from "./dates";
import { includedTeams } from "./teams";
import { runPlan, simulateSpan } from "./scheduling";
import {
  autoTaskMap,
  isAwaitingClose,
  jiraIssueEstimate,
  jiraTasks,
  normPerson,
  planOptionsFor,
  teamScope,
  trackedMapping,
  untrackedIssueKeys,
  withAddedScope,
} from "./tracking";

/** Stamped on the plan so the same inputs always give the same output. */
const FORECAST_GENERATED_AT = "2000-01-01T00:00:00.000Z";
const DEFAULT_HOURS_PER_DAY = 8;
const EPS = 1e-9;

/** Ids for Jira tasks with no plan task, and the epics that hold them. */
const JIRA_TASK_PREFIX = "__jira__:";
const JIRA_EPIC_PREFIX = "__jira-epic__:";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function normSpec(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

/** One remaining task, placed. `estimateDays` is what is left of it. */
export interface ForecastItem extends Assignment {
  /** The Jira issues this task maps to that are not done yet. */
  jiraKeys: string[];
  /** In progress in Jira and kept with the person working on it. */
  inProgress: boolean;
  /** Who Jira has it assigned to, when anyone. */
  jiraAssignee?: string;
  /**
   * `"jira"` when it is with the person Jira has it on; `"planner"` when
   * nobody held it (or Jira's assignee isn't on the plan) and the scheduler
   * picked who should take it.
   */
  assignedBy: "jira" | "planner";
  /** False for a Jira task with no plan task, planned on Jira's estimate. */
  inPlan: boolean;
  /** In review or ready to deploy, counted as work left (see options). */
  waiting: boolean;
  /** Where its estimate came from: the plan, or Jira when the plan has none. */
  estimateFrom: "plan" | "jira";
  /** Its whole estimate; more than `estimateDays` when Jira says less is left. */
  plannedDays: number;
}

export interface RemainingWorkOptions {
  /**
   * Also plan tasks in review or ready to deploy as work still to do, at
   * their whole estimate, with their Jira assignee — as the tracker's status
   * counts them, since nothing earns until it is Done. Default false: only
   * To Do and In Progress are planned, as if the rest were closed today.
   */
  countWaiting?: boolean;
}

/** An open task with no estimate in the plan or Jira: not laid out. */
export interface UnestimatedTask {
  /** Its first open Jira issue, when it has one. */
  key: string | null;
  name: string;
  specialization: string;
  inProgress: boolean;
  /** The person on the plan Jira has it on, when they could be matched. */
  memberId: ID | null;
  /** Who Jira has it on, matched or not. */
  jiraAssignee?: string;
}

/** One person's share of the work left. */
export interface ForecastPerson {
  memberId: ID;
  name: string;
  specialization: string;
  /** What they are on now: in progress in Jira, assigned to them. */
  current: ForecastItem[];
  /** In progress in Jira with them, but with no estimate to lay out. */
  unestimated: UnestimatedTask[];
  /** The first task planned for them that nobody has started yet. */
  next: ForecastItem | null;
  /** Remaining tasks planned for them, in progress ones included. */
  tasks: number;
  /** Plan days of those tasks. */
  days: number;
  /** The last day of their last task, or null with nothing planned. */
  finish: string | null;
}

export interface RemainingWork {
  /** The day the forecast is laid out from. */
  from: string;
  /** Every remaining task with its person and dates, earliest first. */
  items: ForecastItem[];
  /**
   * Everyone on the project, each specialization together: the one that
   * finishes last first, and within it, latest finish first, idle people last.
   */
  people: ForecastPerson[];
  /** When the last remaining task ends, or null with nothing planned. */
  finish: string | null;
  /** Tasks in review or ready to deploy; planned only with `countWaiting`. */
  waitingToClose: {
    tasks: number;
    days: number;
    /** The same, per specialization (as the tasks name it). */
    bySpecialization: { specialization: string; tasks: number; days: number }[];
  };
  /** Whether those were planned as work left. */
  countWaiting: boolean;
  /** Open tasks with no estimate yet, left out of the forecast. */
  unestimated: number;
  /** Those tasks, named, with who holds them in Jira when anyone does. */
  unestimatedTasks: UnestimatedTask[];
  /** Estimated tasks nobody on the plan can do. */
  unassigned: UnassignedTask[];
  /** Jira tasks with no plan task and no way to tell whose work they are. */
  noSpecialization: { key: string; summary: string }[];
}

interface Person {
  id: ID;
  name: string;
  specialization: string;
  speed: number;
  start: string;
  off: Set<string>;
  jiraAccountId?: string;
}

/** Everyone the project uses, with what booking them needs. */
function projectPeople(project: Project, teams: Team[]): Person[] {
  const out: Person[] = [];
  const inclusions = new Map(
    (project.teamInclusions ?? []).map((inc) => [inc.teamId, inc]),
  );
  const starts = project.memberStarts ?? {};
  const latest = (...dates: (string | undefined)[]) =>
    dates
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1)!;
  for (const team of includedTeams(project, teams)) {
    const inc = inclusions.get(team.id);
    const velocity = num(inc?.velocity) > 0 ? num(inc?.velocity) : 1;
    for (const m of team.members) {
      out.push({
        id: m.id,
        name: m.name,
        specialization: m.specialization,
        speed: (num(m.speed) > 0 ? num(m.speed) : 1) * velocity,
        start: latest(project.startDate, starts[m.id], inc?.availableFrom),
        off: new Set(team.offDays?.[m.id] ?? []),
        jiraAccountId: m.jiraAccountId,
      });
    }
  }
  for (const h of project.helpers ?? []) {
    out.push({
      id: h.id,
      name: h.name,
      specialization: h.specialization,
      speed: num(h.speed) > 0 ? num(h.speed) : 1,
      start: latest(project.startDate, h.availableFrom),
      off: new Set(h.offDays ?? []),
    });
  }
  return out;
}

/** What is known about one task from its Jira issues. */
interface TaskState {
  done: boolean;
  awaiting: boolean;
  inProgress: boolean;
  open: JiraIssue[];
  /** Jira's remaining estimate across its open issues, in plan days. */
  jiraLeftDays: number | null;
  /** Jira's estimate across its open issues, in plan days. */
  jiraDays: number;
  assignee?: JiraIssue["assignee"];
}

function taskState(issues: JiraIssue[], hoursPerDay: number): TaskState {
  const open = issues.filter((i) => i.statusCategory !== "done");
  const working = open.filter(
    (i) => i.statusCategory === "indeterminate" && !isAwaitingClose(i),
  );
  const leftSec = open.reduce(
    (sum, i) => sum + Math.max(0, num(i.remainingEstimateSec)),
    0,
  );
  const anyLeft = open.some((i) => i.remainingEstimateSec !== undefined);
  return {
    done: issues.length > 0 && open.length === 0,
    awaiting: open.length > 0 && open.every(isAwaitingClose),
    inProgress: working.length > 0,
    open,
    jiraLeftDays: anyLeft ? leftSec / (hoursPerDay * 3600) : null,
    jiraDays: open.reduce(
      (sum, i) => sum + jiraIssueEstimate(i, hoursPerDay).days,
      0,
    ),
    assignee: (working[0] ?? open.find((i) => i.assignee))?.assignee,
  };
}

/**
 * The one person whose short name fits a Jira display name: same first name,
 * and their last name (often just an initial, "Michał K") starts the Jira
 * one ("Michał Kowalski"). A first name alone matches only when nobody else
 * shares it. Undefined unless exactly one person fits.
 */
function shortNameMatch(
  people: Person[],
  displayName: string,
): Person | undefined {
  const tokens = (s: string) =>
    normPerson(s).replace(/[.,]/g, " ").split(" ").filter(Boolean);
  const jira = tokens(displayName);
  if (jira.length === 0) return undefined;
  const sameFirst = people.filter((p) => tokens(p.name)[0] === jira[0]);
  const fits = sameFirst.filter((p) => {
    const mine = tokens(p.name);
    // A first name alone says nothing once someone else shares it.
    if (mine.length === 1) return sameFirst.length === 1;
    const last = mine[mine.length - 1];
    return jira.length > 1 && jira[jira.length - 1].startsWith(last);
  });
  return fits.length === 1 ? fits[0] : undefined;
}

/** "[Client][Polishing] Wallet" -> ["Client", "Polishing"]. */
function bracketTags(summary: string): string[] {
  return [...summary.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, n] of counts) {
    if (best === undefined || n > (counts.get(best) ?? 0)) best = v;
  }
  return best;
}

/**
 * Plan the work left from `today`. Null without Jira data to say what is done.
 */
export function remainingWork(
  tracker: Tracker,
  project: Project,
  teams: Team[],
  today: string,
  options: RemainingWorkOptions = {},
): RemainingWork | null {
  const countWaiting = options.countWaiting ?? false;
  const scoped = teamScope(tracker, project, teams);
  if (scoped) {
    tracker = scoped.tracker;
    project = scoped.project;
  }
  const snapshot = tracker.snapshot;
  if (!snapshot) return null;
  const hoursPerDay =
    num(tracker.hoursPerDay) > 0
      ? num(tracker.hoursPerDay)
      : DEFAULT_HOURS_PER_DAY;

  const tracked = trackedMapping(tracker);
  const withScope = withAddedScope(
    project,
    snapshot,
    tracked.taskMap,
    tracked.addedScope,
    tracker.hoursPerDay,
  );
  project = withScope.project;
  const map = autoTaskMap(project, snapshot, withScope.taskMap);
  const skip = untrackedIssueKeys(snapshot, tracker.untrackedEpics);
  const issuesOf = new Map<ID, JiraIssue[]>();
  for (const issue of jiraTasks(snapshot)) {
    const id = map[issue.key];
    if (typeof id !== "string") continue;
    const list = issuesOf.get(id);
    if (list) list.push(issue);
    else issuesOf.set(id, [issue]);
  }

  const people = projectPeople(project, teams);
  const byAccount = new Map<string, Person>();
  const byName = new Map<string, Person>();
  for (const p of people) {
    if (p.jiraAccountId && !byAccount.has(p.jiraAccountId)) {
      byAccount.set(p.jiraAccountId, p);
    }
    const key = normPerson(p.name);
    if (key && !byName.has(key)) byName.set(key, p);
  }
  const personFor = (assignee: JiraIssue["assignee"]): Person | undefined =>
    assignee
      ? (byAccount.get(assignee.accountId) ??
        byName.get(normPerson(assignee.displayName)) ??
        shortNameMatch(people, assignee.displayName))
      : undefined;

  const waitingToClose = { tasks: 0, days: 0 };
  const waitingBySpec = new Map<
    string,
    { specialization: string; tasks: number; days: number }
  >();
  const unestimatedTasks: UnestimatedTask[] = [];
  const states = new Map<ID, TaskState>();
  const estimates = new Map<ID, { days: number; from: "plan" | "jira" }>();
  const inPlan = new Set<ID>();
  // Tasks someone already holds in Jira, for the scheduler to respect.
  const assignees: { [taskId: string]: ID } = {};
  // Each person's next free day, moved on by work they already have.
  const freeFrom = new Map<ID, string>();
  const pinned: ForecastItem[] = [];

  /**
   * Decide what happens to one open task: left out, booked to whoever has it
   * in progress, or returned for the scheduler with what is left of it.
   */
  const place = (
    task: TaskItem,
    epic: { id: ID; name: string },
    state: TaskState,
    estimate: number,
    from: "plan" | "jira",
  ): TaskItem | null => {
    if (state.awaiting) {
      waitingToClose.tasks++;
      waitingToClose.days += Math.max(0, estimate);
      const spec = waitingBySpec.get(task.specialization) ?? {
        specialization: task.specialization,
        tasks: 0,
        days: 0,
      };
      spec.tasks++;
      spec.days += Math.max(0, estimate);
      waitingBySpec.set(task.specialization, spec);
      if (!countWaiting) return null;
    }
    const person = personFor(state.assignee);
    if (estimate <= EPS) {
      unestimatedTasks.push({
        key: state.open[0]?.key ?? null,
        name: task.name,
        specialization: task.specialization,
        inProgress: state.inProgress,
        memberId: person?.id ?? null,
        jiraAssignee: state.assignee?.displayName,
      });
      return null;
    }
    states.set(task.id, state);
    estimates.set(task.id, { days: estimate, from });
    // Started work: what Jira says is left of it, never more than planned.
    // Nothing left in Jira on work still in progress means it has overrun
    // its estimate, not that it is done: it keeps its whole estimate, as the
    // status counts it, rather than dropping out of sight.
    const remaining =
      state.inProgress &&
      state.jiraLeftDays !== null &&
      state.jiraLeftDays > EPS
        ? Math.min(estimate, state.jiraLeftDays)
        : estimate;
    if (person && state.inProgress) {
      const fromDay = [today, person.start, freeFrom.get(person.id) ?? today]
        .sort()
        .at(-1)!;
      const workDays = Math.max(1, Math.ceil(remaining / person.speed - EPS));
      const span = simulateSpan(fromISO(fromDay), workDays, person.off);
      freeFrom.set(person.id, toISO(addDays(span.end, 1)));
      pinned.push({
        taskId: task.id,
        taskName: task.name,
        epicId: epic.id,
        epicName: epic.name,
        specialization: task.specialization,
        estimateDays: round2(remaining),
        workDays,
        memberId: person.id,
        memberName: person.name,
        start: toISO(span.start),
        end: toISO(span.end),
        jiraKeys: state.open.map((i) => i.key),
        inProgress: true,
        jiraAssignee: state.assignee?.displayName,
        assignedBy: "jira",
        inPlan: inPlan.has(task.id),
        waiting: false,
        estimateFrom: from,
        plannedDays: round2(estimate),
      });
      return null;
    }
    if (person) assignees[task.id] = person.id;
    return { ...task, estimateDays: remaining };
  };

  const epics: Epic[] = [];
  for (const epic of project.epics) {
    const tasks: TaskItem[] = [];
    for (const t of epic.tasks) {
      if (t.excluded) continue;
      inPlan.add(t.id);
      const state = taskState(issuesOf.get(t.id) ?? [], hoursPerDay);
      if (state.done) continue;
      // The plan's estimate, or Jira's when the plan has none yet.
      const fromPlan = num(t.estimateDays) > EPS;
      const estimate = fromPlan ? num(t.estimateDays) : state.jiraDays;
      const placed = place(
        t,
        epic,
        state,
        estimate,
        fromPlan ? "plan" : "jira",
      );
      if (placed) tasks.push(placed);
    }
    epics.push({ ...epic, tasks });
  }

  // Jira tasks with no plan task: planned on Jira's estimate, in the plan
  // epic their Jira epic maps to, or an epic of their own.
  const known = new Map<string, string>();
  for (const p of people) {
    if (p.specialization)
      known.set(normSpec(p.specialization), p.specialization);
  }
  for (const e of project.epics) {
    for (const t of e.tasks) {
      if (t.specialization) {
        known.set(normSpec(t.specialization), t.specialization);
      }
    }
  }
  const specOfTask = new Map<ID, string>();
  for (const e of project.epics) {
    for (const t of e.tasks) specOfTask.set(t.id, t.specialization);
  }
  const noSpecialization: { key: string; summary: string }[] = [];
  const extraEpics: Epic[] = [];
  const seen = new Set<string>();
  for (const jiraEpic of snapshot.epics ?? []) {
    const children = jiraEpic.children ?? [];
    const siblingSpecs = children
      .map((c) => map[c.key])
      .filter((id): id is string => typeof id === "string")
      .map((id) => specOfTask.get(id) ?? "")
      .filter(Boolean);
    const planEpicId = tracker.epicMap?.[jiraEpic.key];
    const home =
      (typeof planEpicId === "string" &&
        epics.find((e) => e.id === planEpicId)) ||
      null;
    const own: Epic = {
      id: JIRA_EPIC_PREFIX + jiraEpic.key,
      name: jiraEpic.summary || jiraEpic.key,
      tasks: [],
    };
    const target = home ?? own;
    for (const issue of children) {
      if (!issue.key || seen.has(issue.key)) continue;
      seen.add(issue.key);
      if (skip.has(issue.key) || typeof map[issue.key] === "string") continue;
      if (issue.statusCategory === "done") continue;
      const state = taskState([issue], hoursPerDay);
      // What the issue says about itself first ("[Backend] Wallet API"),
      // then who has it, then what the rest of its epic is.
      const specialization =
        (issue.labels ?? []).map((l) => known.get(normSpec(l))).find(Boolean) ??
        bracketTags(issue.summary ?? "")
          .map((t) => known.get(normSpec(t)))
          .find(Boolean) ??
        personFor(issue.assignee)?.specialization ??
        mostCommon(siblingSpecs);
      if (!specialization && !state.awaiting && state.jiraDays > EPS) {
        noSpecialization.push({
          key: issue.key,
          summary: issue.summary || issue.key,
        });
        continue;
      }
      const task: TaskItem = {
        id: JIRA_TASK_PREFIX + issue.key,
        name: issue.summary || issue.key,
        estimateDays: state.jiraDays,
        specialization: specialization ?? "",
        excluded: false,
      };
      const placed = place(task, target, state, state.jiraDays, "jira");
      if (placed) target.tasks.push(placed);
    }
    if (!home && own.tasks.length > 0) extraEpics.push(own);
  }

  // Prerequisites that are done, waiting to be closed or in someone's hands
  // already are no longer in the way.
  const allEpics = [...epics, ...extraEpics].filter((e) => e.tasks.length > 0);
  const planned = new Set(allEpics.flatMap((e) => e.tasks.map((t) => t.id)));
  const plannedEpics = new Set(allEpics.map((e) => e.id));
  const extraIds = extraEpics.map((e) => e.id);
  const forward: Project = {
    ...project,
    startDate: today,
    buffer: 0,
    plan: null,
    memberStarts: {
      ...(project.memberStarts ?? {}),
      ...Object.fromEntries(
        [...freeFrom].map(([id, day]) => {
          const own = project.memberStarts?.[id];
          return [id, own && own > day ? own : day];
        }),
      ),
    },
    // A team scoped to some epics may also take work Jira added outside them.
    teamInclusions: project.teamInclusions?.map((inc) =>
      inc.epicIds && inc.epicIds.length > 0 && !inc.exclusive
        ? { ...inc, epicIds: [...inc.epicIds, ...extraIds] }
        : inc,
    ),
    epics: allEpics.map((e) => ({
      ...e,
      dependsOn: e.dependsOn?.filter((id) => plannedEpics.has(id)),
      tasks: e.tasks.map((t) =>
        t.dependsOn
          ? { ...t, dependsOn: t.dependsOn.filter((id) => planned.has(id)) }
          : t,
      ),
    })),
  };
  const plan = runPlan(forward, teams, FORECAST_GENERATED_AT, {
    ...planOptionsFor(project),
    assignees,
  });

  const items: ForecastItem[] = [
    ...pinned,
    ...plan.assignments.map((a): ForecastItem => {
      const state = states.get(a.taskId);
      return {
        ...a,
        jiraKeys: state?.open.map((i) => i.key) ?? [],
        inProgress: state?.inProgress ?? false,
        jiraAssignee: state?.assignee?.displayName,
        assignedBy: assignees[a.taskId] === a.memberId ? "jira" : "planner",
        inPlan: inPlan.has(a.taskId),
        waiting: state?.awaiting ?? false,
        estimateFrom: estimates.get(a.taskId)?.from ?? "plan",
        plannedDays: round2(estimates.get(a.taskId)?.days ?? a.estimateDays),
      };
    }),
  ].sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      a.memberName.localeCompare(b.memberName),
  );

  // Everyone on the teams, plus helpers who were given work.
  const roster = new Map<ID, { name: string; specialization: string }>();
  const helperIds = new Set((project.helpers ?? []).map((h) => h.id));
  for (const p of people) {
    if (helperIds.has(p.id)) continue;
    roster.set(p.id, { name: p.name, specialization: p.specialization });
  }
  for (const a of items) {
    if (!roster.has(a.memberId)) {
      const p = people.find((x) => x.id === a.memberId);
      roster.set(a.memberId, {
        name: a.memberName,
        specialization: p?.specialization ?? a.specialization,
      });
    }
  }
  const forecastPeople = [...roster].map(([id, who]): ForecastPerson => {
    const mine = items.filter((a) => a.memberId === id);
    const current = mine.filter((a) => pinned.includes(a));
    return {
      memberId: id,
      name: who.name,
      specialization: who.specialization,
      current,
      unestimated: unestimatedTasks.filter(
        (u) => u.inProgress && u.memberId === id,
      ),
      next: mine.find((a) => !pinned.includes(a)) ?? null,
      tasks: mine.length,
      days: round2(mine.reduce((sum, a) => sum + a.estimateDays, 0)),
      finish: mine.reduce<string | null>(
        (max, a) => (max === null || a.end > max ? a.end : max),
        null,
      ),
    };
  });
  // Each specialization together, the one that finishes last on top; within
  // one, whoever finishes last first and anyone idle at the bottom.
  const groupFinish = new Map<string, string>();
  for (const p of forecastPeople) {
    const key = normSpec(p.specialization);
    const finish = p.finish ?? "";
    if (finish > (groupFinish.get(key) ?? "")) groupFinish.set(key, finish);
  }
  forecastPeople.sort((a, b) => {
    const ga = normSpec(a.specialization);
    const gb = normSpec(b.specialization);
    return (
      (groupFinish.get(gb) ?? "").localeCompare(groupFinish.get(ga) ?? "") ||
      ga.localeCompare(gb) ||
      (b.finish ?? "").localeCompare(a.finish ?? "") ||
      a.name.localeCompare(b.name)
    );
  });

  return {
    from: today,
    items,
    people: forecastPeople,
    finish: items.reduce<string | null>(
      (max, a) => (max === null || a.end > max ? a.end : max),
      null,
    ),
    waitingToClose: {
      tasks: waitingToClose.tasks,
      days: round2(waitingToClose.days),
      bySpecialization: [...waitingBySpec.values()].map((w) => ({
        ...w,
        days: round2(w.days),
      })),
    },
    countWaiting,
    unestimated: unestimatedTasks.length,
    unestimatedTasks,
    unassigned: plan.unassigned,
    noSpecialization,
  };
}
