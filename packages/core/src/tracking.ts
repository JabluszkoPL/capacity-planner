/**
 * Pure comparison between a Jira snapshot and a Planner plan — no React, no
 * DOM, and nothing here ever reads the clock: `today` always arrives as a
 * parameter, so the same inputs always produce the same output and every number
 * is reproducible from a stored tracker.
 *
 * **Why the baseline is an unbuffered re-run.** A project's stored plan has the
 * project buffer baked into every `estimateDays` (see `runPlan`), so its
 * cumulative curve is in *padded* days: a 5-day task reads as 6. Comparing Jira
 * progress against that curve would silently spend the buffer before any work
 * slipped. So the baseline is a second run of the same project with
 * `buffer: 0`: its assignments carry the raw estimates, its curve is in plan
 * days, and the difference between the two finish dates is exactly the schedule
 * buffer — the slack the plan is allowed to eat before the promised date moves.
 * Progress is measured against the unbuffered plan; the buffer is then reported
 * as a separate, visible amount of runway.
 *
 * **Why earned schedule instead of comparing dates.** Jira has no opinion about
 * when the plan expected a piece of work to be done, and epic due dates drift
 * the moment anything is re-sequenced, so "is epic X late?" is not answerable by
 * subtracting dates. Earned schedule sidesteps this: convert real progress into
 * plan days finished (`earned`), then ask *when the plan itself had finished
 * that much* (`ES`). The distance from that point to today, in working days, is
 * the variance — one number, in days, that reads the same whatever order the
 * work actually happened in and however Jira's own dates have moved.
 *
 * **Everything is measured in team working days.** A weekday counts as the
 * share of the project's people who are working on it: 1 on a normal day, 0
 * when the whole team is off, ½ when half of it is (see {@link teamCalendar}).
 * Counting plain weekdays instead is wrong across a holiday: a team three weeks
 * ahead of a plan that pauses for three weeks of Christmas is really only ahead
 * by what it finished, and a projected finish shifted by plain weekdays lands
 * in the middle of the break.
 */

import type {
  EpicTracking,
  ID,
  JiraEpic,
  JiraIssue,
  JiraSnapshot,
  Plan,
  Project,
  Team,
  Tracker,
  TrackerDeadlines,
  TrackerSample,
} from "./types";
import { addDays, fromISO, isWeekend, toISO } from "./dates";
import { includedMembers, includedTeams } from "./teams";
import { runPlan, type PlanOptions } from "./scheduling";

/**
 * Stamped on every plan run from here. Baselines are compared, never stored,
 * and a real timestamp would make otherwise identical output differ run to run.
 */
const BASELINE_GENERATED_AT = "2000-01-01T00:00:00.000Z";

/** Hours that make one Planner day when a tracker doesn't say. */
const DEFAULT_HOURS_PER_DAY = 8;

/** Slack for float noise when comparing accumulated day sums. */
const EPS = 1e-9;

