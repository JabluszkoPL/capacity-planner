import type { Epic, ID } from "./types";

/**
 * Every task that already waits on `taskId`, directly or transitively.
 *
 * Follows both kinds of edge the scheduler honours: a task's own `dependsOn`,
 * and an epic's `dependsOn` (which makes every task in the dependent epic wait
 * on every task in the prerequisite epic). Making `taskId` depend on any task
 * in the returned set would close a cycle, and the scheduler would then leave
 * the whole loop unassigned — so pickers use this to keep bulk selection from
 * doing that by accident.
 *
 * `taskId` itself is never in the result, even if it already sits in a cycle.
 */
export function tasksWaitingOn(epics: Epic[], taskId: ID): Set<ID> {
  const epicOfTask = new Map<ID, Epic>();
  for (const e of epics) for (const t of e.tasks) epicOfTask.set(t.id, e);

  // Reverse edges: prerequisite task id -> task ids that wait on it.
  const waiters = new Map<ID, ID[]>();
  const addEdge = (from: ID, to: ID) => {
    const list = waiters.get(from);
    if (list) list.push(to);
    else waiters.set(from, [to]);
  };
  const epicById = new Map(epics.map((e) => [e.id, e]));
  for (const e of epics) {
    for (const t of e.tasks) {
      for (const dep of t.dependsOn ?? []) addEdge(dep, t.id);
    }
    for (const depEpicId of e.dependsOn ?? []) {
      const depEpic = epicById.get(depEpicId);
      if (!depEpic || depEpic.id === e.id) continue;
      for (const pre of depEpic.tasks)
        for (const t of e.tasks) addEdge(pre.id, t.id);
    }
  }

  const seen = new Set<ID>();
  const stack = [taskId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const next of waiters.get(current) ?? []) {
      if (seen.has(next) || !epicOfTask.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  seen.delete(taskId);
  return seen;
}
