import type {
  Assignment,
  Epic,
  ID,
  JiraEpic,
  JiraIssue,
  JiraSnapshot,
  Project,
  SprintDraft,
  SprintDraftItem,
  Team,
} from "./types";
import { addDays, fromISO, isWeekend, toISO } from "./dates";
import { simulateSpan } from "./scheduling";
import { addWorkdays, workdaysBetween } from "./tracking";

/**
 * Pure sprint-draft math (§8) — no React, no DOM, and nothing here reads the
 * clock: `today` arrives as a parameter, so the same draft always lays out the
 * same way.
 *
 * **Why the sprint is scheduled from the sprint start, not from the plan.** The
 * plan answers "when will the whole initiative land if we start on day one and
 * nothing moves". By the time anyone lays out a sprint, several of those things
 * have moved: work finished early, a story grew, someone joined, half an epic
 * turned out to be scope nobody planned. Anchoring a sprint on the plan's dates
 * would therefore re-plan the past — the first row would start on whatever date
 * the plan had reserved for that task months ago, which is not a date anybody
 * can work on. So a draft is anchored on the sprint window the user picked and
 * on today's roster, and the plan is only a *background* comparison (JT12 draws
 * it as faint bars). A sprint is a commitment about the next two weeks; the
 * plan is a forecast about the next two quarters, and they must be allowed to
 * disagree visibly rather than one silently overwriting the other.
 *
 * **Why it still calls the scheduler's `simulateSpan`.** Everything else about
 * a span — weekends, off-days, `ceil(estimateDays / speed)`, team velocity — is
 * exactly what the scheduler does, and a second implementation would drift. A
 * draft row and the same task in the plan therefore block out the same number
 * of working days, and the mini Gantt can share `personRows()` with every other
 * timeline in the app.
 */

/** Jira's default working day when a tracker doesn't override it. */
const DEFAULT_HOURS_PER_DAY = 8;