/** A date far past any plan, used to read the end of a cumulative curve. */
const FAR_FUTURE = "9999-12-31";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** Trim + lowercase + collapse whitespace, for name matching. */
function normName(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Punctuation-insensitive task name used by the conservative fuzzy matcher. */
function normTaskName(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const TASK_STOP_WORDS = new Set(["a", "an", "and", "for", "of", "the", "to"]);

function taskTokens(name: string): Set<string> {
  return new Set(
    name
      .split(" ")
      .filter((token) => token.length > 1 && !TASK_STOP_WORDS.has(token)),
  );
}

/** Sørensen-Dice overlap: tolerant of a few added/removed words. */
function taskNameScore(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) {
    return 0.9;
  }
  const aa = taskTokens(a);
  const bb = taskTokens(b);
  if (aa.size === 0 || bb.size === 0) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common++;
  return (2 * common) / (aa.size + bb.size);
}

/* ------------------------------ working days ------------------------------ */

/**
 * How much of a working day a date is worth, in `[0, 1]`. Only ever asked
 * about weekdays — weekends are 0 before a calendar is consulted.
 */
export type TeamCalendar = (dateISO: string) => number;

/** Every weekday is a full working day. */
const WEEKDAYS: TeamCalendar = () => 1;

/** Guards the day-by-day walks against a calendar with no working days left. */
const MAX_WALK_DAYS = 20_000;

function dayWeight(d: Date, calendar: TeamCalendar): number {
  if (isWeekend(d)) return 0;
  const w = calendar(toISO(d));
  return Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0;
}

/**
 * Signed count of working days in the half-open interval `(from, to]`.
 *
 * Positive when `to` is after `from`, negative when it is before, 0 when they
 * are the same day — so it is antisymmetric:
 * `workdaysBetween(a, b) === -workdaysBetween(b, a)`. Fri → Mon is 1.
 *
 * With a `calendar`, each weekday counts for its weight, so days the team is
 * off count for nothing (see {@link teamCalendar}).
 */
export function workdaysBetween(
  from: string,
  to: string,
  calendar: TeamCalendar = WEEKDAYS,
): number {
  if (from === to) return 0;
  const forward = from < to;
  const start = fromISO(forward ? from : to);
  const endTime = fromISO(forward ? to : from).getTime();
  let n = 0;
  let d = addDays(start, 1);
  while (d.getTime() <= endTime) {
    n += dayWeight(d, calendar);
    d = addDays(d, 1);
  }
  n = round2(n);
  return forward ? n : -n;
}

/**
 * The date `n` working days after `dateISO` (negative `n` goes back). `n = 0`
 * returns the date unchanged, weekend or not; otherwise the result is always a
 * day that carries working time, since only those are counted on the way.
 *
 * With a `calendar`, days the team is off are walked over without counting, so
 * a finish shifted across a holiday lands after it rather than inside it. A
 * fractional `n` lands on the day that fraction is reached (it rounds up).
 */
export function addWorkdays(
  dateISO: string,
  n: number,
  calendar: TeamCalendar = WEEKDAYS,
): string {
  const step = n < 0 ? -1 : 1;
  // A fraction means work that ends partway through a day, so the date is the
  // day it finishes on: 54.2 working days in is day 55, on any calendar.
  const target = Math.abs(n);
  let d = fromISO(dateISO);
  let counted = 0;
  for (let i = 0; counted + EPS < target && i < MAX_WALK_DAYS; i++) {
    d = addDays(d, step);
    counted += dayWeight(d, calendar);
  }
  return toISO(d);
}

/**
 * The project's team calendar: on each weekday, the share of its people who
 * are working.
 *
 * Only people *engaged* on a day are counted, so a helper whose window has
 * ended, or a member who has not started yet, does not make every other day
 * look like a half day. Of those engaged, anyone with the date among their days
 * off is not working. A day nobody is engaged on counts as a full day: there is
 * no one to be on holiday, and the plan cannot have scheduled work there
 * either, so counting it keeps dates before the project start comparable.
 *
 * Headcount, not speed: the question is "was the team at work that day", and a
 * slower helper on holiday is as absent as anyone else.
 */
export function teamCalendar(
  project: Project,
  teams: Team[],
  /** Only count people with this specialization (or passing this test);
   *  absent = everyone. */
  specialization?: string | ((spec: string) => boolean),
): TeamCalendar {
  const keep = (spec: string) =>
    specialization === undefined
      ? true
      : typeof specialization === "string"
        ? spec === specialization
        : specialization(spec);
  interface Person {
    from?: string;
    to?: string;
    off: Set<string>;
  }
  const people: Person[] = [];
  const inclusions = new Map(
    (project.teamInclusions ?? []).map((inc) => [inc.teamId, inc]),
  );
  const starts = project.memberStarts ?? {};

  for (const team of includedTeams(project, teams)) {
    const inc = inclusions.get(team.id);
    for (const member of team.members) {
      if (!keep(member.specialization)) continue;
      const start = starts[member.id];
      const windowFrom = inc?.availableFrom;
      people.push({
        from:
          start && windowFrom
            ? start > windowFrom
              ? start
              : windowFrom
            : (start ?? windowFrom),
        to: inc?.availableTo,
        off: new Set(team.offDays?.[member.id] ?? []),
      });
    }
  }
  for (const helper of project.helpers ?? []) {
    if (!keep(helper.specialization)) continue;
    people.push({
      from: helper.availableFrom || undefined,
      to: helper.availableTo || undefined,
      off: new Set(helper.offDays ?? []),
    });
  }

  if (!people.some((p) => p.off.size > 0)) return WEEKDAYS;

  const cache = new Map<string, number>();
  return (dateISO) => {
    const hit = cache.get(dateISO);
    if (hit !== undefined) return hit;
    let engaged = 0;
    let working = 0;
    for (const p of people) {
      if (p.from && dateISO < p.from) continue;
      if (p.to && dateISO > p.to) continue;
      engaged++;
      if (!p.off.has(dateISO)) working++;
    }
    const weight = engaged === 0 ? 1 : working / engaged;
    cache.set(dateISO, weight);
    return weight;
  };
}

/* ------------------------------- the plans -------------------------------- */

/** The two plans §7.1 compares, plus what the comparison needs from them. */
export interface BaselinePlans {
  /** The plan as promised: the stored plan, or a fresh run with the buffer. */
  buffered: Plan;
  /** The same project planned with `buffer: 0` — the measuring stick. */
  unbuffered: Plan;
  /**
   * The stored plan is missing, no longer covers the project's tasks, or
   * finishes on a different day than re-running it now does.
   */
  stale: boolean;
  /** The stored plan's finish — what the project page shows — if any. */
  storedEnd: string | null;
  /** Last end date in `unbuffered` ("U"), or null when nothing is scheduled. */
  unbufferedEnd: string | null;
  /** Last end date in `buffered` ("B"). */
  bufferedEnd: string | null;
  /** Team working days in `(U, B]` — the schedule buffer, in calendar terms. */
  bufferDays: number;
  /** Which days the team works; see {@link teamCalendar}. */
  calendar: TeamCalendar;
  /** Σ non-excluded `estimateDays` × `buffer/100` — the buffer as effort. */
  effortBufferDays: number;
}

/** The scheduler options a project asks for (its plan mode). */
export function planOptionsFor(project: Project): PlanOptions {
  return {
    mode: project.planMode ?? "balanced",
    lookahead: project.planLookahead ?? 5,
  };
}

/** Last (maximum) assignment end date in a plan; null when it has none. */
function lastEnd(plan: Plan): string | null {
  let out: string | null = null;
  for (const a of plan.assignments) {
    if (out === null || a.end > out) out = a.end;
  }
  return out;
}

/** Ids of every task the project currently expects a plan to cover. */
function plannableTaskIds(project: Project): Set<ID> {
  const out = new Set<ID>();
  for (const epic of project.epics) {
    for (const t of epic.tasks) if (!t.excluded) out.add(t.id);
  }
  return out;
}

/**
 * Whether the stored plan can still be trusted as the promised plan.
 *
 * "The project changed after `plan.generatedAt`" isn't derivable — nothing
 * timestamps an edit — so this is the cheap stand-in the spec asks for: the set
 * of tasks the plan accounted for versus the set the project has now. A task
 * the plan reported as *unassigned* still counts as accounted for; otherwise
 * every project with an unstaffable task would read as permanently stale.
 */
function isPlanStale(project: Project): boolean {
  const plan = project.plan;
  if (!plan) return true;
  const current = plannableTaskIds(project);
  const covered = new Set<ID>();
  for (const a of plan.assignments) covered.add(a.taskId);
  for (const u of plan.unassigned) covered.add(u.id);
  if (covered.size !== current.size) return true;
  for (const id of current) if (!covered.has(id)) return true;
  return false;
}

/**
 * Build the two plans of §7.1 and the buffer between them.
 *
 * **Both are run fresh, from the same inputs.** The stored plan is what the
 * project page showed when Run Plan was last pressed, and nothing re-runs it
 * when days off, estimates, specializations or people change afterwards.
 * Pairing that stale plan with a fresh no-buffer run compared two different
 * projects: a no-buffer finish could land *after* the "finish with buffer".
 * Run from the same inputs the scheduler never does that, so the stored plan
 * is only used to tell the user the project page is out of date.
 */
export function baselinePlans(project: Project, teams: Team[]): BaselinePlans {
  const opts = planOptionsFor(project);
  const buffered = runPlan(project, teams, BASELINE_GENERATED_AT, opts);
  const unbuffered = runPlan(
    { ...project, buffer: 0 },
    teams,
    BASELINE_GENERATED_AT,
    opts,
  );

  const calendar = teamCalendar(project, teams);
  const unbufferedEnd = lastEnd(unbuffered);
  const bufferedEnd = lastEnd(buffered);
  const storedEnd = project.plan ? lastEnd(project.plan) : null;
  const bufferDays =
    unbufferedEnd && bufferedEnd
      ? Math.max(0, workdaysBetween(unbufferedEnd, bufferedEnd, calendar))
      : 0;

  const pct = Math.max(0, num(project.buffer));
  let estimateTotal = 0;
  for (const epic of project.epics) {
    for (const t of epic.tasks) {
      if (!t.excluded) estimateTotal += num(t.estimateDays);
    }
  }

  return {
    buffered,
    unbuffered,
    stale:
      isPlanStale(project) ||
      (project.plan !== null && storedEnd !== bufferedEnd),
    storedEnd,
    unbufferedEnd,
    bufferedEnd,
    bufferDays,
    calendar,
    effortBufferDays: round2(estimateTotal * (pct / 100)),
  };
}

/* --------------------------- the planned curve ---------------------------- */

/**
 * Plan days the unbuffered plan expected to be finished by `dateISO` — §7.2's
 * `plannedDone(d)`. Pass a date past the end for the plan total.
 */
export function plannedDoneBy(unbuffered: Plan, dateISO: string): number {
  let total = 0;
  for (const a of unbuffered.assignments) {
    if (a.end <= dateISO) total += num(a.estimateDays);
  }
  return total;
}

/**
 * Earliest date on the unbuffered cumulative curve where at least `earned` plan
 * days were expected to be finished — §7.4's "earned schedule".
 *
 * With `earned <= 0` nothing has started, so the answer is the working day
 * *before* the project starts (variance is then the whole elapsed span). When
 * `earned` exceeds the plan total the curve never reaches it, so the plan's own
 * finish date is the answer — you cannot be more finished than finished.
 */
export function earnedScheduleDate(
  unbuffered: Plan,
  earned: number,
  projectStart: string,
): string {
  const beforeStart = addWorkdays(projectStart, -1);
  const byEnd = new Map<string, number>();
  for (const a of unbuffered.assignments) {
    byEnd.set(a.end, (byEnd.get(a.end) ?? 0) + num(a.estimateDays));
  }
  const ends = [...byEnd.keys()].sort();
  if (ends.length === 0) return beforeStart;
  if (!(earned > 0)) return beforeStart;

  let cumulative = 0;
  for (const end of ends) {
    cumulative += byEnd.get(end) ?? 0;
    if (cumulative + EPS >= earned) return end;
  }
  return ends[ends.length - 1];
}

/* ------------------------------ Jira progress ----------------------------- */

/**
 * How finished one Jira epic is, in `[0, 1]` (§7.3).
 *
 * Time tracking is the primary signal; the done/all child count is the fallback
 * that keeps an epic nobody logs time on from reading as 0% forever. An epic
 * Jira itself calls done is 1 whatever its time fields say.
 */
export function epicCompletion(epic: JiraEpic): number {
  if (epic.statusCategory === "done") return 1;
  const spent = Math.max(0, num(epic.totals?.spentSec));
  const remaining = Math.max(0, num(epic.totals?.remainingSec));
  let raw = 0;
  if (spent + remaining > 0) {
    raw = spent / (spent + remaining);
  } else {
    const all = num(epic.totals?.all);
    if (all > 0) raw = num(epic.totals?.done) / all;
  }
  return Math.min(1, Math.max(0, raw));
}

/** Raw (unbuffered) planned days per planner epic: Σ non-excluded estimates. */
export function plannedDaysByEpic(project: Project): Map<ID, number> {
  const out = new Map<ID, number>();
  for (const epic of project.epics) {
    let days = 0;
    for (const t of epic.tasks) {
      if (!t.excluded) days += num(t.estimateDays);
    }
    out.set(epic.id, days);
  }
  return out;
}

/** One Jira epic's share of the earned total. */
export interface EarnedEpicRow {
  /** Planner epic this Jira epic counts towards; null = not counted. */
  plannerEpicId: ID | null;
  /**
   * Plan days this row is measured against. For the usual one-to-one mapping
   * that is the planner epic's whole raw estimate; when several Jira epics map
   * to one planner epic it is this row's weighted *share* of it, so the rows of
   * a group sum to the planner epic's days instead of multiplying it.
   */
  plannedDays: number;
  /** {@link epicCompletion} for this Jira epic, `[0, 1]`. */
  completion: number;
  /** `plannedDays × completion` — what this row contributes to the total. */
  earned: number;
}

export interface EarnedDays {
  /** Plan days Jira says are finished, across every mapped epic. */
  total: number;
  /** Every Jira epic in the snapshot, in snapshot order. */
  perJiraEpic: Map<string, EarnedEpicRow>;
}

/**
 * Convert Jira progress into plan days (§7.4).
 *
 * Only epics mapped to a planner epic count. A key mapped to `null` is scope
 * deliberately left out of the plan, and a key absent from the map has not been
 * decided yet; both contribute 0 but still appear in `perJiraEpic` (with
 * `plannerEpicId: null`) so the UI can list them.
 *
 * Several Jira epics may map to the *same* planner epic. That epic's days are
 * then split between them in proportion to their Jira original estimates — or
 * equally when every one of them is 0 — so the planner epic is counted once,
 * not once per Jira epic.
 */
export function earnedDays(
  project: Project,
  snapshot: JiraSnapshot,
  epicMap: Tracker["epicMap"],
): EarnedDays {
  const planned = plannedDaysByEpic(project);
  const map = epicMap ?? {};
  const epics = snapshot.epics ?? [];

  // Group the mapped Jira epics by the planner epic they count towards.
  const groups = new Map<ID, JiraEpic[]>();
  const mappedTo = new Map<string, ID>();
  for (const e of epics) {
    if (!Object.prototype.hasOwnProperty.call(map, e.key)) continue;
    const target = map[e.key];
    if (target === null || target === undefined) continue;
    mappedTo.set(e.key, target);
    const arr = groups.get(target);
    if (arr) arr.push(e);
    else groups.set(target, [e]);
  }

  // Split each planner epic's days across the Jira epics mapped onto it.
  const shares = new Map<string, number>();
  for (const [plannerEpicId, members] of groups) {
    const days = planned.get(plannerEpicId) ?? 0;
    const weights = members.map((e) => Math.max(0, num(e.totals?.originalSec)));
    let sum = weights.reduce((a, b) => a + b, 0);
    const equal = sum <= 0;
    if (equal) sum = members.length;
    members.forEach((e, i) => {
      const w = equal ? 1 : weights[i];
      shares.set(e.key, sum > 0 ? days * (w / sum) : 0);
    });
  }

  const perJiraEpic = new Map<string, EarnedEpicRow>();
  let total = 0;
  for (const e of epics) {
    const plannerEpicId = mappedTo.get(e.key) ?? null;
    const completion = epicCompletion(e);
    const plannedDays = plannerEpicId === null ? 0 : (shares.get(e.key) ?? 0);
    const earned = plannedDays * completion;
    total += earned;
    perJiraEpic.set(e.key, {
      plannerEpicId,
      plannedDays,
      completion,
      earned,
    });
  }

  return { total, perJiraEpic };
}

/**
 * Every unique child issue in a snapshot, preserving Jira's epic/issue order.
 *
 * A Jira query can return the same issue through both `parent` and `Epic Link`,
 * or under overlapping pages while the board is changing. The mapper already
 * removes most duplicates; this final guard keeps task matching one-to-one.
 */
export function jiraTasks(snapshot: JiraSnapshot): JiraIssue[] {
  const out: JiraIssue[] = [];
  const seen = new Set<string>();
  for (const epic of snapshot.epics ?? []) {
    for (const issue of epic.children ?? []) {
      if (!issue.key || seen.has(issue.key)) continue;
      seen.add(issue.key);
      out.push(issue);
    }
  }
  return out;
}

/** Raw (unbuffered) planned days per Planner task. */
export function plannedDaysByTask(project: Project): Map<ID, number> {
  const out = new Map<ID, number>();
  for (const epic of project.epics) {
    for (const task of epic.tasks) {
      if (!task.excluded) out.set(task.id, num(task.estimateDays));
    }
  }
  return out;
}

/* ------------------------------ added scope ------------------------------- */

/** The epic added scope is planned under. Never a real epic's id. */
export const ADDED_SCOPE_EPIC_ID = "__added-scope__";

/** The plan task standing in for one Jira issue of added scope. */
export function addedScopeTaskId(issueKey: string): ID {
  return `__added__:${issueKey}`;
}

/**
 * A Jira issue's size in Planner days: its original estimate, else logged +
 * remaining time, else none. The import, the estimate review and added scope
 * all read Jira this way, so one issue is never three different sizes.
 */
export function jiraIssueEstimate(
  issue: JiraIssue,
  hoursPerDay?: number,
): { days: number; source: "original" | "logged" | "none" } {
  const hpd =
    typeof hoursPerDay === "number" &&
    Number.isFinite(hoursPerDay) &&
    hoursPerDay > 0
      ? hoursPerDay
      : DEFAULT_HOURS_PER_DAY;
  const secPerDay = hpd * 3600;
  const original = Math.max(0, num(issue.originalEstimateSec));
  if (original > 0) {
    return { days: round2(original / secPerDay), source: "original" };
  }
  const logged =
    Math.max(0, num(issue.timeSpentSec)) +
    Math.max(0, num(issue.remainingEstimateSec));
  if (logged > 0) {
    return { days: round2(logged / secPerDay), source: "logged" };
  }
  return { days: 0, source: "none" };
}

/**
 * Every specialization that could do a tracker's added scope: the plan's own
 * first, then those of the project's people and helpers who have no task yet.
 * Each once, whatever its case, spelled as first seen.
 */
export function trackerSpecializations(
  project: Project,
  teams: Team[],
): string[] {
  const out: string[] = [];
  const add = (spec: string | undefined) => {
    const s = (spec ?? "").trim();
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) {
      out.push(s);
    }
  };
  for (const epic of project.epics) {
    for (const task of epic.tasks) add(task.specialization);
  }
  for (const m of includedMembers(project, teams)) add(m.specialization);
  for (const h of project.helpers ?? []) add(h.specialization);
  return out;
}

/** How a tracker follows one Jira epic. */
export function epicTracking(
  tracker: Pick<Tracker, "untrackedEpics" | "niceToHaveEpics">,
  epicKey: string,
): EpicTracking {
  if ((tracker.untrackedEpics ?? []).includes(epicKey)) return "untracked";
  if ((tracker.niceToHaveEpics ?? []).includes(epicKey)) return "niceToHave";
  return "tracked";
}

/**
 * The tracker as a reading of the must-do work sees it: nice-to-have epics
 * left out exactly like another team's. The same tracker back when it has
 * none, so a tracker without them reads exactly as it always has.
 */
export function mustDoTracker<T extends Tracker>(tracker: T): T {
  const nice = tracker.niceToHaveEpics ?? [];
  if (nice.length === 0) return tracker;
  return {
    ...tracker,
    untrackedEpics: [...new Set([...(tracker.untrackedEpics ?? []), ...nice])],
    niceToHaveEpics: undefined,
  };
}

/** Jira issue keys under the epics a tracker does not track. */
export function untrackedIssueKeys(
  snapshot: JiraSnapshot | undefined,
  untrackedEpics: Tracker["untrackedEpics"],
): Set<string> {
  const epics = new Set(untrackedEpics ?? []);
  const out = new Set<string>();
  if (epics.size === 0 || !snapshot) return out;
  for (const epic of snapshot.epics ?? []) {
    if (!epics.has(epic.key)) continue;
    for (const issue of epic.children ?? []) if (issue.key) out.add(issue.key);
  }
  return out;
}

/**
 * A tracker's mapping with its untracked epics applied: every issue under one
 * reads as not tracked (`null`) and none of them counts as added scope,
 * whatever it was set to. The tracker keeps those settings, so tracking the
 * epic again brings each one back.
 */
export function trackedMapping(
  tracker: Pick<
    Tracker,
    "snapshot" | "taskMap" | "addedScope" | "untrackedEpics"
  >,
): {
  taskMap: Tracker["taskMap"];
  addedScope: Tracker["addedScope"];
} {
  const skip = untrackedIssueKeys(tracker.snapshot, tracker.untrackedEpics);
  if (skip.size === 0) {
    return { taskMap: tracker.taskMap, addedScope: tracker.addedScope };
  }
  const taskMap: NonNullable<Tracker["taskMap"]> = {
    ...(tracker.taskMap ?? {}),
  };
  for (const key of skip) taskMap[key] = null;
  const addedScope = Object.fromEntries(
    Object.entries(tracker.addedScope ?? {}).filter(([key]) => !skip.has(key)),
  );
  return { taskMap, addedScope };
}

