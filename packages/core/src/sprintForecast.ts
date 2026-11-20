import type { ForecastItem, RemainingWork } from "./forecast";
import { addDays, fromISO, isWeekend, toISO } from "./dates";

/**
 * The work left, cut into sprints: which sprint each task finishes in, how
 * many sprints it takes and when the last one ends. Pure, like the rest of
 * core.
 *
 * The forecast does the planning (who does what, in which order, at what
 * pace); this only lays fixed-length sprints over its dates, back to back
 * from the first day. Plan the forecast from the sprint start with
 * `capacity` set to the days each person counts per sprint over the sprint's
 * working days, and the two line up.
 */

/** One sprint, and the work that finishes in it. */
export interface SprintSlot {
  /** 1-based. */
  number: number;
  /** First day (the sprint start, as given). */
  start: string;
  /** Last working day before the next sprint starts. */
  end: string;
  /** The tasks that finish in it. */
  items: ForecastItem[];
  /** Plan days of those tasks. */
  days: number;
}

export interface SprintForecast {
  sprints: SprintSlot[];
  /** When the last task finishes, or null with nothing to do. */
  finish: string | null;
}

/** Working days in a sprint of `weeks` weeks, before anyone's days off. */
export function sprintWorkdays(weeks: number): number {
  return Math.max(1, Math.round(weeks * 5));
}

/**
 * Cut `work` into sprints of `weeks` weeks from `start`: as many as it takes
 * for the last task to finish, at least one.
 */
export function sprintsFor(
  work: RemainingWork,
  start: string,
  weeks: number,
): SprintForecast {
  const length = Math.max(1, Math.round(weeks * 7));
  const first = fromISO(start);
  const finish = work.finish;
  const count = finish
    ? Math.max(
        1,
        Math.floor(
          Math.round((fromISO(finish).getTime() - first.getTime()) / 86400000) /
            length,
        ) + 1,
      )
    : 1;
  const sprints: SprintSlot[] = [];
  for (let i = 0; i < count; i++) {
    const from = addDays(first, i * length);
    let last = addDays(from, length - 1);
    while (isWeekend(last) && last > from) last = addDays(last, -1);
    const startISO = toISO(from);
    const endISO = toISO(last);
    const nextISO = toISO(addDays(from, length));
    const items = work.items.filter(
      (a) => a.end >= startISO && a.end < nextISO,
    );
    sprints.push({
      number: i + 1,
      start: startISO,
      end: endISO,
      items,
      days:
        Math.round(items.reduce((sum, a) => sum + a.estimateDays, 0) * 100) /
        100,
    });
  }
  return { sprints, finish };
}
