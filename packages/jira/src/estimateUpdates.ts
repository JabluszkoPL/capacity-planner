/**
 * Baseline tasks whose estimate in Jira no longer matches the plan.
 *
 * A refresh never touches the baseline project: it is the promise the tracker
 * measures against, and quietly rewriting it would hide exactly the drift the
 * tracker exists to show. But an estimate is sometimes only *filled in* in
 * Jira after the plan was made (an imported task with no estimate starts as a
 * skipped 0-day task), and then the baseline is simply wrong. So this lists
 * the differences and the user picks which ones to copy across.
 *
 * Pure: no `fetch`, no clock, no state. Only mapped issues count, and several
 * Jira issues mapped onto one Planner task are summed, the same way the
 * tracker splits that task's days between them.
 */

import {
  jiraTasks,
  type ID,
  type JiraSnapshot,
  type Project,
  type Tracker,
} from "@planner/core";
import { estimateOf } from "./importProject";

export interface EstimateUpdate {
  epicId: ID;
  epicName: string;
  taskId: ID;
  taskName: string;
  /** The Jira issues mapped to this task, in snapshot order. */
  issueKeys: string[];
  /** The baseline task's estimate now. */
  currentDays: number;
  /** Whether the baseline task is skipped; copying the estimate un-skips it. */
  currentExcluded: boolean;
  /** What Jira says, in Planner days. */
  jiraDays: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Every baseline task whose Jira estimate differs from its own, or that is
 * skipped while Jira has an estimate for it, in project order. Tasks Jira has
 * no estimate for are left out: there is nothing to copy.
 */
export function estimateUpdates(
  project: Project,
  snapshot: JiraSnapshot,
  taskMap: Tracker["taskMap"],
  hoursPerDay: number | undefined,
): EstimateUpdate[] {
  const map = taskMap ?? {};
  const byTask = new Map<ID, { keys: string[]; days: number; any: boolean }>();
  for (const issue of jiraTasks(snapshot)) {
    const taskId = map[issue.key];
    if (typeof taskId !== "string") continue;
    const estimate = estimateOf(issue, hoursPerDay);
    const entry = byTask.get(taskId) ?? { keys: [], days: 0, any: false };
    entry.keys.push(issue.key);
    entry.days += estimate.days;
    if (estimate.source !== "none") entry.any = true;
    byTask.set(taskId, entry);
  }

  const out: EstimateUpdate[] = [];
  for (const epic of project.epics) {
    for (const task of epic.tasks) {
      const entry = byTask.get(task.id);
      if (!entry || !entry.any) continue;
      const jiraDays = round2(entry.days);
      const currentDays = Number(task.estimateDays) || 0;
      if (jiraDays === round2(currentDays) && !task.excluded) continue;
      out.push({
        epicId: epic.id,
        epicName: epic.name,
        taskId: task.id,
        taskName: task.name,
        issueKeys: entry.keys,
        currentDays,
        currentExcluded: task.excluded,
        jiraDays,
      });
    }
  }
  return out;
}