/**
 * The tracker's task map with every added-scope issue pointing at the plan
 * task that stands in for it (see {@link withAddedScope}).
 */
export function addedScopeTaskMap(
  taskMap: Tracker["taskMap"],
  addedScope: Tracker["addedScope"],
): NonNullable<Tracker["taskMap"]> {
  const out: NonNullable<Tracker["taskMap"]> = { ...(taskMap ?? {}) };
  for (const [key, spec] of Object.entries(addedScope ?? {})) {
    if (spec.trim() !== "") out[key] = addedScopeTaskId(key);
  }
  return out;
}

/**
 * The project as a tracker measures it: the baseline plus the Jira issues
 * marked as added scope, and the task map that counts them.
 *
 * Each issue becomes a task of the chosen specialization, sized by Jira's
 * estimate — skipped at 0 days when Jira has none, exactly like an imported
 * task — in one more epic at the end, so the scheduler reaches it after the
 * planned work and fits it where people are free. A team limited to certain
 * epics is let onto it too; one that *reserves* its epics exclusively is not,
 * since adding the epic to its list would reserve added scope to that team.
 *
 * With nothing marked (or nothing marked still in the snapshot) the project
 * and map come back as they were, so a tracker without added scope reads
 * exactly as it always has.
 */
export function withAddedScope(
  project: Project,
  snapshot: JiraSnapshot | undefined,
  taskMap: Tracker["taskMap"],
  addedScope: Tracker["addedScope"],
  hoursPerDay?: number,
): { project: Project; taskMap: Tracker["taskMap"] } {
  const scope = addedScope ?? {};
  const issues = snapshot
    ? jiraTasks(snapshot).filter((i) => (scope[i.key] ?? "").trim() !== "")
    : [];
  if (issues.length === 0) return { project, taskMap };

  const tasks = issues.map((issue) => {
    const days = jiraIssueEstimate(issue, hoursPerDay).days;
    return {
      id: addedScopeTaskId(issue.key),
      name: issue.summary || issue.key,
      estimateDays: days,
      specialization: scope[issue.key],
      excluded: days <= 0,
    };
  });
  return {
    project: {
      ...project,
      epics: [
        ...project.epics,
        { id: ADDED_SCOPE_EPIC_ID, name: "Added scope", tasks },
      ],
      teamInclusions: project.teamInclusions?.map((inc) =>
        inc.epicIds && inc.epicIds.length > 0 && !inc.exclusive
          ? { ...inc, epicIds: [...inc.epicIds, ADDED_SCOPE_EPIC_ID] }
          : inc,
      ),
    },
    taskMap: addedScopeTaskMap(taskMap, scope),
  };
}

/** Task progress is deliberately binary: only Jira's Done category is done. */
export function taskCompletion(issue: JiraIssue): 0 | 1 {
  return issue.statusCategory === "done" ? 1 : 0;
}

export interface EarnedTaskRow {
  /** Planner task this Jira issue counts towards; null = not counted. */
  plannerTaskId: ID | null;
  /** Share of the Planner task's estimate assigned to this Jira issue. */
  plannedDays: number;
  /** `1` only when Jira puts the issue in its Done status category. */
  completion: 0 | 1;
  /** `plannedDays × completion`. */
  earned: number;
}

export interface EarnedTaskDays {
  total: number;
  perJiraTask: Map<string, EarnedTaskRow>;
}

/**
 * Convert Jira child-issue completion into Planner task days.
 *
 * Jira epics are intentionally irrelevant here: initiatives get reorganised,
 * split and renamed while the underlying tasks remain recognisable. If several
 * Jira issues are manually mapped to one Planner task, its estimate is split
 * by Jira original estimate (equally when none is set) so it is never counted
 * more than once.
 */
export function earnedTaskDays(
  project: Project,
  snapshot: JiraSnapshot,
  taskMap: Tracker["taskMap"],
): EarnedTaskDays {
  const planned = plannedDaysByTask(project);
  const map = taskMap ?? {};
  const tasks = jiraTasks(snapshot);
  const groups = new Map<ID, JiraIssue[]>();
  const mappedTo = new Map<string, ID>();

  for (const issue of tasks) {
    if (!Object.prototype.hasOwnProperty.call(map, issue.key)) continue;
    const target = map[issue.key];
    if (target === null || target === undefined) continue;
    mappedTo.set(issue.key, target);
    const group = groups.get(target);
    if (group) group.push(issue);
    else groups.set(target, [issue]);
  }

  const shares = new Map<string, number>();
  for (const [plannerTaskId, members] of groups) {
    const days = planned.get(plannerTaskId) ?? 0;
    const weights = members.map((issue) =>
      Math.max(0, num(issue.originalEstimateSec)),
    );
    let sum = weights.reduce((a, b) => a + b, 0);
    const equal = sum <= 0;
    if (equal) sum = members.length;
    members.forEach((issue, index) => {
      const weight = equal ? 1 : weights[index];
      shares.set(issue.key, sum > 0 ? days * (weight / sum) : 0);
    });
  }

  const perJiraTask = new Map<string, EarnedTaskRow>();
  let total = 0;
  for (const issue of tasks) {
    const plannerTaskId = mappedTo.get(issue.key) ?? null;
    const completion = taskCompletion(issue);
    const plannedDays =
      plannerTaskId === null ? 0 : (shares.get(issue.key) ?? 0);
    const earned = plannedDays * completion;
    total += earned;
    perJiraTask.set(issue.key, {
      plannerTaskId,
      plannedDays,
      completion,
      earned,
    });
  }

  return { total, perJiraTask };
}

/* -------------------------------- status ---------------------------------- */

/**
 * One specialization's own reading: its part of the plan against its own
 * finished Jira tasks, on its own people's calendar.
 *
 * The overall reading adds every specialization's work into one curve, so a
 * frontend running well ahead can hide QA falling behind — and the end date is
 * decided by whichever finishes last, not by the average.
 */
export interface SpecializationStatus {
  specialization: string;
  kind:
    | "ahead"
    | "on-plan"
    /** Behind its own plan, but still finishing before the end date. */
    | "behind"
    /** Behind far enough to finish after the project's end date. */
    | "late"
    /** Nothing planned or done yet; its first task starts later. */
    | "not-started"
    /** Nobody on the plan has this specialization, so nothing is scheduled. */
    | "unscheduled"
    /** Everything it has an estimate for is finished. */
    | "done"
    /** It has tasks, but none with an estimate yet, so there is nothing to measure. */
    | "no-estimate";
  /** Plan days of this specialization expected finished by today. */
  plannedDays: number;
  /** Plan days of this specialization Jira says are finished. */
  earnedDays: number;
  /** All plan days of this specialization. */
  totalDays: number;
  /** Team working days ahead (+) or behind (−) its own plan. */
  varianceDays: number;
  /** When its first planned task starts. */
  firstStart: string | null;
  /** Its last task's end without buffer. */
  unbufferedEnd: string | null;
  /** Its own finish shifted by its variance. */
  projectedFinish: string | null;
  /** Working days from its projected finish to its deadline: the end of
   *  development, or the project end date for end-phase work. */
  marginDays: number | null;
  /**
   * Its own buffer: working days from its finish without buffer to its
   * deadline, so `marginDays = bufferDays + varianceDays` while it is behind.
   * For end-phase work, the gap between its two start dates. Null without a
   * deadline.
   */
  bufferDays: number | null;
  /**
   * Set when its finish was counted by its people rather than by the plan's
   * curve (see {@link finishByPeople}): when they get through the work left,
   * the plan days that will not fit before the deadline, and the working days
   * its people need for them after (both 0 when it all fits).
   */
  peopleLate?: {
    overflowDays: number;
    days: number;
    /** People who work after the deadline: what the overflow is split by. */
    people: number;
    /** Plan days they do on a full day: their speeds (team velocity
     *  included) added up, so equal to `people` only at speed 1. */
    perDay: number;
    /** When they get through the work left, all of them together. */
    finish?: string;
  };
  /** Tasks of this specialization with no estimate yet (0 days), leaving out
   *  those already done in Jira. */
  unestimatedTasks: number;
  /**
   * True when custom dates re-time it but its own people cannot keep the even
   * pace for the work left, so they set the pace instead: `plannedDays` is
   * then what they must have finished by today to be done by the finish
   * without buffer. See {@link bounded}.
   */
  capacityBound?: boolean;
  /**
   * Set for end-phase work (QA), which is counted back from the end date
   * rather than measured against where the scheduler put its tasks.
   */
  phase?: {
    /** When it must start to follow the buffered schedule. */
    mustStartBy: string | null;
    /** The very latest it can start: the schedule without buffer. */
    latestStart: string | null;
    /** The end date. */
    to: string;
    /** Working days between the two starts: QA's own buffer. */
    bufferDays: number;
    /** Person-days its people have left, from today to the end date. */
    capacityDays: number;
    /** Plan days of its work still to do. */
    remainingDays: number;
    /** True when `mustStartBy` falls before the end of development. */
    overlapsDevelopment: boolean;
    /** Its tasks as scheduled back from the end date, buffer included. */
    schedule: EndPhaseItem[];
  };
}

/**
 * The dates a tracker is judged against, each either taken from the baseline
 * plan or set by hand, with what the plan itself says kept alongside so the UI
 * can always show both.
 */
export interface ResolvedDeadlines {
  /** The start the plan is measured from. */
  startDate: string;
  startFromPlan: boolean;
  /** The project's own start date. */
  planStartDate: string;
  /** The end date, or null when nothing is scheduled at all. */
  endDate: string | null;
  endDateFromPlan: boolean;
  /** The plan's finish with buffer. */
  planEndDate: string | null;
  /**
   * When development must stop, or null when there is no end phase and no
   * date was set — development then simply runs to the end date.
   */
  devEndDate: string | null;
  devEndFromPlan: boolean;
  /** The plan's last finish (with buffer) of the development specializations. */
  planDevEndDate: string | null;
  /** Specializations in the project whose work is the end phase. */
  endPhase: string[];
}

const END_PHASE_NAME = /\b(qa|qc|tests?|testing|testers?)\b/i;

/** Every specialization with a task in the project, in first-seen order. */
function projectSpecializations(project: Project): string[] {
  const out: string[] = [];
  for (const epic of project.epics) {
    for (const t of epic.tasks) {
      if (t.specialization && !out.includes(t.specialization)) {
        out.push(t.specialization);
      }
    }
  }
  return out;
}

/**
 * Specializations whose names suggest end-of-project work (QA, QC, Test), for
 * the UI to *suggest* as the end phase. Never applied on its own: an absent
 * end phase keeps a tracker reading exactly as it always has.
 */
export function suggestedEndPhase(project: Project): string[] {
  return projectSpecializations(project).filter((s) => END_PHASE_NAME.test(s));
}

/**
 * Apply the defaults of {@link TrackerDeadlines}. Every date defaults to what
 * the baseline plan says: its start date, its finish with buffer, and — for
 * the end of development — the last finish (with buffer) of the
 * specializations that count as development.
 */
export function resolveDeadlines(
  deadlines: TrackerDeadlines | undefined,
  project: Project,
  bufferedPlan: Plan | null,
): ResolvedDeadlines {
  const specs = projectSpecializations(project);
  const endPhase = specs.filter((s) => (deadlines?.endPhase ?? []).includes(s));
  const phase = new Set(endPhase);
  const planEndDate = bufferedPlan ? lastEnd(bufferedPlan) : null;
  const planDevEndDate = bufferedPlan
    ? lastEnd({
        ...bufferedPlan,
        assignments: bufferedPlan.assignments.filter(
          (a) => !phase.has(a.specialization),
        ),
      })
    : null;
  const endDate = deadlines?.endDate ?? planEndDate;
  const devEndDate =
    deadlines?.devEndDate ?? (endPhase.length > 0 ? planDevEndDate : null);
  return {
    startDate: deadlines?.startDate ?? project.startDate,
    startFromPlan: !deadlines?.startDate,
    planStartDate: project.startDate,
    endDate,
    endDateFromPlan: !deadlines?.endDate,
    planEndDate,
    devEndDate,
    devEndFromPlan: !deadlines?.devEndDate,
    planDevEndDate,
    endPhase,
  };
}