/** Shared empty set for workers with no off-days. Never mutated. */
const NO_OFF_DAYS: Set<string> = new Set();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function num(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** `n` when it is a finite positive number, else `fallback`. */
function positive(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* -------------------------------- workers --------------------------------- */

/**
 * One person a draft row can be assigned to, flattened from the teams and the
 * baseline project's helpers.
 *
 * `speed` is already the *effective* speed for this project — the member's own
 * speed times their team's per-project velocity — so callers never have to
 * remember the multiplication. `specialization` is carried because the mini
 * Gantt colours bars by it, and the draft has to match the colours the plan
 * uses for the same person.
 */
export interface DraftWorker {
  id: ID;
  name: string;
  specialization: string;
  /** member.speed × the baseline project's velocity for their team. */
  speed: number;
  /** ISO dates this person is off, skipped like weekends. */
  offDays: Set<string>;
  /** `null` for a project helper, who belongs to no team. */
  teamId: ID | null;
}

/**
 * Every possible assignee, keyed by member id.
 *
 * Every member of every team is included, not just the members of teams the
 * project includes: a sprint often pulls in a hand from outside the plan's
 * roster, and refusing to let the user assign them would just push the work
 * off the board. A member whose team the project doesn't list simply gets
 * velocity 1 — there is no per-project velocity to apply.
 *
 * The baseline project's helpers are workers too, with their own speed and
 * off-days and no team. A project's `helpers` win over a team member of the
 * same id, which cannot happen while member ids stay globally unique.
 */
export function resolveWorkers(
  teams: Team[],
  project: Project | undefined,
): Map<ID, DraftWorker> {
  const velocityOf = new Map<ID, number>();
  for (const inc of project?.teamInclusions ?? []) {
    velocityOf.set(inc.teamId, positive(inc.velocity, 1));
  }
  const workers = new Map<ID, DraftWorker>();
  for (const team of teams ?? []) {
    const velocity = velocityOf.get(team.id) ?? 1;
    for (const m of team.members) {
      workers.set(m.id, {
        id: m.id,
        name: m.name,
        specialization: m.specialization,
        speed: positive(m.speed, 1) * velocity,
        offDays: new Set(team.offDays?.[m.id] ?? []),
        teamId: team.id,
      });
    }
  }
  for (const h of project?.helpers ?? []) {
    workers.set(h.id, {
      id: h.id,
      name: h.name,
      specialization: h.specialization,
      speed: positive(h.speed, 1),
      offDays: new Set(h.offDays ?? []),
      teamId: null,
    });
  }
  return workers;
}

/* --------------------------------- spans ---------------------------------- */

/** The working-day span one draft row blocks out. */
export interface DraftSpan {
  /** First working day — `item.start` pushed forward off a weekend/off-day. */
  start: string;
  /** Last working day, inclusive. This is the row's due date. */
  end: string;
  /** Whole working days blocked out: `ceil(estimateDays / speed)`, min 1. */
  workDays: number;
}

/**
 * The span for one row, via the scheduler's own `simulateSpan`, so a draft due
 * date and a plan due date are computed by the same code.
 *
 * With no worker resolved (nobody assigned yet, or an id that no longer exists)
 * the row is measured at speed 1 with no off-days, which is the most optimistic
 * reading — the UI flags it grey rather than pretending it is scheduled.
 *
 * `item.start` is expected to be a "YYYY-MM-DD" date; {@link draftSpans} falls
 * back to the sprint start for anything else.
 */
export function draftItemSpan(
  item: SprintDraftItem,
  worker: DraftWorker | undefined,
): DraftSpan {
  const speed = worker ? positive(worker.speed, 1) : 1;
  const offDays = worker?.offDays ?? NO_OFF_DAYS;
  const workDays = Math.max(1, Math.ceil(num(item.estimateDays) / speed));
  const span = simulateSpan(fromISO(item.start), workDays, offDays);
  return { start: toISO(span.start), end: toISO(span.end), workDays };
}

/** Every row's span, keyed by `issueKey` (which is a row's identity). */
export function draftSpans(
  draft: SprintDraft,
  workers: Map<ID, DraftWorker>,
): Map<string, DraftSpan> {
  const spans = new Map<string, DraftSpan>();
  for (const item of draft.items) {
    const start = ISO_DATE.test(item.start) ? item.start : draft.start;
    const worker = item.memberId ? workers.get(item.memberId) : undefined;
    spans.set(item.issueKey, draftItemSpan({ ...item, start }, worker));
  }
  return spans;
}

/* ------------------------------- auto-stack -------------------------------- */

/**
 * Chain each person's rows back-to-back from the sprint start, in list order.
 *
 * The rule, spelled out because "manual edits are kept" needs a definition and
 * nothing records *that* an edit happened:
 *
 *  - A person's **first** row keeps its start when that start is later than the
 *    sprint start — the only reason a row sits mid-sprint is that someone
 *    dragged it there (say, this person is finishing last sprint's work until
 *    Wednesday). A start at or before the sprint start is pulled to the sprint
 *    start, since a sprint cannot begin before it begins.
 *  - Every **later** row starts the working day after the previous row's due
 *    date, so a person's own edits downstream of the first row are the ones
 *    auto-stack is there to throw away.
 *  - **Unassigned** rows are left exactly where they are. They belong to no
 *    person, so there is no chain to put them in.
 *
 * Returns a new draft; rows whose start doesn't change are returned by
 * reference.
 */
export function autoStack(
  draft: SprintDraft,
  workers: Map<ID, DraftWorker>,
): SprintDraft {
  /** Next free start per person, once they have had a row. */
  const cursor = new Map<ID, string>();
  const items = draft.items.map((item) => {
    const memberId = item.memberId;
    if (!memberId) return item;
    const previous = cursor.get(memberId);
    const start =
      previous ??
      (ISO_DATE.test(item.start) && item.start > draft.start
        ? item.start
        : draft.start);
    const stacked = start === item.start ? item : { ...item, start };
    const span = draftItemSpan(stacked, workers.get(memberId));
    cursor.set(memberId, addWorkdays(span.end, 1));
    return stacked;
  });
  return { ...draft, items };
}

/* --------------------------------- flags ---------------------------------- */

/** What the UI paints orange, red and grey. */
export interface DraftFlags {
  /** Keyed by `issueKey`. */
  perItem: Map<string, { overflowsSprint: boolean; unassigned: boolean }>;
  /** Keyed by member id, for every person who has at least one row. */
  perMember: Map<
    ID,
    { plannedDays: number; capacityDays: number; overBy: number }
  >;
}

/** Working days in the inclusive window `[from, to]`. */
function workingDaysInclusive(from: string, to: string): number {
  if (to < from) return 0;
  const first = isWeekend(fromISO(from)) ? 0 : 1;
  return first + Math.max(0, workdaysBetween(from, to));
}

/** Off-days that actually cost capacity: weekdays inside the window. */
function offDaysInWindow(
  offDays: Set<string>,
  from: string,
  to: string,
): number {
  let n = 0;
  for (const day of offDays) {
    if (day >= from && day <= to && !isWeekend(fromISO(day))) n++;
  }
  return n;
}

/**
 * Per-row and per-person flags.
 *
 * `capacityDays` is the working days in the sprint window minus that person's
 * own off-days inside it, and `plannedDays` is the sum of their rows'
 * `workDays` — the days actually blocked out, not the raw estimates, so a
 * half-speed person's 2-day story correctly costs them 4 days of capacity.
 */
export function draftFlags(
  draft: SprintDraft,
  spans: Map<string, DraftSpan>,
  workers: Map<ID, DraftWorker>,
): DraftFlags {
  const perItem = new Map<
    string,
    { overflowsSprint: boolean; unassigned: boolean }
  >();
  const planned = new Map<ID, number>();
  for (const item of draft.items) {
    const span = spans.get(item.issueKey);
    const worker = item.memberId ? workers.get(item.memberId) : undefined;
    perItem.set(item.issueKey, {
      overflowsSprint: span ? span.end > draft.end : false,
      unassigned: !worker,
    });
    if (item.memberId && span) {
      planned.set(
        item.memberId,
        (planned.get(item.memberId) ?? 0) + span.workDays,
      );
    }
  }
  const windowDays = workingDaysInclusive(draft.start, draft.end);
  const perMember = new Map<
    ID,
    { plannedDays: number; capacityDays: number; overBy: number }
  >();
  for (const [memberId, plannedDays] of planned) {
    const offDays = workers.get(memberId)?.offDays ?? NO_OFF_DAYS;
    const capacityDays = Math.max(
      0,
      windowDays - offDaysInWindow(offDays, draft.start, draft.end),
    );
    perMember.set(memberId, {
      plannedDays,
      capacityDays,
      overBy: Math.max(0, plannedDays - capacityDays),
    });
  }
  return { perItem, perMember };
}

/* ------------------------------- estimates -------------------------------- */

/**
 * The estimate a freshly-picked row starts with, in Planner days.
 *
 * In order: Jira's remaining estimate, Jira's original estimate, the mean
 * non-excluded task estimate of the planner epic this issue's epic maps to, and
 * finally 1 day — an estimate nobody has ever given is still a day of someone's
 * week, and 0 would silently plan for free.
 *
 * Each candidate is rounded to one decimal *before* the "> 0" test: an issue
 * with 15 minutes left on it rounds to 0.0 days, which is not an estimate, so
 * the next fallback takes over rather than the row reading as free work.
 */
export function defaultEstimateDays(
  issue: JiraIssue,
  plannerEpic: Epic | undefined,
  hoursPerDay: number,
): number {
  const secPerDay = positive(hoursPerDay, DEFAULT_HOURS_PER_DAY) * 3600;
  const remaining = round1(
    Math.max(0, num(issue?.remainingEstimateSec)) / secPerDay,
  );
  if (remaining > 0) return remaining;
  const original = round1(
    Math.max(0, num(issue?.originalEstimateSec)) / secPerDay,
  );
  if (original > 0) return original;
  const tasks = (plannerEpic?.tasks ?? []).filter((t) => !t.excluded);
  if (tasks.length > 0) {
    const total = tasks.reduce((sum, t) => sum + num(t.estimateDays), 0);
    const mean = round1(total / tasks.length);
    if (mean > 0) return mean;
  }
  return 1;
}

/* ----------------------------- the mini Gantt ------------------------------ */

interface IndexedIssue {
  issue: JiraIssue;
  epic: JiraEpic | undefined;
}

/** Every issue in a snapshot by key, with the epic it hangs under. */
function indexIssues(
  snapshot: JiraSnapshot | undefined,
): Map<string, IndexedIssue> {
  const index = new Map<string, IndexedIssue>();
  for (const epic of snapshot?.epics ?? []) {
    index.set(epic.key, { issue: epic, epic });
    for (const child of epic.children ?? []) {
      index.set(child.key, { issue: child, epic });
    }
  }
  return index;
}

/**
 * Synthetic assignments for the draft, so the mini Gantt can be
 * `personRows()` over the same layout model every other timeline uses.
 *
 * Jira names stand in for planner names — `taskName` is the issue summary and
 * `epicName` the summary of its Jira epic — while `specialization` comes from
 * the *worker*, so a person's draft bars are the colour their plan bars are.
 *
 * **Unassigned rows are omitted.** `personRows()` builds one lane per assignee;
 * a row with nobody on it has no lane to be drawn in, and inventing one would
 * put a fake person in the chart. The draft table is where those rows are shown
 * (flagged grey by {@link draftFlags}). A row whose issue key isn't in the
 * snapshot is still drawn, falling back to the key as its name — the snapshot
 * may simply be older than the draft.
 */
export function draftAssignments(
  draft: SprintDraft,
  spans: Map<string, DraftSpan>,
  snapshot: JiraSnapshot,
  workers: Map<ID, DraftWorker>,
): Assignment[] {
  const index = indexIssues(snapshot);
  const assignments: Assignment[] = [];
  for (const item of draft.items) {
    if (!item.memberId) continue;
    const worker = workers.get(item.memberId);
    const span = spans.get(item.issueKey);
    if (!worker || !span) continue;
    const found = index.get(item.issueKey);
    assignments.push({
      taskId: item.issueKey,
      taskName: found?.issue.summary || item.issueKey,
      epicId: found?.epic?.key ?? "",
      epicName: found?.epic?.summary ?? "",
      specialization: worker.specialization,
      estimateDays: num(item.estimateDays),
      workDays: span.workDays,
      memberId: worker.id,
      memberName: worker.name,
      start: span.start,
      end: span.end,
    });
  }
  return assignments;
}

/* -------------------------------- the window ------------------------------- */

/**
 * The window a brand-new draft opens with: the next Monday, running two working
 * weeks (`start + 11` days, which is always the second Friday — 10 working
 * days).
 *
 * "Next Monday" is the first Monday strictly after `todayISO`, so planning on a
 * Monday lays out the *following* week rather than the one already underway —
 * a sprint you are half-way through is not a sprint you are drafting.
 */
export function defaultSprintWindow(todayISO: string): {
  start: string;
  end: string;
} {
  let d = addDays(fromISO(todayISO), 1);
  while (d.getDay() !== 1) d = addDays(d, 1);
  return { start: toISO(d), end: toISO(addDays(d, 11)) };
}
