import { useMemo } from "react";
import {
  addDays,
  diffDays,
  draftAssignments,
  fromISO,
  personRows,
  toISO,
  type DraftSpan,
  type DraftWorker,
  type ID,
  type JiraSnapshot,
  type Project,
  type SprintDraft,
  type Team,
  type Tracker,
} from "@planner/core";
import {
  COL_WIDTH,
  DateGrid,
  GanttBar,
  type GanttRange,
  type GanttRow,
} from "../schedule/DateGrid";
import "../schedule/schedule.css";

interface SprintGanttProps {
  draft: SprintDraft;
  spans: Map<string, DraftSpan>;
  snapshot: JiraSnapshot;
  workers: Map<ID, DraftWorker>;
  teams: Team[];
  project?: Project;
  epicMap: Tracker["epicMap"];
}

/** Pad the window slightly so bars that overrun it are still visible. */
const PAD_DAYS = 2;

function windowRange(draft: SprintDraft, latestEnd: string): GanttRange {
  const rangeStart = addDays(fromISO(draft.start), -PAD_DAYS);
  const end = latestEnd > draft.end ? latestEnd : draft.end;
  const rangeEnd = toISO(addDays(fromISO(end), PAD_DAYS));
  const totalDays = Math.max(diffDays(rangeStart, fromISO(rangeEnd)) + 1, 14);
  const dates = Array.from({ length: totalDays }, (_, i) =>
    addDays(rangeStart, i),
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return {
    rangeStart,
    rangeEnd,
    totalDays,
    dates,
    todayIndex: diffDays(rangeStart, today),
  };
}

/**
 * The draft as a timeline, with the baseline plan behind it.
 *
 * This composes `DateGrid` directly rather than reusing `GanttByPerson`. The
 * two views want genuinely different things — the plan's view derives its
 * range from the assignments and shows utilisation against the whole plan,
 * while a sprint's range is the sprint window and its "utilisation" is the
 * capacity check already shown in the table above. What must not diverge is
 * the *layout*, and that is `personRows` plus `DateGrid`, both shared.
 *
 * The plan's own bars for the same epics are drawn faintly underneath. They
 * are context, not a target: the whole point of drafting a sprint here is that
 * the plan's dates have already been overtaken by events, and seeing where the
 * plan thought this work would sit is how the drift becomes visible.
 */
export function SprintGantt({
  draft,
  spans,
  snapshot,
  workers,
  teams,
  project,
  epicMap,
}: SprintGanttProps) {
  const assignments = useMemo(
    () => draftAssignments(draft, spans, snapshot, workers),
    [draft, spans, snapshot, workers],
  );

  // The plan's assignments for the epics this sprint touches, so the ghost
  // layer stays relevant instead of redrawing the entire plan.
  const ghosts = useMemo(() => {
    if (!project?.plan) return [];
    const epicIds = new Set<string>();
    for (const item of draft.items) {
      const epic = snapshot.epics.find((e) =>
        (e.children ?? []).some((c) => c.key === item.issueKey),
      );
      const mapped = epic ? (epicMap ?? {})[epic.key] : undefined;
      if (mapped) epicIds.add(mapped);
    }
    return project.plan.assignments.filter((a) => epicIds.has(a.epicId));
  }, [project, draft.items, snapshot.epics, epicMap]);

  const offDays = useMemo(() => {
    const merged: Record<string, string[]> = {};
    for (const team of teams) {
      for (const [memberId, dates] of Object.entries(team.offDays ?? {})) {
        merged[memberId] = dates;
      }
    }
    return merged;
  }, [teams]);

  if (assignments.length === 0) return null;

  const latestEnd = assignments.reduce(
    (max, a) => (a.end > max ? a.end : max),
    assignments[0].end,
  );
  const range = windowRange(draft, latestEnd);

  const lanes = personRows(assignments, offDays);
  const ghostLanes = new Map(
    personRows(ghosts, offDays).map((lane) => [lane.key, lane]),
  );

  const rows: GanttRow[] = lanes.map((lane) => {
    const ghost = ghostLanes.get(lane.key);
    return {
      key: lane.key,
      labelBorderColor: lane.borderColor,
      offDays: lane.offDays,
      label: <span className="lbl-title">{lane.title}</span>,
      bars: (
        <>
          {ghost?.bars.map((b) => (
            <div className="ghost-bar-wrap" key={"ghost-" + b.taskId}>
              <GanttBar
                bar={b}
                rangeStart={range.rangeStart}
                colWidth={COL_WIDTH}
                label=""
              />
            </div>
          ))}
          {lane.bars.map((b) => (
            <GanttBar
              key={b.taskId}
              bar={b}
              rangeStart={range.rangeStart}
              colWidth={COL_WIDTH}
              label={b.taskName}
            />
          ))}
        </>
      ),
    };
  });

  return (
    <div className="sprint-gantt">
      <h3 className="sprint-gantt-title">Sprint timeline</h3>
      {ghosts.length > 0 && (
        <p className="muted">
          Faded bars are where the baseline plan put this work.
        </p>
      )}
      <DateGrid
        range={range}
        colWidth={COL_WIDTH}
        labelWidth={130}
        rows={rows}
      />
    </div>
  );
}