/** Everything the tracking panel shows, computed for one day. */
export interface TrackerStatus {
  kind: "no-baseline" | "ahead" | "on-plan" | "using-buffer" | "over-buffer";
  /** Only set for `no-baseline`: what is missing, in words. */
  reason?: string;
  /** The day this reading is for (the `today` argument). */
  today: string;
  /** Plan days the unbuffered plan expected finished by `today`. */
  plannedDays: number;
  /** Plan days Jira says are finished. */
  earnedDays: number;
  /** Working days ahead (positive) or behind (negative). */
  varianceDays: number;
  /** Working days of schedule buffer the plan has in total. */
  bufferDays: number;
  /** Schedule buffer consumed, clamped to `[0, bufferDays]`. */
  bufferUsedDays: number;
  /** Working days late beyond the buffer; 0 while the buffer holds. */
  overrunDays: number;
  /** The buffer expressed as effort: Σ estimates × `buffer/100`. */
  effortBufferDays: number;
  /** Extra slack from rounding each assignee's duration up to whole days. */
  roundingBufferDays: number;
  /** Unbuffered finish "U". */
  unbufferedEnd: string | null;
  /** Buffered (promised) finish "B". */
  bufferedEnd: string | null;
  /** U shifted by −variance working days. */
  projectedFinish: string | null;
  /**
   * Team working days from the projected finish to the promised one: positive
   * while the promise holds. Equals buffer + variance, but counted on the
   * calendar, so a holiday in between is not mistaken for margin.
   */
  marginDays: number | null;
  /** Jira original estimate, in days. */
  jiraSetDays: number;
  /** Jira time spent, in days. */
  jiraSpentDays: number;
  /** Jira remaining estimate, in days. */
  jiraRemainingDays: number;
  /** Plan total − earned, in plan days. The counterpart to the line above. */
  planRemainingDays: number;
  /** The date the headline is judged against: the end of development when
   *  there is one, otherwise the project end date. */
  deadline: string | null;
  deadlineKind: "end" | "dev-end";
  /** The deadlines in force, defaults applied. */
  deadlines: ResolvedDeadlines | null;
  /** "development" when end-phase work (QA) is left out of the headline. */
  scope: "all" | "development";
  /**
   * Set when custom dates re-time development: the window those dates give it
   * (with buffer) and the buffer share taken out of it. The finish without
   * buffer and "planned so far" then come from this window, not the
   * scheduler. See {@link retimedReading}.
   */
  window: { from: string; to: string; bufferPct: number } | null;
  /** As on {@link SpecializationStatus}: the people, not your dates, set the pace. */
  capacityBound?: boolean;
  /**
   * The development specialization that decides the headline: the one with
   * the least to spare before the deadline. Development is finished when its
   * last specialization is, so the verdict — variance, buffer, projected
   * finish and margin — is that row's own reading, not the pooled one. Absent
   * when no specialization has a reading (old epic-only snapshots, or every
   * one done); the pooled reading stands then. See {@link criticalSpecialization}.
   */
  critical?: string;
  /**
   * Set when the tracker reads only some of the project's teams
   * (`Tracker.viewTeams`). Every number above is then theirs alone: their
   * Jira tasks, the plan tasks those map to, their people. See
   * {@link teamScope}.
   */
  teamScope?: TeamScopeInfo;
  /**
   * The same reading per specialization, worst end-date margin first. Empty
   * when the comparison is not task-level (old epic-only snapshots) or there
   * is no baseline.
   */
  bySpecialization: SpecializationStatus[];
}

function emptyStatus(today: string): TrackerStatus {
  return {
    kind: "no-baseline",
    today,
    plannedDays: 0,
    earnedDays: 0,
    varianceDays: 0,
    bufferDays: 0,
    bufferUsedDays: 0,
    overrunDays: 0,
    effortBufferDays: 0,
    roundingBufferDays: 0,
    unbufferedEnd: null,
    bufferedEnd: null,
    projectedFinish: null,
    marginDays: null,
    jiraSetDays: 0,
    jiraSpentDays: 0,
    jiraRemainingDays: 0,
    planRemainingDays: 0,
    deadline: null,
    deadlineKind: "end",
    deadlines: null,
    scope: "all",
    window: null,
    bySpecialization: [],
  };
}

/**
 * Jira's own totals in days. Epics mapped to `null` are excluded — that is
 * scope the user said is not part of this plan — but undecided (unmapped) epics
 * are counted, because unclaimed scope in the initiative is exactly the drift
 * this side-by-side is meant to expose.
 */
function jiraTotals(
  snapshot: JiraSnapshot | undefined,
  epicMap: Tracker["epicMap"],
  taskMap: Tracker["taskMap"],
  hoursPerDay: number,
): { set: number; spent: number; remaining: number } {
  const epicScope = epicMap ?? {};
  const taskScope = taskMap ?? {};
  let originalSec = 0;
  let spentSec = 0;
  let remainingSec = 0;
  const tasks = snapshot ? jiraTasks(snapshot) : [];
  if (tasks.length > 0) {
    for (const issue of tasks) {
      if (
        Object.prototype.hasOwnProperty.call(taskScope, issue.key) &&
        taskScope[issue.key] === null
      ) {
        continue;
      }
      originalSec += Math.max(0, num(issue.originalEstimateSec));
      spentSec += Math.max(0, num(issue.timeSpentSec));
      if (issue.statusCategory !== "done") {
        remainingSec += Math.max(
          0,
          num(issue.remainingEstimateSec ?? issue.originalEstimateSec),
        );
      }
    }
  } else {
    // Backward compatibility for old snapshots that did not carry children.
    for (const e of snapshot?.epics ?? []) {
      if (
        Object.prototype.hasOwnProperty.call(epicScope, e.key) &&
        epicScope[e.key] === null
      ) {
        continue;
      }
      originalSec += Math.max(0, num(e.totals?.originalSec));
      spentSec += Math.max(0, num(e.totals?.spentSec));
      remainingSec += Math.max(0, num(e.totals?.remainingSec));
    }
  }
  const secPerDay = hoursPerDay * 3600;
  return {
    set: round2(originalSec / secPerDay),
    spent: round2(spentSec / secPerDay),
    remaining: round2(remainingSec / secPerDay),
  };
}

/**
 * The whole of §7 for one tracker on one day.
 *
 * Returns `kind: "no-baseline"` with a human `reason` whenever the comparison
 * can't be made — no project, no snapshot, nothing scheduled, or nothing
 * mapped — while still filling in every number that *is* known, so the panel
 * can show the Jira side alone.
 */
export function trackerStatus(
  tracker: Tracker,
  project: Project | undefined,
  teams: Team[],
  today: string,
): TrackerStatus {
  // The status is about what the plan must deliver.
  tracker = mustDoTracker(tracker);
  const scoped = project ? teamScope(tracker, project, teams) : null;
  if (!scoped) return readStatus(tracker, project, teams, today);
  const status = readStatus(scoped.tracker, scoped.project, teams, today);
  status.teamScope = scoped.info;
  return status;
}

/** {@link trackerStatus} for the work as given, with no team selection. */
function readStatus(
  tracker: Tracker,
  project: Project | undefined,
  teams: Team[],
  today: string,
): TrackerStatus {
  const hoursPerDayRaw = num(tracker.hoursPerDay);
  const hoursPerDay =
    hoursPerDayRaw > 0 ? hoursPerDayRaw : DEFAULT_HOURS_PER_DAY;
  // Another team's epics count for nothing; added scope is this team's work,
  // so Jira's own totals count it too.
  const tracked = trackedMapping(tracker);
  const jira = jiraTotals(
    tracker.snapshot,
    tracker.epicMap,
    addedScopeTaskMap(tracked.taskMap, tracked.addedScope),
    hoursPerDay,
  );

  const status = emptyStatus(today);
  status.jiraSetDays = jira.set;
  status.jiraSpentDays = jira.spent;
  status.jiraRemainingDays = jira.remaining;

  if (!project) {
    status.reason = "No baseline project is linked to this tracker.";
    return status;
  }
  const snapshot = tracker.snapshot;
  if (!snapshot) {
    status.reason = "No Jira data yet — refresh the tracker.";
    return status;
  }

  // A start date set on the tracker re-plans the project from that day: the
  // stored plan was laid out from the old start, so it cannot be reused.
  const startOverride = tracker.deadlines?.startDate;
  const original = project;
  if (startOverride && startOverride !== project.startDate) {
    project = { ...project, startDate: startOverride, plan: null };
  }

  // The promise is the baseline as planned. Progress is measured against the
  // baseline plus any added scope, so extra work uses up buffer (or runs
  // late) rather than quietly moving the promised date along with it.
  const promised = baselinePlans(project, teams);
  const withScope = withAddedScope(
    project,
    snapshot,
    tracked.taskMap,
    tracked.addedScope,
    tracker.hoursPerDay,
  );
  const base =
    withScope.project === project
      ? promised
      : baselinePlans(withScope.project, teams);
  project = withScope.project;
  status.effortBufferDays = promised.effortBufferDays;
  status.roundingBufferDays = round2(num(base.buffered.roundingBufferDays));
  status.bufferedEnd = promised.bufferedEnd;

  if (!base.unbufferedEnd) {
    status.reason = `${project.name} has no scheduled work to compare against.`;
    return status;
  }

  const deadlines = {
    ...resolveDeadlines(tracker.deadlines, project, promised.buffered),
    planStartDate: original.startDate,
  };
  status.deadlines = deadlines;
  const endPhase = new Set(deadlines.endPhase);

  // With an end phase, the headline is development alone, judged against the
  // end of development: QA's tasks sit early in the schedule only because the
  // scheduler starts everything as soon as someone is free.
  const devAssignments = base.unbuffered.assignments.filter(
    (a) => !endPhase.has(a.specialization),
  );
  const scoped = endPhase.size > 0 && devAssignments.length > 0;
  const plan: Plan = scoped
    ? { ...base.unbuffered, assignments: devAssignments }
    : base.unbuffered;
  const calendar = scoped
    ? teamCalendar(project, teams, (spec) => !endPhase.has(spec))
    : base.calendar;
  const unbufferedEnd = lastEnd(plan) ?? base.unbufferedEnd;
  const deadline = deadlines.devEndDate ?? deadlines.endDate;
  status.scope = scoped ? "development" : "all";
  status.unbufferedEnd = unbufferedEnd;
  status.deadline = deadline;
  status.deadlineKind = deadlines.devEndDate ? "dev-end" : "end";
  // The slack between finishing without buffer and the deadline. With the
  // plan's own end date as the deadline this is exactly the schedule buffer.
  status.bufferDays = deadline
    ? Math.max(0, workdaysBetween(unbufferedEnd, deadline, calendar))
    : base.bufferDays;

  const tasks = jiraTasks(snapshot);
  let earnedTotal: number;
  let mapped = 0;
  let perTask: EarnedTaskDays | null = null;
  if (tasks.length > 0) {
    const effectiveMap = autoTaskMap(project, snapshot, withScope.taskMap);
    const earned = earnedTaskDays(project, snapshot, effectiveMap);
    perTask = earned;
    // Only work the plan scheduled counts, because only it is in the plan
    // total. A finished task nobody on the plan can do (its specialization
    // left with a team) would otherwise read as progress on the work that is
    // left, and taking a team away would put the tracker further ahead.
    const scheduled = new Set(plan.assignments.map((a) => a.taskId));
    earnedTotal = 0;
    for (const row of earned.perJiraTask.values()) {
      if (row.plannerTaskId === null) continue;
      mapped++;
      if (scheduled.has(row.plannerTaskId)) earnedTotal += row.earned;
    }
  } else {
    // Old snapshots without child issues retain their previous epic-level
    // comparison until the next refresh supplies task data.
    const earned = earnedDays(project, snapshot, tracker.epicMap);
    earnedTotal = earned.total;
    for (const row of earned.perJiraEpic.values()) {
      if (row.plannerEpicId !== null) mapped++;
    }
  }
  const plannedTotal = plannedDoneBy(plan, FAR_FUTURE);
  status.plannedDays = round2(plannedDoneBy(plan, today));
  status.planRemainingDays = round2(plannedTotal);
  if (mapped === 0) {
    status.reason =
      `No Jira ${tasks.length > 0 ? "tasks are mapped to plan tasks" : "epics are mapped to plan epics"} yet, so nothing can be ` +
      "counted as earned.";
    return status;
  }

  // Custom dates re-time development: its window is your start to your end
  // of development, and the scheduler's dates stop mattering. With neither
  // set, the scheduler's plan is the measuring stick as it always was.
  const custom = tracker.deadlines ?? {};
  const devWindow =
    deadline &&
    (custom.startDate ||
      custom.devEndDate ||
      (deadlines.endPhase.length === 0 && custom.endDate)) &&
    deadlines.startDate <= deadline
      ? {
          from: deadlines.startDate,
          to: deadline,
          bufferPct: Math.max(0, num(project.buffer)),
        }
      : null;

  let variance: number;
  status.earnedDays = round2(earnedTotal);
  status.planRemainingDays = round2(Math.max(0, plannedTotal - earnedTotal));
  const es = earnedScheduleDate(plan, earnedTotal, project.startDate);
  // Positive = ahead: the plan only reached this much work *later* than today.
  const scheduledVariance = workdaysBetween(today, es, calendar);
  const scheduledFinish = addWorkdays(
    unbufferedEnd,
    -scheduledVariance,
    calendar,
  );
  if (devWindow) {
    const r = bounded(
      retimedReading({
        totalDays: plannedTotal,
        earnedDays: earnedTotal,
        ...devWindow,
        today,
        calendar,
      }),
      { plan, end: unbufferedEnd, finish: scheduledFinish },
      devWindow.to,
      today,
      calendar,
    );
    status.window = devWindow;
    if (r.capacityBound) status.capacityBound = true;
    status.plannedDays = r.plannedDays;
    status.unbufferedEnd = r.unbufferedEnd;
    status.bufferDays = r.bufferDays;
    status.projectedFinish = r.projectedFinish;
    status.marginDays = r.marginDays;
    variance = r.varianceDays;
  } else {
    variance = scheduledVariance;
    status.projectedFinish = scheduledFinish;
    status.marginDays = deadline
      ? workdaysBetween(status.projectedFinish, deadline, calendar)
      : null;
  }
  status.varianceDays = variance;

  if (perTask) {
    status.bySpecialization = specializationBreakdown(
      project,
      teams,
      base,
      perTask,
      deadlines,
      today,
      devWindow,
    );
    const critical = criticalSpecialization(status.bySpecialization);
    if (critical) {
      status.critical = critical.specialization;
      status.varianceDays = critical.varianceDays;
      status.bufferDays = critical.bufferDays ?? status.bufferDays;
      status.unbufferedEnd = critical.unbufferedEnd ?? status.unbufferedEnd;
      status.projectedFinish = critical.projectedFinish;
      status.marginDays = critical.marginDays;
    }
  }

  const v = status.varianceDays;
  status.bufferUsedDays = Math.min(Math.max(0, -v), status.bufferDays);
  status.overrunDays = Math.max(0, -(status.marginDays ?? 0));

  if (status.marginDays !== null && status.marginDays < -0.5) {
    status.kind = "over-buffer";
  } else if (v > 0.5) status.kind = "ahead";
  else if (Math.abs(v) <= 0.5) status.kind = "on-plan";
  else status.kind = "using-buffer";

  return status;
}

