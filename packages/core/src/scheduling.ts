import type {
  Assignment,
  ID,
  Plan,
  Project,
  Team,
  TeamInclusion,
  UnassignedTask,
} from "./types";
import { addDays, fromISO, isWeekend, toISO } from "./dates";

/**
 * Pure scheduling engine — no React, no DOM. Ported from the POC.
 *
 * The plan walks tasks in epic/task order, skipping excluded ones. For each
 * task it finds candidates whose specialization matches (case-insensitive,
 * trimmed), simulates each candidate's workday span from their current cursor
 * (skipping weekends + off-days), and assigns whoever finishes soonest —
 * tie-broken by whoever carries the lighter total load so far.
 *
 * The candidate pool is drawn from the teams that participate in the project
 * (speed defaults to 1) plus the project's per-project helpers. A candidate's
 * effective duration for a task is `ceil(estimateDays / speed)`. Helpers are
 * only eligible for a task when the simulated span fits entirely inside their
 * [availableFrom, availableTo] window (a hard constraint), and any of a
 * helper's own off-days (e.g. Christmas holidays) are skipped over just like
 * weekends and team off-days.
 *
 * Which teams participate — and how — comes from `project.teamInclusions`. When
 * that's absent, every team participates fully (the backward-compatible
 * default). Each inclusion may constrain its team two combinable ways:
 *  - **Epic scope** (`epicIds`): that team's members are only candidates for
 *    tasks in those epics. If the inclusion is also `exclusive`, those epics
 *    are *reserved* — only that team's members may work them (other teams and
 *    helpers are locked out); otherwise other teams may still help there.
 *  - **Time period** (`availableFrom`/`availableTo`): the team is treated like a
 *    helper with that availability window.
 *  - **Velocity** (`velocity`): a per-project multiplier layered on top of each
 *    member's own speed (1 = unchanged), so effective duration for a task is
 *    `ceil(estimateDays / (member.speed × velocity))`. This models a team going
 *    faster or slower on this specific project without editing the team.
 *
 * Epic ownership (project.epicAssignments) is a *preference*, not a
 * reservation: a member assigned to an epic is preferred to start that epic's
 * work (they win ties for it), but assignment never blocks them from other
 * work and never blocks other specialists from helping. So an owner is never
 * left idle waiting for their epic, and busy owners can be helped by anyone.
 * A project without assignments plans exactly as it did before.
 *
 * Dependencies (Epic.dependsOn / TaskItem.dependsOn) are hard constraints: a
 * task can't start until every prerequisite task has finished (an epic
 * dependency expands to all of that epic's tasks). Tasks are scheduled in a
 * topological pass — list order is preserved wherever dependencies allow. A
 * task whose prerequisite couldn't be scheduled, or that sits in a dependency
 * cycle, is reported as unassigned with a clear reason. Waiting on a
 * prerequisite can leave a person idle before their next task; a task reached
 * later in the pass that is ready sooner goes into the first such gap it fits
 * in, so one epic's QA never queues behind another epic's.
 *
 * A task someone already holds (`PlanOptions.assignees`, e.g. its Jira
 * assignee) is offered only to that person, so the rest of the plan works
 * around it. Without that option every task is handed out as described here.
 * `PlanOptions.rank` reorders the list before the pass (lower rank first,
 * list order within a rank); without it the list order stands.
 *
 * Everything above describes the default **balanced** mode. Passing
 * `{ mode: "smart" }` (see {@link PlanOptions}) instead runs a worker-driven,
 * days-off-aware dispatch: the freed-est person picks the best-fitting task
 * among the next `lookahead` ready ones, preferring work that finishes before
 * their own next break — so a long task isn't split across someone's vacation
 * when a colleague could take it. It reuses every constraint above (specializa-
 * tion, epic scope/reservation, availability windows, dependencies, ownership)
 * and stays fully deterministic.
 */

