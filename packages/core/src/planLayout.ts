/**
 * Shared timeline layout model.
 *
 * The on-screen Gantt views (GanttByPerson / GanttByTask / GanttByEpic), the Excel export
 * (planExcel), and the timeline image (planImage) derive their rows from these
 * builders, so ordering, lanes, and bar ranges stay identical everywhere.
 */
import type {
  Assignment,
  Epic,
  OffDayMap,
  PlanViewMode,
  UnassignedTask,
} from "./types";
import { colorFor } from "./colors";

/** A single scheduled bar within a timeline row. */
export interface TimelineBar {
  taskId: string;
  taskName: string;
  memberName: string;
  epicName: string;
  specialization: string;
  estimateDays: number;
  start: string; // ISO
  end: string; // ISO
  color: string;
}

/** One row (lane) of the timeline — a person, a task or an epic. */
export interface TimelineRow {
  key: string;
  /** Primary label (member name, task name or epic name). */
  title: string;
  /** Optional secondary label (task rows show "member · epic"). */
  subtitle?: string;
  /** Accent color for the row's left border. */
  borderColor: string;
  /** Days this row's assignee is off (ISO dates). */
  offDays: Set<string>;
  bars: TimelineBar[];
}

const byStart = (a: TimelineBar, b: TimelineBar) =>
  a.start.localeCompare(b.start);

function toBar(a: Assignment): TimelineBar {
  return {
    taskId: a.taskId,
    taskName: a.taskName,
    memberName: a.memberName,
    epicName: a.epicName,
    specialization: a.specialization,
    estimateDays: a.estimateDays,
    start: a.start,
    end: a.end,
    color: colorFor(a.specialization),
  };
}

/**
 * One lane per assignee (team members and helpers alike), in first-seen order.
 * Each lane's bars are sorted by start date.
 */
export function personRows(
  assignments: Assignment[],
  offDays: OffDayMap,
): TimelineRow[] {
  const order: string[] = [];
  const byMember = new Map<string, Assignment[]>();
  for (const a of assignments) {
    if (!byMember.has(a.memberId)) {
      byMember.set(a.memberId, []);
      order.push(a.memberId);
    }
    byMember.get(a.memberId)!.push(a);
  }
  return order.map((id) => {
    const bars = byMember.get(id)!.map(toBar).sort(byStart);
    return {
      key: id,
      title: bars[0].memberName,
      borderColor: bars[0].color,
      offDays: new Set(offDays[id] ?? []),
      bars,
    };
  });
}

/**
 * One row per assigned task, ordered by the epic/task order in the project.
 */
export function taskRows(
  assignments: Assignment[],
  epics: Epic[],
  offDays: OffDayMap,
): TimelineRow[] {
  const orderIndex = new Map<string, number>();
  let i = 0;
  for (const epic of epics) {
    for (const t of epic.tasks) orderIndex.set(t.id, i++);
  }
  const memberOf = new Map<string, string>();
  for (const a of assignments) memberOf.set(a.taskId, a.memberId);
  return assignments
    .slice()
    .sort(
      (a, b) =>
        (orderIndex.get(a.taskId) ?? 0) - (orderIndex.get(b.taskId) ?? 0),
    )
    .map((a) => {
      const bar = toBar(a);
      return {
        key: a.taskId,
        title: a.taskName,
        subtitle: `${a.memberName} · ${a.epicName}`,
        borderColor: bar.color,
        offDays: new Set(offDays[a.memberId] ?? []),
        bars: [bar],
      };
    });
}

/**
 * Normalise a stored view mode. Anything unrecognised — including a value
 * written by a newer release — falls back to "person", the historic default.
 */
export function planViewModeOf(value: unknown): PlanViewMode {
  return value === "task" || value === "epic" ? value : "person";
}

/** When one epic's scheduled work starts and ends. */
export interface EpicSpan {
  epicId: string;
  epicName: string;
  /** Earliest start among the epic's assigned tasks (ISO). */
  start: string;
  /** Latest end among the epic's assigned tasks (ISO). */
  end: string;
  /** Assigned tasks counted in the span. */
  taskCount: number;
  /** Distinct people working on it. */
  peopleCount: number;
  /** Sum of the assigned tasks' estimates, in days. */
  estimateDays: number;
  /**
   * Tasks of this epic the plan couldn't place. When non-zero the real end is
   * later than `end` — the span only covers work that has a slot.
   */
  unassignedCount: number;
}

/**
 * One span per epic that has at least one assigned task, in project epic
 * order. An epic starts when its first task starts and ends when its last task
 * ends; tasks that couldn't be scheduled are counted but can't move the dates.
 */
export function epicSpans(
  assignments: Assignment[],
  epics: Epic[],
  unassigned: UnassignedTask[] = [],
): EpicSpan[] {
  const byEpic = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const list = byEpic.get(a.epicId);
    if (list) list.push(a);
    else byEpic.set(a.epicId, [a]);
  }
  const unassignedBy = new Map<string, number>();
  for (const u of unassigned)
    unassignedBy.set(u.epicId, (unassignedBy.get(u.epicId) ?? 0) + 1);

  // Project order first, then any epic only the plan knows about (the project
  // was edited since the plan ran), in first-seen order.
  const order = epics.map((e) => e.id).filter((id) => byEpic.has(id));
  for (const id of byEpic.keys()) if (!order.includes(id)) order.push(id);

  return order.map((id) => {
    const list = byEpic.get(id)!;
    let start = list[0].start;
    let end = list[0].end;
    let estimateDays = 0;
    for (const a of list) {
      if (a.start < start) start = a.start;
      if (a.end > end) end = a.end;
      estimateDays += Number(a.estimateDays) || 0;
    }
    return {
      epicId: id,
      epicName: epics.find((e) => e.id === id)?.name ?? list[0].epicName,
      start,
      end,
      taskCount: list.length,
      peopleCount: new Set(list.map((a) => a.memberId)).size,
      estimateDays,
      unassignedCount: unassignedBy.get(id) ?? 0,
    };
  });
}

/**
 * One row per epic with a single bar from its first task's start to its last
 * task's end (see {@link epicSpans}). Epic rows carry no one's days off, since
 * several people share an epic — only weekends are shaded.
 */
export function epicRows(
  assignments: Assignment[],
  epics: Epic[],
  unassigned: UnassignedTask[] = [],
): TimelineRow[] {
  return epicSpans(assignments, epics, unassigned).map((s) => {
    const color = colorFor(s.epicName);
    const tasks = `${s.taskCount} task${s.taskCount === 1 ? "" : "s"}`;
    const missing = s.unassignedCount
      ? ` · ${s.unassignedCount} unassigned`
      : "";
    return {
      key: s.epicId,
      title: s.epicName,
      subtitle: `${s.start} → ${s.end} · ${tasks}${missing}`,
      borderColor: color,
      offDays: new Set<string>(),
      bars: [
        {
          taskId: s.epicId,
          taskName: s.epicName,
          memberName: tasks,
          epicName: s.epicName,
          specialization: "",
          estimateDays: s.estimateDays,
          start: s.start,
          end: s.end,
          color,
        },
      ],
    };
  });
}