/** How a Jira task's team was worked out, strongest first. */
export type TaskTeamSource = "set" | "jira" | "assignee" | "epic";

/** Teams are matched on name, whatever the case or spacing. */
export function teamKey(name: string): string {
  return normPerson(name);
}

/**
 * The team each Jira task belongs to, by name.
 *
 * Work is owned per task, not per epic: one epic can hold tasks of two teams,
 * though usually an epic is one team's. In order: a team set by hand on the
 * task; the issue's own Jira "Team" field; its epic's Jira "Team" field; the
 * Planner team of its Jira assignee (matched on display name, as the Jira
 * import matches people); and for a task with none of those, the team most of
 * its epic's tasks belong to. A task none of these places is absent from the
 * map. Names come back as Jira spells them, else as the Planner team does.
 */
export function jiraTaskTeams(
  snapshot: JiraSnapshot,
  project: Project,
  teams: Team[],
  taskTeams: Tracker["taskTeams"],
): Map<string, { team: string; source: TaskTeamSource }> {
  const spelling = new Map<string, string>();
  const spell = (name: string) => {
    const key = teamKey(name);
    if (key && !spelling.has(key)) spelling.set(key, name.trim());
    return spelling.get(key) ?? name.trim();
  };
  for (const epic of snapshot.epics ?? []) if (epic.team) spell(epic.team);
  for (const issue of jiraTasks(snapshot)) if (issue.team) spell(issue.team);
  const included = includedTeams(project, teams);
  for (const team of included) spell(team.name);

  const byPerson = new Map<string, string>();
  for (const team of included) {
    for (const m of team.members) {
      const name = normPerson(m.name);
      if (name && !byPerson.has(name)) byPerson.set(name, spell(team.name));
    }
  }
  const set = taskTeams ?? {};
  const out = new Map<string, { team: string; source: TaskTeamSource }>();
  for (const epic of snapshot.epics ?? []) {
    const unplaced: string[] = [];
    const votes = new Map<string, number>();
    const place = (key: string, team: string, source: TaskTeamSource) => {
      out.set(key, { team, source });
      votes.set(team, (votes.get(team) ?? 0) + 1);
    };
    for (const issue of epic.children ?? []) {
      if (!issue.key || out.has(issue.key)) continue;
      const chosen = (set[issue.key] ?? "").trim();
      if (chosen) place(issue.key, spell(chosen), "set");
      else if (issue.team) place(issue.key, spell(issue.team), "jira");
      else if (epic.team) place(issue.key, spell(epic.team), "epic");
      else {
        const owner = issue.assignee
          ? byPerson.get(normPerson(issue.assignee.displayName))
          : undefined;
        if (owner) place(issue.key, owner, "assignee");
        else unplaced.push(issue.key);
      }
    }
    // Most votes wins; a tie goes to the team seen first.
    let best: string | null = null;
    for (const [team, n] of votes) {
      if (best === null || n > (votes.get(best) ?? 0)) best = team;
    }
    if (best) {
      for (const key of unplaced) out.set(key, { team: best, source: "epic" });
    }
  }
  return out;
}

/** One team a tracker can be read for. */
export interface TrackerTeam {
  name: string;
  /** Tracked Jira tasks that are this team's. */
  tasks: number;
  /** The Planner team of the same name, whose people do the work; null when
   *  the project has none. */
  plannerTeamId: ID | null;
}

/**
 * The teams in a tracker: every team its Jira tasks belong to, most tasks
 * first, then the project's own teams that have no task yet (so work can
 * still be given to them by hand). Another team's untracked epics don't count.
 */
export function trackerTeams(
  tracker: Tracker,
  project: Project,
  teams: Team[],
): TrackerTeam[] {
  const included = includedTeams(project, teams);
  const planner = new Map(included.map((t) => [teamKey(t.name), t.id]));
  const counts = new Map<string, { name: string; tasks: number }>();
  if (tracker.snapshot) {
    const skip = untrackedIssueKeys(tracker.snapshot, tracker.untrackedEpics);
    const owners = jiraTaskTeams(
      tracker.snapshot,
      project,
      teams,
      tracker.taskTeams,
    );
    for (const issue of jiraTasks(tracker.snapshot)) {
      if (skip.has(issue.key)) continue;
      const owner = owners.get(issue.key);
      if (!owner) continue;
      const key = teamKey(owner.team);
      const entry = counts.get(key) ?? { name: owner.team, tasks: 0 };
      entry.tasks++;
      counts.set(key, entry);
    }
  }
  const out: TrackerTeam[] = [...counts]
    .sort((a, b) => b[1].tasks - a[1].tasks)
    .map(([key, e]) => ({
      name: e.name,
      tasks: e.tasks,
      plannerTeamId: planner.get(key) ?? null,
    }));
  for (const team of included) {
    if (!counts.has(teamKey(team.name))) {
      out.push({ name: team.name, tasks: 0, plannerTeamId: team.id });
    }
  }
  return out;
}