/** Trim + lowercase for case-insensitive specialization matching. */
function norm(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Simulate a span of `workDays` working days starting at or after `cursorDate`,
 * skipping weekends and any date in `offDaysSet` (ISO strings). Returns the
 * first working day (start) and the last working day (end), inclusive.
 */
export function simulateSpan(
  cursorDate: Date,
  workDays: number,
  offDaysSet: Set<string>,
): { start: Date; end: Date } {
  const isFree = (d: Date) => !isWeekend(d) && !offDaysSet.has(toISO(d));

  // Advance to the first free day for the start.
  let d = new Date(cursorDate);
  while (!isFree(d)) d = addDays(d, 1);
  const start = new Date(d);

  // Count out the remaining working days, skipping non-free days between them.
  let count = 1;
  let cur = new Date(d);
  const total = Math.max(1, workDays);
  while (count < total) {
    cur = addDays(cur, 1);
    while (!isFree(cur)) cur = addDays(cur, 1);
    count++;
  }
  return { start, end: cur };
}

/**
 * The earliest span of `workDays` for a worker at or after `from` that
 * overlaps none of their `busy` spans.
 *
 * A worker's calendar can have holes: waiting on a prerequisite pushes their
 * next task out and leaves them idle before it. Only moving a cursor forward
 * would strand those days, so a QA task whose development finished weeks ago
 * would queue behind one still waiting on later work, and every QA task would
 * pile up at the end of the plan. Filling the first hole the task fits in
 * keeps each task as early as its own prerequisites allow. Without
 * dependencies there are no holes, and this is just the day after the last
 * booked span.
 */
function earliestFit(
  from: Date,
  workDays: number,
  offDaysSet: Set<string>,
  busy: readonly { start: number; end: number }[],
): { start: Date; end: Date } {
  let at = from;
  for (;;) {
    const span = simulateSpan(at, workDays, offDaysSet);
    const s = span.start.getTime();
    const e = span.end.getTime();
    const clash = busy.find((b) => s <= b.end && e >= b.start);
    if (!clash) return span;
    // Every later try starts after this booking, so each is met at most once.
    at = addDays(new Date(clash.end), 1);
  }
}

/** Mutable per-candidate scheduling state. */
interface Worker {
  id: ID;
  name: string;
  specialization: string;
  speed: number;
  offSet: Set<string>;
  availableTo: Date | null; // hard end of availability; null = no limit
  cursor: Date;
  /** Balanced mode: the first day this worker may work at all. */
  earliest: Date;
  /** Balanced mode: spans already booked, as inclusive [start, end] times. */
  busy: { start: number; end: number }[];
  load: number;
  /** Team this worker belongs to; null for a project helper. */
  teamId: ID | null;
  /** Epics this worker may work; null = any epic. */
  allowedEpics: Set<string> | null;
}

interface Best {
  worker: Worker;
  span: { start: Date; end: Date };
  endTime: number;
  workDays: number;
  isOwner: boolean; // does this candidate own the task's epic?
}

/** A speed <= 0 would mean "never finishes"; clamp to a sane positive value. */
function normalizeSpeed(speed: number | undefined): number {
  const s = Number(speed);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** The latest of a set of dates (ignoring nulls); null if all are null. */
function maxDate(...dates: (Date | null)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (d && (best === null || d.getTime() > best.getTime())) best = d;
  }
  return best;
}

/** Lexicographic "is a < b" over equal-length numeric key tuples. */
function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * How many of `offSet`'s days fall strictly inside (start, end) — the worker's
 * own days off that the task's span had to stretch across. Smart mode prefers
 * tasks that finish before a worker's next break, i.e. where this count is 0.
 */
function offDaysWithin(offSet: Set<string>, start: Date, end: Date): number {
  const s = start.getTime();
  const e = end.getTime();
  let n = 0;
  for (const iso of offSet) {
    const t = fromISO(iso).getTime();
    if (t > s && t < e) n++;
  }
  return n;
}

/** Optional tuning for {@link runPlan}. */
export interface PlanOptions {
  /**
   * - `"balanced"` (default): the original scheduler — tasks are walked in list
   *   order and each is assigned to whoever finishes it soonest.
   * - `"smart"`: worker-driven, days-off-aware dispatch. The freed-est person
   *   picks the best-fitting task among the next `lookahead` ready ones,
   *   preferring tasks that finish before their own next break — so a long task
   *   isn't handed to someone about to take time off when a colleague could take
   *   it instead. Falls back to soonest-finish when nobody has an imminent break.
   */
  mode?: "balanced" | "smart";
  /**
   * Smart mode only. How many of the next ready tasks (in priority order) a
   * freed worker may choose among — the lookahead window. Small = stays close to
   * strict priority order; larger = more freedom to optimize around days off.
   * Clamped to >= 1. Default 5.
   */
  lookahead?: number;
  /**
   * Tasks that already belong to someone: task id -> member (or helper) id.
   * Such a task is offered only to that person, whatever their
   * specialization, epic scope or team reservation — someone has already
   * decided. An id nobody in the pool has is ignored, and the task is handed
   * out as usual. Absent = every task is handed out as usual.
   */
  assignees?: { [taskId: string]: ID };
  /**
   * The order to take tasks in: task id -> rank, lower first. Tasks are
   * walked by rank, and in list order within one rank; dependencies still
   * come first. A task with no rank counts as 0. Absent = list order.
   */
  rank?: { [taskId: string]: number };
}

/**
 * Compute a full plan for a project against the app's teams.
 *
 * @param teams Every team in the app. Which ones participate — and how — is
 *   read from `project.teamInclusions` (absent = all teams participate fully).
 * @param generatedAt ISO datetime stamped on the plan. Defaults to now;
 *   pass a fixed value for deterministic output in tests. The assignments and
 *   unassigned lists are always deterministic for a given project + teams.
 */
export function runPlan(
  project: Project,
  teams: Team[],
  generatedAt: string = new Date().toISOString(),
  options: PlanOptions = {},
): Plan {
  const projectStart = fromISO(project.startDate);
  const memberStarts = project.memberStarts ?? {};

  // Resolve which teams participate. Absent teamInclusions = every team, no
  // constraints. When present, only the listed teams participate.
  const inclusions: TeamInclusion[] =
    project.teamInclusions ?? teams.map((t) => ({ teamId: t.id }));
  const teamById = new Map(teams.map((t) => [t.id, t]));

  // Epics reserved to specific teams (exclusive scope): epicId -> set of teamIds
  // allowed to work it. Any epic in the map is off-limits to everyone else.
  const exclusiveEpicTeams = new Map<string, Set<ID>>();
  for (const inc of inclusions) {
    if (inc.exclusive && inc.epicIds && inc.epicIds.length > 0) {
      for (const epicId of inc.epicIds) {
        const set = exclusiveEpicTeams.get(epicId) ?? new Set<ID>();
        set.add(inc.teamId);
        exclusiveEpicTeams.set(epicId, set);
      }
    }
  }

  // Candidate pool: participating teams' members (with per-inclusion epic scope
  // + availability window) + this project's helpers (unscoped, own window).
  const workers: Worker[] = [];
  for (const inc of inclusions) {
    const team = teamById.get(inc.teamId);
    if (!team) continue; // a stale inclusion for a deleted team is ignored
    const availableFrom = inc.availableFrom ? fromISO(inc.availableFrom) : null;
    const availableTo = inc.availableTo ? fromISO(inc.availableTo) : null;
    const allowedEpics =
      inc.epicIds && inc.epicIds.length > 0 ? new Set(inc.epicIds) : null;
    // Per-project team velocity: a multiplier layered on top of each member's
    // own speed (1 = unchanged). Lets a scenario model, say, the home team at
    // 0.9 and an added team at 0.7 without touching the teams themselves.
    const velocity = normalizeSpeed(inc.velocity);
    for (const m of team.members) {
      // Start no earlier than the project start, this member's per-project
      // start override, or the team's availability window — whichever is latest.
      const override = memberStarts[m.id] ? fromISO(memberStarts[m.id]) : null;
      const start =
        maxDate(projectStart, override, availableFrom) ?? projectStart;
      workers.push({
        id: m.id,
        name: m.name,
        specialization: m.specialization,
        speed: normalizeSpeed(m.speed) * velocity,
        offSet: new Set(team.offDays[m.id] ?? []),
        availableTo,
        cursor: new Date(start),
        earliest: new Date(start),
        busy: [],
        load: 0,
        teamId: team.id,
        allowedEpics,
      });
    }
  }
  for (const h of project.helpers ?? []) {
    const from = fromISO(h.availableFrom);
    // A helper can't start before their availability begins.
    const cursor =
      from > projectStart ? new Date(from) : new Date(projectStart);
    workers.push({
      id: h.id,
      name: h.name,
      specialization: h.specialization,
      speed: normalizeSpeed(h.speed),
      offSet: new Set<string>(h.offDays ?? []),
      availableTo: fromISO(h.availableTo),
      cursor,
      earliest: new Date(cursor),
      busy: [],
      load: 0,
      teamId: null,
      allowedEpics: null,
    });
  }

  // A project-wide safety buffer padding every estimate before scheduling.
  // `buffer` is a percentage (20 -> ×1.2); absent/invalid = no padding.
  const bufferPct = Number(project.buffer);
  const bufferFactor =
    Number.isFinite(bufferPct) && bufferPct > 0 ? 1 + bufferPct / 100 : 1;

  // Flatten to a work-list in epic/task order, skipping excluded tasks. The
  // buffer is baked into estimateDays here so every downstream consumer — both
  // scheduling modes and the recorded assignment — sees the padded estimate.
  const worklist = project.epics.flatMap((epic) =>
    epic.tasks
      .filter((t) => !t.excluded)
      .map((t) => ({
        ...t,
        estimateDays: (Number(t.estimateDays) || 0) * bufferFactor,
        epicId: epic.id,
        epicName: epic.name,
      })),
  );
  // An explicit order, when given (see PlanOptions.rank). The sort is stable,
  // so list order still decides within one rank.
  const rank = options.rank;
  if (rank) worklist.sort((a, b) => (rank[a.id] ?? 0) - (rank[b.id] ?? 0));

  // Epic ownership as a *preference* only (see the module doc): the members
  // assigned to an epic are the ones who should start it, but they're never
  // reserved and never block anyone else. Everyone who matches the
  // specialization stays a candidate for every task, so no one is left idle.
  const epicAssignments = project.epicAssignments ?? {};

  // Resolve each task's prerequisite task ids: its own `dependsOn` plus every
  // schedulable task in any epic its epic `dependsOn`. Only ids that point at a
  // real, non-excluded task count (a dependency on a skipped/deleted task is
  // simply ignored rather than blocking forever).
  const worklistIds = new Set(worklist.map((t) => t.id));
  const tasksByEpic = new Map<ID, string[]>();
  for (const t of worklist) {
    const arr = tasksByEpic.get(t.epicId);
    if (arr) arr.push(t.id);
    else tasksByEpic.set(t.epicId, [t.id]);
  }
  const epicById = new Map(project.epics.map((e) => [e.id, e]));
  const prereqs = new Map<string, string[]>();
  for (const t of worklist) {
    const out = new Set<string>();
    for (const d of t.dependsOn ?? []) {
      if (d !== t.id && worklistIds.has(d)) out.add(d);
    }
    for (const depEpicId of epicById.get(t.epicId)?.dependsOn ?? []) {
      for (const tid of tasksByEpic.get(depEpicId) ?? []) {
        if (tid !== t.id) out.add(tid);
      }
    }
    prereqs.set(t.id, [...out]);
  }

  const assignments: Assignment[] = [];
  const unassigned: UnassignedTask[] = [];
  const ends = new Map<string, Date>(); // task id -> end date (assigned only)
  const processed = new Set<string>(); // task id -> handled (assigned or not)

  // Running total of the slack captured by rounding fractional effective
  // durations up to whole workdays. Each assignment adds
  // `workDays - estimateDays / speed` (see Plan.roundingBufferDays).
  let roundingBufferDays = 0;
  const roundingGain = (
    estimateDays: number,
    speed: number,
    workDays: number,
  ) => workDays - (Number(estimateDays) || 0) / speed;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // A task someone already holds goes to them alone (see PlanOptions).
  const assignees = options.assignees ?? {};
  const assignedWorker = (taskId: ID): Worker | undefined => {
    const id = assignees[taskId];
    return id ? workers.find((w) => w.id === id) : undefined;
  };

  // ---- Shared candidate/evaluation helpers (used by smart mode) -------------

  /** Workers who match a task's specialization, and the subset actually allowed
   *  to work it (epic scope + exclusive reservation). */
  const candidatesFor = (task: {
    id: ID;
    epicId: string;
    specialization: string;
  }) => {
    const pinned = assignedWorker(task.id);
    if (pinned) {
      return { specMatches: [pinned], candidates: [pinned], reservedTo: null };
    }
    const reservedTo = exclusiveEpicTeams.get(task.epicId) ?? null;
    const spec = norm(task.specialization);
    const specMatches = workers.filter(
      (w) => spec !== "" && norm(w.specialization) === spec,
    );
    const candidates = specMatches.filter(
      (w) =>
        (w.allowedEpics === null || w.allowedEpics.has(task.epicId)) &&
        (reservedTo === null ||
          (w.teamId !== null && reservedTo.has(w.teamId))),
    );
    return { specMatches, candidates, reservedTo };
  };

  /** Why a task with no eligible candidate can't be scheduled (mirrors the
   *  balanced pass's wording). */
  const noCandidatesReason = (
    task: { specialization: string },
    specMatches: Worker[],
    reservedTo: Set<ID> | null,
  ): string => {
    if (specMatches.length === 0) {
      return task.specialization.trim()
        ? `No team member with specialization "${task.specialization}"`
        : "Task has no specialization set";
    }
    if (reservedTo !== null) {
      return `Epic reserved to another team — no eligible "${task.specialization}" specialist on it`;
    }
    return `No "${task.specialization}" specialist is scoped to this epic`;
  };

  /** Simulate `w` working `task` starting at/after `readyDate`; null if the span
   *  can't fit inside `w`'s availability window. */
  const evaluate = (
    w: Worker,
    task: { estimateDays: number },
    readyDate: Date | null,
  ) => {
    const workDays = Math.max(
      1,
      Math.ceil((Number(task.estimateDays) || 0) / w.speed),
    );
    const from =
      readyDate !== null && readyDate.getTime() > w.cursor.getTime()
        ? readyDate
        : w.cursor;
    const span = simulateSpan(from, workDays, w.offSet);
    if (
      w.availableTo !== null &&
      span.end.getTime() > w.availableTo.getTime()
    ) {
      return null;
    }
    return { span, endTime: span.end.getTime(), workDays };
  };

  /** Earliest a task may start given its prerequisites' end dates (null = only
   *  the worker's own cursor governs). Assumes every prereq has already ended. */
  const readyDateFor = (taskId: string): Date | null => {
    let readyDate: Date | null = null;
    for (const d of prereqs.get(taskId) ?? []) {
      const end = ends.get(d);
      if (end && (readyDate === null || end > readyDate)) readyDate = end;
    }
    return readyDate ? addDays(readyDate, 1) : null;
  };

  // ---- Smart mode: worker-driven, days-off-aware dispatch ------------------
  if ((options.mode ?? "balanced") === "smart") {
    const K = Math.max(1, Math.floor(options.lookahead ?? 5));
    const remaining = [...worklist];

    type Eval = {
      worker: Worker;
      span: { start: Date; end: Date };
      endTime: number;
      workDays: number;
    };

    while (remaining.length > 0) {
      // Ready = every prerequisite has been handled (assigned or given up on).
      const ready = remaining.filter((t) =>
        (prereqs.get(t.id) ?? []).every((d) => processed.has(d)),
      );
      if (ready.length === 0) break; // the remainder sits in a dependency cycle

      // A ready task whose prerequisite failed to schedule is itself blocked.
      const blocked = ready.filter((t) =>
        (prereqs.get(t.id) ?? []).some((d) => !ends.has(d)),
      );
      if (blocked.length > 0) {
        for (const t of blocked) {
          unassigned.push({
            ...t,
            reason: "Blocked: a prerequisite task couldn't be scheduled",
          });
          processed.add(t.id);
          remaining.splice(remaining.indexOf(t), 1);
        }
        continue;
      }

      // Split the schedulable tasks (priority order) into "live" (someone can
      // take it) and "dead" (no one ever can — record why).
      const live: { task: (typeof ready)[number]; evals: Map<ID, Eval> }[] = [];
      const dead: { task: (typeof ready)[number]; reason: string }[] = [];
      for (const task of ready) {
        const { specMatches, candidates, reservedTo } = candidatesFor(task);
        if (candidates.length === 0) {
          dead.push({
            task,
            reason: noCandidatesReason(task, specMatches, reservedTo),
          });
          continue;
        }
        const rd = readyDateFor(task.id);
        const evals = new Map<ID, Eval>();
        for (const w of candidates) {
          const ev = evaluate(w, task, rd);
          if (ev) evals.set(w.id, { worker: w, ...ev });
        }
        if (evals.size === 0) {
          dead.push({
            task,
            reason: `No "${task.specialization}" specialist is available within their help window`,
          });
          continue;
        }
        live.push({ task, evals });
      }

      // Nothing schedulable can be placed. A worker's fit only worsens as their
      // cursor advances, so these are permanently unassignable — report + drop.
      if (live.length === 0) {
        for (const { task, reason } of dead) {
          unassigned.push({ ...task, reason });
          processed.add(task.id);
          remaining.splice(remaining.indexOf(task), 1);
        }
        continue;
      }

      // The next off-day at or after a worker's cursor (their upcoming break),
      // as a timestamp; Infinity if they have none coming up.
      const nextBreak = (w: Worker): number => {
        const c = w.cursor.getTime();
        let soonest = Infinity;
        for (const iso of w.offSet) {
          const t = fromISO(iso).getTime();
          if (t >= c && t < soonest) soonest = t;
        }
        return soonest;
      };

      // Worker-driven: pick who chooses next. Earliest cursor first; on a tie the
      // most-constrained worker — the one whose own break is soonest — chooses
      // first, so they grab a task that fits before it and leave the longer work
      // for colleagues who'll be present. Then lighter load, then id.
      const pool = new Map<ID, Worker>();
      for (const l of live)
        for (const { worker } of l.evals.values()) pool.set(worker.id, worker);
      let chosen: Worker | null = null;
      let chosenBreak = Infinity;
      for (const w of pool.values()) {
        const wb = nextBreak(w);
        if (
          chosen === null ||
          w.cursor.getTime() < chosen.cursor.getTime() ||
          (w.cursor.getTime() === chosen.cursor.getTime() &&
            wb < chosenBreak) ||
          (w.cursor.getTime() === chosen.cursor.getTime() &&
            wb === chosenBreak &&
            w.load < chosen.load) ||
          (w.cursor.getTime() === chosen.cursor.getTime() &&
            wb === chosenBreak &&
            w.load === chosen.load &&
            w.id < chosen.id)
        ) {
          chosen = w;
          chosenBreak = wb;
        }
      }
      const worker = chosen!;

      // The worker's lookahead window: the first K live tasks (priority order)
      // this worker can do.
      const windowTasks = live
        .filter((l) => l.evals.has(worker.id))
        .slice(0, K);

      // Pick the worker's task. Prefer one that finishes before the worker's own
      // next break — but only let a break demote a task when another worker could
      // take it instead (otherwise this worker is the only option and should just
      // do it). Then epic-owner preference, then priority order, then soonest
      // finish.
      let pick: { l: (typeof live)[number] } | null = null;
      let pickKey: number[] | null = null;
      for (let idx = 0; idx < windowTasks.length; idx++) {
        const l = windowTasks[idx];
        const ev = l.evals.get(worker.id)!;
        const straddles =
          offDaysWithin(worker.offSet, ev.span.start, ev.span.end) > 0;
        const otherCanTake = [...l.evals.keys()].some((id) => id !== worker.id);
        const penalize = straddles && otherCanTake ? 1 : 0;
        const isOwner = (epicAssignments[l.task.epicId] ?? []).includes(
          worker.id,
        )
          ? 0
          : 1;
        const key = [penalize, isOwner, idx, ev.endTime];
        if (pickKey === null || lexLess(key, pickKey)) {
          pick = { l };
          pickKey = key;
        }
      }

      const { task } = pick!.l;
      const chooserEval = pick!.l.evals.get(worker.id)!;
      // Who actually does it. If the chooser's pick fits cleanly before their own
      // break, keep it with them (that's the point — it frees colleagues for the
      // long work). Otherwise the chooser is doing this task "late": either it
      // straddles their break, or a break/dependency pushed its start out so it
      // only begins at/after their next break. In that case the chooser's
      // earliest-cursor lead is illusory (they can't actually touch the task
      // until they're back), so hand it to whoever finishes it soonest. This
      // keeps a task with dependents off a soon-to-be-away worker when a present
      // colleague could finish it — and unblock the dependents — far earlier,
      // instead of stranding the whole chain across the holiday.
      let assignee = chooserEval;
      const chooserStraddles =
        offDaysWithin(
          worker.offSet,
          chooserEval.span.start,
          chooserEval.span.end,
        ) > 0;
      const chooserDoesLate =
        chooserStraddles ||
        chooserEval.span.start.getTime() >= nextBreak(worker);
      if (chooserDoesLate) {
        for (const cand of pick!.l.evals.values()) {
          if (cand.endTime < assignee.endTime) assignee = cand;
        }
      }
      const actual = assignee.worker;

      assignments.push({
        taskId: task.id,
        taskName: task.name,
        epicId: task.epicId,
        epicName: task.epicName,
        specialization: task.specialization,
        estimateDays: task.estimateDays,
        workDays: assignee.workDays,
        memberId: actual.id,
        memberName: actual.name,
        start: toISO(assignee.span.start),
        end: toISO(assignee.span.end),
      });
      roundingBufferDays += roundingGain(
        task.estimateDays,
        actual.speed,
        assignee.workDays,
      );
      actual.cursor = addDays(assignee.span.end, 1);
      actual.load += assignee.workDays;
      ends.set(task.id, assignee.span.end);
      processed.add(task.id);
      remaining.splice(remaining.indexOf(task), 1);
    }

    for (const task of remaining) {
      unassigned.push({ ...task, reason: "Blocked: circular dependency" });
    }
    return {
      generatedAt,
      assignments,
      unassigned,
      roundingBufferDays: round2(roundingBufferDays),
    };
  }

  // Topological pass: repeatedly schedule every remaining task whose
  // prerequisites are all handled, in list order, until nothing more can move.
  const remaining = [...worklist];
  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const task = remaining[i];
      const deps = prereqs.get(task.id) ?? [];
      if (!deps.every((d) => processed.has(d))) continue; // not ready yet

      remaining.splice(i, 1);
      i--;
      progressed = true;
      processed.add(task.id);

      // A prerequisite that itself failed to schedule blocks this task too.
      if (deps.some((d) => !ends.has(d))) {
        unassigned.push({
          ...task,
          reason: "Blocked: a prerequisite task couldn't be scheduled",
        });
        continue;
      }

      // Earliest this task may start: the day after its latest prerequisite
      // ends (null = unconstrained, so the worker's own cursor governs).
      let readyDate: Date | null = null;
      for (const d of deps) {
        const end = ends.get(d)!;
        if (readyDate === null || end > readyDate) readyDate = end;
      }
      if (readyDate) readyDate = addDays(readyDate, 1);

      // An exclusively-reserved epic may only be worked by the teams that
      // claimed it; everyone else (other teams + helpers) is locked out.
      const reservedTo = exclusiveEpicTeams.get(task.epicId) ?? null;

      const spec = norm(task.specialization);
      const specMatches = workers.filter(
        (w) => spec !== "" && norm(w.specialization) === spec,
      );
      const pinned = assignedWorker(task.id);
      const candidates = pinned
        ? [pinned]
        : specMatches.filter(
            (w) =>
              (w.allowedEpics === null || w.allowedEpics.has(task.epicId)) &&
              (reservedTo === null ||
                (w.teamId !== null && reservedTo.has(w.teamId))),
          );
      if (candidates.length === 0) {
        // Distinguish "no such specialist at all" from "the right specialist
        // exists but isn't allowed on this epic" (team scope / reservation).
        let reason: string;
        if (specMatches.length === 0) {
          reason = task.specialization.trim()
            ? `No team member with specialization "${task.specialization}"`
            : "Task has no specialization set";
        } else if (reservedTo !== null) {
          reason = `Epic reserved to another team — no eligible "${task.specialization}" specialist on it`;
        } else {
          reason = `No "${task.specialization}" specialist is scoped to this epic`;
        }
        unassigned.push({ ...task, reason });
        continue;
      }

      // Who is assigned to (owns) this task's epic.
      const owners = new Set(epicAssignments[task.epicId] ?? []);

      let best: Best | null = null;
      let anyEligible = false;
      for (const w of candidates) {
        // Effective duration scales with this candidate's speed. A person can't
        // split a day across two tasks, so round up to whole workdays.
        const workDays = Math.max(
          1,
          Math.ceil((Number(task.estimateDays) || 0) / w.speed),
        );
        // Start no earlier than the ready date or the worker's first day, in
        // the first free stretch of their calendar that fits the whole task.
        const from =
          readyDate !== null && readyDate.getTime() > w.earliest.getTime()
            ? readyDate
            : w.earliest;
        const span = earliestFit(from, workDays, w.offSet, w.busy);
        // Hard availability window: the whole span must fit before availableTo.
        if (
          w.availableTo !== null &&
          span.end.getTime() > w.availableTo.getTime()
        ) {
          continue;
        }
        anyEligible = true;
        const endTime = span.end.getTime();
        const isOwner = owners.has(w.id);
        // Pick the soonest finisher; on a tie prefer the epic's owner (so the
        // assigned dev starts their epic); on a further tie, the lighter load.
        const better =
          best === null ||
          endTime < best.endTime ||
          (endTime === best.endTime && isOwner && !best.isOwner) ||
          (endTime === best.endTime &&
            isOwner === best.isOwner &&
            w.load < best.worker.load);
        if (better) {
          best = { worker: w, span, endTime, workDays, isOwner };
        }
      }

      if (!best) {
        // Candidates matched the specialization but none could fit the task
        // inside their availability window.
        unassigned.push({
          ...task,
          reason: anyEligible
            ? `No specialist available for "${task.specialization}"`
            : `No "${task.specialization}" specialist is available within their help window`,
        });
        continue;
      }

      assignments.push({
        taskId: task.id,
        taskName: task.name,
        epicId: task.epicId,
        epicName: task.epicName,
        specialization: task.specialization,
        estimateDays: task.estimateDays,
        workDays: best.workDays,
        memberId: best.worker.id,
        memberName: best.worker.name,
        start: toISO(best.span.start),
        end: toISO(best.span.end),
      });
      roundingBufferDays += roundingGain(
        task.estimateDays,
        best.worker.speed,
        best.workDays,
      );
      const after = addDays(best.span.end, 1);
      if (after > best.worker.cursor) best.worker.cursor = after;
      best.worker.busy.push({
        start: best.span.start.getTime(),
        end: best.span.end.getTime(),
      });
      best.worker.load += best.workDays;
      ends.set(task.id, best.span.end);
    }
  }

  // Anything still stuck is in (or waiting on) a dependency cycle.
  for (const task of remaining) {
    unassigned.push({ ...task, reason: "Blocked: circular dependency" });
  }

  return {
    generatedAt,
    assignments,
    unassigned,
    roundingBufferDays: round2(roundingBufferDays),
  };
}