/** A person's name for matching: no accents, case or extra spacing. */
export function normPerson(s: string): string {
  return (
    String(s ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      // Letters with a stroke have no combining mark to strip: "Michał" is
      // still "Michal" in a Jira profile typed without Polish letters.
      .replace(/ł/g, "l")
      .replace(/ø/g, "o")
      .replace(/đ/g, "d")
      .replace(/\s+/g, " ")
  );
}

/** What a team-scoped reading covers, for the panel to say so. */
export interface TeamScopeInfo {
  /** The teams read. */
  teamNames: string[];
  /**
   * The Planner teams whose people count as theirs, by name; empty when no
   * Planner team matches, and everyone on the project counts instead.
   */
  peopleFrom: string[];
  /** Jira tasks left out as another team's. */
  otherTeamTasks: number;
  /** Jira tasks no team could be worked out for: left out until one is set. */
  noTeamTasks: number;
  /** Plan tasks left out because no Jira task of these teams maps to them. */
  planTasksLeftOut: number;
}

/**
 * The tracker and project cut down to the selected teams
 * (`Tracker.viewTeams`), or null when every team is read.
 *
 * The plan has no notion of which team a task is for — the scheduler gives it
 * to whoever is free — so ownership comes from Jira, task by task
 * ({@link jiraTaskTeams}). The cut keeps the selected teams' Jira tasks, the
 * plan tasks they map to, and the people of the Planner teams of the same name
 * (helpers belong to no team, so they leave too). With no Planner team of that
 * name, everyone on the project stays, and the panel says so. The reading
 * then runs on that as on any project: its own plan without buffer, its own
 * buffer, its own capacity. Dates you set on the tracker still apply; dates
 * left to the plan come from this team's part of it.
 */
/**
 * The teams a tracker's reading is limited to (`Tracker.viewTeams`), spelled
 * as `trackerTeams` lists them, or null when it reads every team: nothing
 * selected, everything selected, or only names that are no team any more.
 */
export function selectedTeams(
  tracker: Tracker,
  project: Project,
  teams: Team[],
): string[] | null {
  if (!tracker.snapshot) return null;
  const listed = trackerTeams(tracker, project, teams);
  const wanted = new Set((tracker.viewTeams ?? []).map(teamKey));
  const chosen = listed.filter((t) => wanted.has(teamKey(t.name)));
  if (chosen.length === 0 || chosen.length === listed.length) return null;
  return chosen.map((t) => t.name);
}

export function teamScope(
  tracker: Tracker,
  project: Project,
  teams: Team[],
): { tracker: Tracker; project: Project; info: TeamScopeInfo } | null {
  const snapshot = tracker.snapshot;
  if (!snapshot) return null;
  const names = selectedTeams(tracker, project, teams);
  if (!names) return null;
  const chosen = new Set(names.map(teamKey));

  const owners = jiraTaskTeams(snapshot, project, teams, tracker.taskTeams);
  const skip = untrackedIssueKeys(snapshot, tracker.untrackedEpics);
  let otherTeamTasks = 0;
  let noTeamTasks = 0;
  const keep = (issue: JiraIssue): boolean => {
    if (skip.has(issue.key)) return true; // left out anyway; keep it so
    const owner = owners.get(issue.key);
    if (!owner) {
      noTeamTasks++;
      return false;
    }
    if (!chosen.has(teamKey(owner.team))) {
      otherTeamTasks++;
      return false;
    }
    return true;
  };
  const kept: JiraSnapshot = {
    ...snapshot,
    epics: snapshot.epics.map((epic) => ({
      ...epic,
      children: epic.children?.filter(keep),
    })),
  };

  // The plan tasks this work maps to, matched on the whole initiative so
  // another team's issue never loses its plan task to a lookalike.
  const tracked = trackedMapping(tracker);
  const map = autoTaskMap(project, snapshot, tracked.taskMap);
  const planTasks = new Set<ID>();
  for (const issue of jiraTasks(kept)) {
    if (skip.has(issue.key)) continue;
    const id = map[issue.key];
    if (typeof id === "string") planTasks.add(id);
  }
  let planTasksLeftOut = 0;
  const epics = project.epics.map((epic) => ({
    ...epic,
    tasks: epic.tasks
      .filter((t) => {
        if (planTasks.has(t.id)) return true;
        if (!t.excluded) planTasksLeftOut++;
        return false;
      })
      .map((t) =>
        t.dependsOn
          ? { ...t, dependsOn: t.dependsOn.filter((id) => planTasks.has(id)) }
          : t,
      ),
  }));

  // Their people: the Planner teams of the same names. None matching keeps
  // everyone, rather than leaving the work with nobody to do it.
  const included = includedTeams(project, teams);
  const peopleTeams = included.filter((t) => chosen.has(teamKey(t.name)));
  const people =
    peopleTeams.length > 0
      ? {
          teamInclusions: (
            project.teamInclusions ?? included.map((t) => ({ teamId: t.id }))
          ).filter((inc) => peopleTeams.some((t) => t.id === inc.teamId)),
          helpers: [],
        }
      : {};

  return {
    tracker: { ...tracker, snapshot: kept, viewTeams: undefined },
    project: { ...project, epics, plan: null, ...people },
    info: {
      teamNames: names,
      peopleFrom: peopleTeams.map((t) => t.name),
      otherTeamTasks,
      noTeamTasks,
      planTasksLeftOut,
    },
  };
}

/**
 * Jira statuses where the work is written but not yet closed: in review,
 * waiting for review, or ready. Matched on the status *name*, since Jira puts
 * them all in the "In Progress" category alongside work barely started. A
 * "Ready for development" status is work not begun, so it is left out.
 */
export function isAwaitingClose(issue: JiraIssue): boolean {
  if (issue.statusCategory === "done") return false;
  const name = String(issue.status ?? "");
  if (READY_TO_START.test(name)) return false;
  return /\b(review|ready)\b/i.test(name);
}

const READY_TO_START =
  /\bready\s+(for|to)\s+(dev|development|work|start|refinement|grooming|estimation|planning|sprint)\b/i;

/** Statuses that are work in hand, not work handed on: still in progress. */
const STILL_IN_PROGRESS =
  /\b(in\s*progress|in\s*development|doing|blocked|on\s*hold|paused)\b/i;

/**
 * Open work past To Do and In Progress: in review, in QA or testing, ready to
 * deploy — any status Jira puts in its "In Progress" category except the ones
 * that mean the work is still in hand ("In Progress", "In Development",
 * "Blocked", "On Hold") or not begun ("Ready for development"). Wider than
 * {@link isAwaitingClose}, which only matches review and ready.
 */
export function isPastInProgress(issue: JiraIssue): boolean {
  if (issue.statusCategory !== "indeterminate") return false;
  const name = String(issue.status ?? "");
  return !STILL_IN_PROGRESS.test(name) && !READY_TO_START.test(name);
}

/**
 * The tracker with every task past In Progress ({@link isPastInProgress})
 * counted as done, for a reading that treats handed-on work as finished, and
 * how many tasks that closed. The same tracker back when none is.
 */
export function pastInProgressAsDone(tracker: Tracker): {
  tracker: Tracker;
  tasks: number;
} {
  const snapshot = tracker.snapshot;
  if (!snapshot) return { tracker, tasks: 0 };
  const skip = untrackedIssueKeys(
    snapshot,
    mustDoTracker(tracker).untrackedEpics,
  );
  let tasks = 0;
  const close = (issue: JiraIssue): JiraIssue => {
    if (!isPastInProgress(issue)) return issue;
    if (!skip.has(issue.key)) tasks++;
    return { ...issue, statusCategory: "done" };
  };
  const epics = snapshot.epics.map((epic) => ({
    ...epic,
    children: epic.children?.map(close),
  }));
  if (tasks === 0) return { tracker, tasks: 0 };
  return { tracker: { ...tracker, snapshot: { ...snapshot, epics } }, tasks };
}

/** Work waiting in review or ready states, and what closing it today buys. */
export interface AwaitingCloseWhatIf {
  /** Each status that matched, in the order first seen. */
  statuses: { status: string; tasks: number; days: number }[];
  /** The same queue per specialization, from the plan task each maps to.
   *  Tasks mapped to nothing are only in the totals. */
  bySpecialization: {
    specialization: string;
    tasks: number;
    days: number;
    /** People with this specialization still on the project. */
    people: number;
    /** `days` shared across them, at their speeds: working days of queue. */
    workingDays: number | null;
  }[];
  /** Tasks in those statuses, in tracked epics. */
  tasks: number;
  /** Plan days they would add to "earned" if closed. */
  days: number;
  /** The reading with every one of them closed today. */
  closed: TrackerStatus;
}

/**
 * What the reading would be if every task in a review or ready state were
 * closed today (see {@link isAwaitingClose}).
 *
 * Only Done counts as earned, so a team with a long review queue reads as
 * further behind than its written work suggests. This re-runs the same reading
 * with those tasks flipped to Done, so the difference — in projected finish
 * and margin — is exactly what clearing the queue today would buy. Another
 * team's epics are left out, as everywhere; a task that maps to nothing still
 * counts as a task, at 0 days.
 */
export function awaitingCloseWhatIf(
  tracker: Tracker,
  project: Project | undefined,
  teams: Team[],
  today: string,
): AwaitingCloseWhatIf | null {
  if (!project || !tracker.snapshot) return null;
  tracker = mustDoTracker(tracker);
  // A team selection reads only those teams' queue, against their people.
  const forTeams = teamScope(tracker, project, teams);
  if (forTeams) {
    tracker = forTeams.tracker;
    project = forTeams.project;
  }
  const snapshot = tracker.snapshot!;
  const skip = untrackedIssueKeys(snapshot, tracker.untrackedEpics);
  const waiting = new Set(
    jiraTasks(snapshot)
      .filter((issue) => !skip.has(issue.key) && isAwaitingClose(issue))
      .map((issue) => issue.key),
  );
  if (waiting.size === 0) return null;

  // Sized exactly as the reading sizes them: added scope by Jira, the rest
  // by their plan task's share.
  const tracked = trackedMapping(tracker);
  const scoped = withAddedScope(
    project,
    snapshot,
    tracked.taskMap,
    tracked.addedScope,
    tracker.hoursPerDay,
  );
  const perTask = earnedTaskDays(
    scoped.project,
    snapshot,
    autoTaskMap(scoped.project, snapshot, scoped.taskMap),
  ).perJiraTask;

  const specOf = new Map<ID, string>();
  for (const epic of scoped.project.epics) {
    for (const t of epic.tasks) specOf.set(t.id, t.specialization);
  }
  const byStatus = new Map<string, { tasks: number; days: number }>();
  const bySpec = new Map<string, { tasks: number; days: number }>();
  const add = (
    map: Map<string, { tasks: number; days: number }>,
    key: string,
    days: number,
  ) => {
    const entry = map.get(key) ?? { tasks: 0, days: 0 };
    entry.tasks += 1;
    entry.days += days;
    map.set(key, entry);
  };
  for (const issue of jiraTasks(snapshot)) {
    if (!waiting.has(issue.key)) continue;
    const row = perTask.get(issue.key);
    const days = row?.plannedDays ?? 0;
    add(byStatus, issue.status, days);
    const spec = row?.plannerTaskId ? specOf.get(row.plannerTaskId) : undefined;
    if (spec) add(bySpec, spec, days);
  }

  const closeIt = (issue: JiraIssue): JiraIssue =>
    waiting.has(issue.key)
      ? { ...issue, statusCategory: "done", status: "Done" }
      : issue;
  const closed = trackerStatus(
    {
      ...tracker,
      snapshot: {
        ...snapshot,
        epics: snapshot.epics.map((epic) => ({
          ...epic,
          children: epic.children?.map(closeIt),
        })),
      },
    },
    project,
    teams,
    today,
  );
  const statuses = [...byStatus].map(([status, e]) => ({
    status,
    tasks: e.tasks,
    days: round2(e.days),
  }));
  return {
    statuses,
    bySpecialization: [...bySpec].map(([specialization, e]) => {
      // Everyone with the specialization who has not left the project.
      const people = projectWorkers(project, teams).filter(
        (w) => w.specialization === specialization && (!w.to || w.to >= today),
      );
      const speed = people.reduce((sum, w) => sum + w.speed, 0);
      return {
        specialization,
        tasks: e.tasks,
        days: round2(e.days),
        people: people.length,
        workingDays: speed > 0 ? round2(e.days / speed) : null,
      };
    }),
    tasks: waiting.size,
    days: round2(statuses.reduce((sum, e) => sum + e.days, 0)),
    closed,
  };
}

/**
 * The development specialization that finishes last relative to the deadline.
 *
 * The pooled reading adds every specialization's work into one curve, then
 * shifts the plan's latest finish by the pooled delay. That pairs one
 * specialization's finish date with an average dominated by whichever has the
 * most work, so it can land later (or earlier) than any of them actually does
 * — a headline five days late over a table whose worst row is three. The
 * deadline is met only when every specialization meets it, so the one with
 * the least margin is the verdict.
 *
 * End-phase work (QA) has its own deadline and never decides development's.
 */
export function criticalSpecialization(
  rows: SpecializationStatus[],
): SpecializationStatus | null {
  let worst: SpecializationStatus | null = null;
  for (const r of rows) {
    if (r.phase || r.marginDays === null || r.projectedFinish === null)
      continue;
    if (
      r.kind !== "ahead" &&
      r.kind !== "on-plan" &&
      r.kind !== "behind" &&
      r.kind !== "late" &&
      r.kind !== "not-started"
    ) {
      continue;
    }
    if (worst === null || r.marginDays < worst.marginDays!) worst = r;
  }
  return worst;
}

/** One reading of progress against a straight-line plan through a window. */
export interface RetimedReading {
  plannedDays: number;
  varianceDays: number;
  /** Where the finish without buffer falls inside the window. */
  unbufferedEnd: string;
  projectedFinish: string;
  /** Working days from the finish without buffer to the window's end. */
  bufferDays: number;
  marginDays: number;
}

/**
 * Progress against *your* dates rather than the scheduler's.
 *
 * `from` → `to` is the time development has, buffer included. Taking the
 * buffer share out of it (`window ÷ (1 + buffer%)`) gives the finish without
 * buffer; the work is expected at an even pace up to that point, in team
 * working days, and what remains of the window is the buffer. So a 60-day
 * window with a 20% buffer expects everything done 50 days in and keeps 10 in
 * reserve, whatever order the scheduler would have picked.
 */
export function retimedReading(input: {
  totalDays: number;
  earnedDays: number;
  from: string;
  to: string;
  bufferPct: number;
  today: string;
  calendar: TeamCalendar;
}): RetimedReading {
  const { totalDays, earnedDays, to, today, calendar } = input;
  // The day before the window opens, so the first day of it counts.
  const before = toISO(addDays(fromISO(input.from), -1));
  const windowDays = Math.max(0, workdaysBetween(before, to, calendar));
  const factor = 1 + Math.max(0, num(input.bufferPct)) / 100;
  const noBufferDays = windowDays / factor;
  const unbufferedEnd = addWorkdays(before, noBufferDays, calendar);

  const elapsed = Math.min(
    noBufferDays,
    Math.max(0, workdaysBetween(before, today, calendar)),
  );
  const perDay = noBufferDays > 0 ? totalDays / noBufferDays : 0;
  const plannedDays =
    noBufferDays > 0 ? totalDays * (elapsed / noBufferDays) : totalDays;
  const earnedTime =
    perDay > 0 ? Math.min(noBufferDays, earnedDays / perDay) : 0;
  const varianceDays = round2(earnedTime - elapsed);
  const projectedFinish = addWorkdays(unbufferedEnd, -varianceDays, calendar);
  return {
    plannedDays: round2(plannedDays),
    varianceDays,
    unbufferedEnd,
    projectedFinish,
    bufferDays: Math.max(0, workdaysBetween(unbufferedEnd, to, calendar)),
    marginDays: workdaysBetween(projectedFinish, to, calendar),
  };
}

/**
 * A re-timed reading held to what the team can actually do.
 *
 * Your dates set the pace, but not the team's size: an even pace through the
 * window assumes the rest of the work fits in it, however few people are left
 * to do it. The scheduler, run on the project's real people, is the fastest the
 * rest can go, so its projected finish (its own finish shifted by its own
 * variance) is a floor. When that lands later, the reading takes it and the
 * variance is recounted from the window's finish without buffer, keeping
 * `projectedFinish = unbufferedEnd − variance` and `margin = buffer +
 * variance` as they are everywhere else.
 *
 * "Planned so far" moves with it. The even pace's figure would sit beside a
 * verdict it contradicts — more done than expected, yet behind — so it becomes
 * what has to be finished by today for the real people to do the rest by the
 * finish without buffer: the scheduler's own curve, slid so that it ends there.
 * Whichever of the two paces asks for more is the one that binds.
 */
function bounded(
  r: RetimedReading,
  scheduler: { plan: Plan; end: string; finish: string },
  to: string,
  today: string,
  calendar: TeamCalendar,
): RetimedReading & { capacityBound: boolean } {
  if (scheduler.finish <= r.projectedFinish) {
    return { ...r, capacityBound: false };
  }
  // The scheduler needs as long from `due` to its end as is left from today
  // to the finish without buffer, so what it has done by `due` is what must
  // be done by today.
  const due = addWorkdays(
    scheduler.end,
    -workdaysBetween(today, r.unbufferedEnd, calendar),
    calendar,
  );
  return {
    ...r,
    plannedDays: Math.max(
      r.plannedDays,
      round2(plannedDoneBy(scheduler.plan, due)),
    ),
    varianceDays: workdaysBetween(scheduler.finish, r.unbufferedEnd, calendar),
    projectedFinish: scheduler.finish,
    marginDays: workdaysBetween(scheduler.finish, to, calendar),
    capacityBound: true,
  };
}

/** A person's working pattern on this project, for capacity sums. */
interface Worker {
  specialization: string;
  speed: number;
  from?: string;
  to?: string;
  off: Set<string>;
}

function projectWorkers(project: Project, teams: Team[]): Worker[] {
  const out: Worker[] = [];
  const inclusions = new Map(
    (project.teamInclusions ?? []).map((inc) => [inc.teamId, inc]),
  );
  const starts = project.memberStarts ?? {};
  for (const team of includedTeams(project, teams)) {
    const inc = inclusions.get(team.id);
    const velocity = num(inc?.velocity) > 0 ? num(inc?.velocity) : 1;
    for (const m of team.members) {
      const start = starts[m.id];
      const windowFrom = inc?.availableFrom;
      out.push({
        specialization: m.specialization,
        speed: (num(m.speed) > 0 ? num(m.speed) : 1) * velocity,
        from:
          start && windowFrom
            ? start > windowFrom
              ? start
              : windowFrom
            : (start ?? windowFrom),
        to: inc?.availableTo,
        off: new Set(team.offDays?.[m.id] ?? []),
      });
    }
  }
  for (const h of project.helpers ?? []) {
    out.push({
      specialization: h.specialization,
      speed: num(h.speed) > 0 ? num(h.speed) : 1,
      from: h.availableFrom || undefined,
      to: h.availableTo || undefined,
      off: new Set(h.offDays ?? []),
    });
  }
  return out;
}

/** Plan days `workers` can do on one date. */
function capacityOn(workers: Worker[], dateISO: string): number {
  if (isWeekend(fromISO(dateISO))) return 0;
  let total = 0;
  for (const w of workers) {
    if (w.from && dateISO < w.from) continue;
    if (w.to && dateISO > w.to) continue;
    if (!w.off.has(dateISO)) total += w.speed;
  }
  return total;
}

/**
 * {@link trackerStatus}'s reading, once per specialization.
 *
 * Development specializations get the same earned-schedule maths on a
 * sub-plan of their own assignments, on the calendar of their own people, and
 * are judged against the end of development. One difference from the
 * headline: with nothing earned, a specialization is only behind once its
 * first task was due, so work planned for later does not read as behind.
 *
 * End-phase specializations (QA) ignore where the scheduler happened to put
 * their tasks and are counted back from the end date instead: see
 * {@link endPhaseRow}.
 */
function specializationBreakdown(
  project: Project,
  teams: Team[],
  base: BaselinePlans,
  earned: EarnedTaskDays,
  deadlines: ResolvedDeadlines,
  today: string,
  /** The re-timed development window, when custom dates set one. */
  devWindow: TrackerStatus["window"] = null,
): SpecializationStatus[] {
  const specOf = new Map<ID, string>();
  const specs = projectSpecializations(project);
  const plannedBySpec = new Map<string, number>();
  const unestimated = new Map<string, number>();
  // Plan tasks every mapped Jira issue of which is finished. One done without
  // an estimate is past fixing, so it is not counted as still to estimate.
  const finished = new Map<ID, boolean>();
  for (const row of earned.perJiraTask.values()) {
    if (row.plannerTaskId === null) continue;
    finished.set(
      row.plannerTaskId,
      (finished.get(row.plannerTaskId) ?? true) && row.completion === 1,
    );
  }
  for (const epic of project.epics) {
    for (const t of epic.tasks) {
      specOf.set(t.id, t.specialization);
      if (num(t.estimateDays) <= 0 && !finished.get(t.id)) {
        unestimated.set(
          t.specialization,
          (unestimated.get(t.specialization) ?? 0) + 1,
        );
      }
      if (t.excluded) continue;
      plannedBySpec.set(
        t.specialization,
        (plannedBySpec.get(t.specialization) ?? 0) + num(t.estimateDays),
      );
    }
  }
  // A specialization only appears if it has work, or work still to estimate.
  const shown = specs.filter(
    (s) => (plannedBySpec.get(s) ?? 0) > 0 || (unestimated.get(s) ?? 0) > 0,
  );

  const earnedBySpec = new Map<string, number>();
  const doneTasks = new Set<ID>();
  for (const row of earned.perJiraTask.values()) {
    if (row.plannerTaskId === null) continue;
    if (row.completion === 1) doneTasks.add(row.plannerTaskId);
    const spec = specOf.get(row.plannerTaskId);
    if (spec === undefined) continue;
    earnedBySpec.set(spec, (earnedBySpec.get(spec) ?? 0) + row.earned);
  }

  const endPhase = new Set(deadlines.endPhase);
  const devDeadline = deadlines.devEndDate ?? deadlines.endDate;
  const workers = projectWorkers(project, teams);

  const rows = shown.map((spec): SpecializationStatus => {
    const earnedDays = round2(earnedBySpec.get(spec) ?? 0);
    const totalDays = round2(plannedBySpec.get(spec) ?? 0);
    const row: SpecializationStatus = {
      specialization: spec,
      kind: "unscheduled",
      plannedDays: 0,
      earnedDays,
      totalDays,
      varianceDays: 0,
      firstStart: null,
      unbufferedEnd: null,
      projectedFinish: null,
      marginDays: null,
      bufferDays: null,
      unestimatedTasks: unestimated.get(spec) ?? 0,
    };
    const calendar = teamCalendar(project, teams, spec);

    if (totalDays <= EPS) {
      row.kind = "no-estimate";
      return row;
    }
    if (endPhase.has(spec) && deadlines.endDate) {
      const tasks = project.epics.flatMap((e) =>
        e.tasks
          .filter(
            (t) =>
              !t.excluded &&
              t.specialization === spec &&
              num(t.estimateDays) > 0,
          )
          .map((t) => ({
            id: t.id,
            name: t.name,
            estimateDays: num(t.estimateDays),
            done: doneTasks.has(t.id),
          })),
      );
      return endPhaseRow(
        row,
        tasks,
        workers,
        calendar,
        deadlines,
        num(project.buffer),
        today,
      );
    }

    // Nobody on the plan has this specialization, so no date means anything.
    const assignments = base.unbuffered.assignments.filter(
      (a) => a.specialization === spec,
    );
    if (assignments.length === 0) return row;

    const sub: Plan = { ...base.unbuffered, assignments };
    const ends = assignments.map((a) => a.end).sort();
    const firstEnd = ends[0];
    const lastEndDate = ends[ends.length - 1];

    let variance: number;
    if (earnedDays <= EPS) {
      // Nothing done: behind only by the time since its first task was due.
      const es = addWorkdays(firstEnd, -1, calendar);
      variance = today < firstEnd ? 0 : workdaysBetween(today, es, calendar);
    } else {
      const es = earnedScheduleDate(sub, earnedDays, project.startDate);
      variance = workdaysBetween(today, es, calendar);
    }
    const scheduledFinish = addWorkdays(lastEndDate, -variance, calendar);

    if (devWindow) {
      // Re-timed: every development specialization shares your window, but
      // can go no faster than its own people allow.
      const r = bounded(
        retimedReading({
          totalDays,
          earnedDays,
          ...devWindow,
          today,
          calendar,
        }),
        { plan: sub, end: lastEndDate, finish: scheduledFinish },
        devWindow.to,
        today,
        calendar,
      );
      row.firstStart = devWindow.from;
      if (r.capacityBound) row.capacityBound = true;
      row.plannedDays = r.plannedDays;
      row.varianceDays = r.varianceDays;
      row.unbufferedEnd = r.unbufferedEnd;
      row.projectedFinish = r.projectedFinish;
      row.marginDays = r.marginDays;
      row.bufferDays = r.bufferDays;
      if (earnedDays >= totalDays - EPS) row.kind = "done";
      else if (r.marginDays < -0.5) row.kind = "late";
      else if (earnedDays <= EPS && devWindow.from > today)
        row.kind = "not-started";
      else if (r.varianceDays > 0.5) row.kind = "ahead";
      else if (Math.abs(r.varianceDays) <= 0.5) row.kind = "on-plan";
      else row.kind = "behind";
      return row;
    }

    row.firstStart = assignments.map((a) => a.start).sort()[0];
    row.unbufferedEnd = lastEndDate;
    row.plannedDays = round2(plannedDoneBy(sub, today));
    row.varianceDays = variance;
    row.projectedFinish = scheduledFinish;
    row.marginDays = devDeadline
      ? workdaysBetween(row.projectedFinish, devDeadline, calendar)
      : null;
    row.bufferDays = devDeadline
      ? Math.max(0, workdaysBetween(lastEndDate, devDeadline, calendar))
      : null;

    if (earnedDays >= totalDays - EPS) row.kind = "done";
    else if (row.marginDays !== null && row.marginDays < -0.5)
      row.kind = "late";
    else if (earnedDays <= EPS && row.firstStart > today) {
      row.kind = "not-started";
    } else if (variance > 0.5) row.kind = "ahead";
    else if (Math.abs(variance) <= 0.5) row.kind = "on-plan";
    else row.kind = "behind";
    return row;
  });

  // When the work left gets done, counted by people: everyone who has this
  // specialization working through it together. See finishByPeople.
  for (const r of rows) {
    if (r.marginDays === null || r.projectedFinish === null) continue;
    // Development: whenever it reads behind its plan, so the finish never
    // depends on where the deadline is. End-phase work keeps its own schedule
    // and is only counted by people once it would miss the end date.
    if (r.phase ? r.kind !== "late" : r.kind !== "behind" && r.kind !== "late")
      continue;
    const deadline = r.phase ? r.phase.to : devDeadline;
    if (!deadline) continue;
    const people = workers.filter((w) => w.specialization === r.specialization);
    const calendar = teamCalendar(project, teams, r.specialization);
    const count = finishByPeople(
      people,
      r.totalDays - r.earnedDays,
      today,
      deadline,
      calendar,
    );
    if (count === null) continue;
    // It can win back time the plan's pace lost, but never claim a lead the
    // work hasn't earned: no earlier than the finish without buffer.
    const finish =
      !r.phase && r.unbufferedEnd && count.finish < r.unbufferedEnd
        ? r.unbufferedEnd
        : count.finish;
    if (finish >= r.projectedFinish) continue;
    r.peopleLate = {
      overflowDays: count.overflowDays,
      days: count.days,
      people: count.people,
      perDay: count.perDay,
      finish: count.finish,
    };
    r.projectedFinish = finish;
    r.marginDays = workdaysBetween(finish, deadline, calendar);
    // Development keeps margin = buffer + variance; end-phase work measures
    // its variance against its own schedule, so only its margin moves.
    if (!r.phase && r.bufferDays !== null) {
      r.varianceDays = round2(r.marginDays - r.bufferDays);
    }
    if (r.marginDays < -0.5) r.kind = "late";
    else if (!r.phase && Math.abs(r.varianceDays) <= 0.5) r.kind = "on-plan";
    else r.kind = "behind";
  }

  // Worst first: nothing scheduled, then the smallest margin to its deadline.
  const rank = (r: SpecializationStatus) =>
    r.kind === "unscheduled"
      ? -Infinity
      : r.kind === "done" || r.kind === "no-estimate"
        ? Infinity
        : (r.marginDays ?? -Infinity);
  return rows.sort((a, b) => rank(a) - rank(b));
}

/**
 * When the work left is done, counted by people, and how late that is.
 *
 * The plan's curve turns a shortfall into time at the pace the plan happened
 * to schedule, which can be one person working through a tail of tasks while
 * the rest of the specialization sits free. Counting by people instead: from
 * tomorrow, each person does their share at their own speed, inside their own
 * window, minus their days off, until the work left is done — 3 plan days left
 * over after the deadline with 3 developers is 1 day late, not 3.
 *
 * It is the fastest the work could possibly go (every task split across
 * everyone), so it only ever shortens a reading, never lengthens one. The
 * finish is a real date either side of the deadline: reading "fits" as
 * "finishes on the deadline" would make the projected finish follow whatever
 * deadline is set, and always read as the whole buffer spent.
 *
 * Null when the people never get through it (nobody left after the deadline).
 */
function finishByPeople(
  people: Worker[],
  remaining: number,
  today: string,
  deadline: string,
  calendar: TeamCalendar,
): {
  /** Working days after the deadline; 0 when it fits before. */
  days: number;
  /** Plan days that do not fit before the deadline; 0 when they all do. */
  overflowDays: number;
  finish: string;
  people: number;
  perDay: number;
} | null {
  if (people.length === 0) return null;
  // Who is still there after the deadline, and what a full day of them does.
  const after = people.filter((w) => !w.to || w.to > deadline);
  const split = {
    people: after.length,
    perDay: round2(after.reduce((sum, w) => sum + w.speed, 0)),
  };
  if (remaining <= EPS) {
    return { days: 0, overflowDays: 0, finish: today, ...split };
  }
  // From tomorrow: like the plan's curve, today's share counts as due by the
  // end of today, so a lone person reads exactly as the curve does.
  const start = addDays(fromISO(today), 1);
  // Three years past the deadline (or today) is "never" for a plan.
  const last = toISO(
    addDays(fromISO(today > deadline ? today : deadline), 3 * 366),
  );
  let before = 0;
  let done = 0;
  for (let d = start; toISO(d) <= last; d = addDays(d, 1)) {
    const iso = toISO(d);
    const capacity = capacityOn(people, iso);
    done += capacity;
    if (iso <= deadline) before += capacity;
    if (done >= remaining - EPS) {
      const overflow = Math.max(0, remaining - before);
      return {
        days:
          overflow > EPS
            ? Math.max(0, workdaysBetween(deadline, iso, calendar))
            : 0,
        overflowDays: round2(overflow),
        finish: iso,
        ...split,
      };
    }
  }
  return null;
}

/** One QA task placed in the schedule counted back from the end date. */
export interface EndPhaseItem {
  taskId: ID;
  name: string;
  /** Plan days of work (the estimate). */
  estimateDays: number;
  /** Working days it is given in the schedule: the estimate, stretched by the buffer. */
  days: number;
  start: string;
  end: string;
  /** Finished in Jira. */
  done: boolean;
}

/**
 * Lay tasks out as late as possible, the last one ending on `to`, consuming
 * the daily capacity of `workers` (speed and days off included). Tasks run in
 * project order, so the last task listed is the last one done. Several people
 * share one pool of capacity: at this level of detail, two testers halve the
 * time a task takes rather than taking a task each.
 */
function scheduleBackwards(
  tasks: { id: ID; name: string; estimateDays: number; done: boolean }[],
  workers: Worker[],
  to: string,
  factor: number,
): EndPhaseItem[] {
  const out: EndPhaseItem[] = [];
  let d = fromISO(to);
  let avail = capacityOn(workers, toISO(d));
  let guard = 0;
  const step = () => {
    d = addDays(d, -1);
    avail = capacityOn(workers, toISO(d));
    guard++;
  };
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    let need = t.estimateDays * factor;
    while (avail <= EPS && guard < MAX_WALK_DAYS) step();
    const end = toISO(d);
    while (need > EPS && guard < MAX_WALK_DAYS) {
      if (avail <= EPS) {
        step();
        continue;
      }
      const take = Math.min(avail, need);
      need -= take;
      avail -= take;
    }
    out.unshift({
      taskId: t.id,
      name: t.name,
      estimateDays: t.estimateDays,
      days: round2(t.estimateDays * factor),
      start: toISO(d),
      end,
      done: t.done,
    });
  }
  return out;
}

/** A backward schedule as a plan, so the forward curve helpers read it. */
function asPlan(items: EndPhaseItem[]): Plan {
  return {
    generatedAt: BASELINE_GENERATED_AT,
    unassigned: [],
    assignments: items.map((i) => ({
      taskId: i.taskId,
      taskName: i.name,
      epicId: "",
      epicName: "",
      specialization: "",
      estimateDays: i.estimateDays,
      workDays: i.days,
      memberId: "",
      memberName: "",
      start: i.start,
      end: i.end,
    })),
  };
}

/**
 * Where progress `earned` puts you on a backward schedule, in working days
 * from today: positive = ahead. With nothing done, you are on the schedule
 * until the day before it starts, so the lead is the time left to start.
 */
function scheduleVariance(
  plan: Plan,
  earned: number,
  today: string,
  calendar: TeamCalendar,
): number {
  if (plan.assignments.length === 0) return 0;
  const start = plan.assignments.map((a) => a.start).sort()[0];
  const es =
    earned <= EPS
      ? toISO(addDays(fromISO(start), -1))
      : earnedScheduleDate(plan, earned, start);
  return workdaysBetween(today, es, calendar);
}

/**
 * The end-phase reading for one specialization (QA), measured like
 * development but against a schedule counted back from the end date.
 *
 * Its tasks are laid out as late as possible, the last ending on the end
 * date, twice: once with every task stretched by the project's buffer — the
 * schedule QA works to, which says when it must start — and once without, the
 * very latest it could leave things. Progress is its finished Jira tasks
 * against the buffered schedule, so it reads ahead or behind in days just as
 * development does; falling behind first spends the gap between the two
 * schedules (QA's buffer), and only past the unbuffered one is it late for the
 * end date. Before its first task is due the lead is the time left to start.
 */
function endPhaseRow(
  row: SpecializationStatus,
  tasks: { id: ID; name: string; estimateDays: number; done: boolean }[],
  allWorkers: Worker[],
  calendar: TeamCalendar,
  deadlines: ResolvedDeadlines,
  bufferPct: number,
  today: string,
): SpecializationStatus {
  const to = deadlines.endDate!;
  const workers = allWorkers.filter(
    (w) => w.specialization === row.specialization,
  );
  const remaining = Math.max(0, row.totalDays - row.earnedDays);
  let capacityLeft = 0;
  for (let d = fromISO(today); toISO(d) <= to; d = addDays(d, 1)) {
    capacityLeft += capacityOn(workers, toISO(d));
  }

  if (workers.length === 0) {
    row.kind = "unscheduled";
    return row;
  }

  const factor = 1 + Math.max(0, num(bufferPct)) / 100;
  const buffered = scheduleBackwards(tasks, workers, to, factor);
  const latest = scheduleBackwards(tasks, workers, to, 1);
  const mustStartBy = buffered[0]?.start ?? null;
  const latestStart = latest[0]?.start ?? null;
  const bufferDays =
    mustStartBy && latestStart
      ? Math.max(0, workdaysBetween(mustStartBy, latestStart, calendar))
      : 0;

  row.phase = {
    mustStartBy,
    latestStart,
    to,
    bufferDays,
    capacityDays: round2(capacityLeft),
    remainingDays: round2(remaining),
    overlapsDevelopment: Boolean(
      mustStartBy && deadlines.devEndDate && mustStartBy < deadlines.devEndDate,
    ),
    schedule: buffered,
  };
  row.firstStart = mustStartBy;
  row.unbufferedEnd = to;
  row.bufferDays = bufferDays;

  if (remaining <= EPS) {
    row.kind = "done";
    return row;
  }

  const bufferedPlan = asPlan(buffered);
  row.plannedDays = round2(plannedDoneBy(bufferedPlan, today));
  // Against the buffered schedule: the reading, as for development.
  row.varianceDays = scheduleVariance(
    bufferedPlan,
    row.earnedDays,
    today,
    calendar,
  );
  // Against the unbuffered one: what is left before the end date is at risk.
  const toSpare = scheduleVariance(
    asPlan(latest),
    row.earnedDays,
    today,
    calendar,
  );
  row.marginDays = toSpare;
  row.projectedFinish =
    toSpare < -0.5 ? addWorkdays(to, -toSpare, calendar) : to;

  if (toSpare < -0.5) row.kind = "late";
  else if (row.varianceDays > 0.5) row.kind = "ahead";
  else if (row.varianceDays < -0.5) row.kind = "behind";
  else row.kind = "on-plan";
  return row;
}

/** The part of a status worth keeping forever, as one day's history row. */
export function sampleFromStatus(s: TrackerStatus): TrackerSample {
  return {
    date: s.today,
    plannedDays: s.plannedDays,
    earnedDays: s.earnedDays,
    varianceDays: s.varianceDays,
    bufferUsedDays: s.bufferUsedDays,
    bufferDays: s.bufferDays,
    jiraSpentDays: s.jiraSpentDays,
    jiraRemainingDays: s.jiraRemainingDays,
  };
}

/* ------------------------------- auto-mapping ----------------------------- */

/**
 * Guess `jira epic key -> planner epic id` from the names.
 *
 * Exact match on the normalised name first (trim, lowercase, collapsed
 * whitespace) across every planner epic, then containment either way — "Payments
 * API" matches "Payments". Anything else is left *absent* from the result, which
 * the UI reads as "still to decide"; a wrong guess is worse than no guess, since
 * it silently changes the earned total.
 *
 * Entries already in `existing` are never touched, including an explicit `null`
 * ("deliberately out of plan") — the user's decisions outrank the guess.
 */
export function autoEpicMap(
  project: Project,
  snapshot: JiraSnapshot,
  existing?: Tracker["epicMap"],
): NonNullable<Tracker["epicMap"]> {
  const out: NonNullable<Tracker["epicMap"]> = { ...(existing ?? {}) };
  const epics = project.epics.map((e) => ({
    id: e.id,
    name: normName(e.name),
  }));

  for (const jiraEpic of snapshot.epics ?? []) {
    if (Object.prototype.hasOwnProperty.call(out, jiraEpic.key)) continue;
    const summary = normName(jiraEpic.summary);
    if (!summary) continue;

    const exact = epics.find((e) => e.name !== "" && e.name === summary);
    if (exact) {
      out[jiraEpic.key] = exact.id;
      continue;
    }
    const contained = epics.find(
      (e) =>
        e.name !== "" && (e.name.includes(summary) || summary.includes(e.name)),
    );
    if (contained) out[jiraEpic.key] = contained.id;
  }

  return out;
}

/**
 * Guess `Jira child issue key -> Planner task id` from task names.
 *
 * Exact punctuation-insensitive matches win. A conservative fuzzy pass then
 * accepts containment or strong token overlap only when the winner is clearly
 * better than the runner-up. Planner tasks are claimed once, so two similarly
 * named Jira issues cannot silently count the same planned work twice.
 *
 * An existing entry naming a task that is not in `project` is treated as
 * undecided and guessed again: the tracker's baseline was switched to another
 * project, and a match into the old one would count 0 days forever.
 */
export function autoTaskMap(
  project: Project,
  snapshot: JiraSnapshot,
  existing?: Tracker["taskMap"],
  /** Issues left alone: kept as they are, never matched, and not holding on
   *  to a plan task (see {@link untrackedIssueKeys}). */
  skip?: ReadonlySet<string>,
): NonNullable<Tracker["taskMap"]> {
  const known = new Set<ID>();
  for (const epic of project.epics) {
    for (const task of epic.tasks) known.add(task.id);
  }
  const out: NonNullable<Tracker["taskMap"]> = {};
  for (const [key, target] of Object.entries(existing ?? {})) {
    if (target === null || known.has(target)) out[key] = target;
  }
  const plannerTasks = project.epics.flatMap((epic) =>
    epic.tasks
      .filter((task) => !task.excluded)
      .map((task) => ({
        id: task.id,
        name: normTaskName(task.name),
      })),
  );
  const claimed = new Set<ID>();
  for (const [key, target] of Object.entries(out)) {
    if (target && !skip?.has(key)) claimed.add(target);
  }

  for (const issue of jiraTasks(snapshot)) {
    if (skip?.has(issue.key)) continue;
    if (Object.prototype.hasOwnProperty.call(out, issue.key)) continue;
    const summary = normTaskName(issue.summary);
    if (!summary) continue;

    const available = plannerTasks.filter(
      (task) => task.name !== "" && !claimed.has(task.id),
    );
    const exact = available.filter((task) => task.name === summary);
    if (exact.length === 1) {
      out[issue.key] = exact[0].id;
      claimed.add(exact[0].id);
      continue;
    }

    const ranked = available
      .map((task) => ({ ...task, score: taskNameScore(task.name, summary) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (
      best &&
      best.score >= 2 / 3 &&
      (!runnerUp || best.score - runnerUp.score >= 0.15)
    ) {
      out[issue.key] = best.id;
      claimed.add(best.id);
    }
  }

  return out;
}
