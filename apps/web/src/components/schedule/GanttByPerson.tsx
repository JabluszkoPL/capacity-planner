import { Fragment } from "react";
import {
  type Assignment,
  type OffDayMap,
  type TeamMember,
  isWeekend,
  toISO,
  personRows,
  type PlanMarker,
} from "@planner/core";
import {
  COL_WIDTH,
  DateGrid,
  GanttBar,
  type GanttRange,
  type GanttRow,
} from "./DateGrid";

interface GanttByPersonProps {
  assignments: Assignment[];
  team: { members: TeamMember[]; offDays: OffDayMap };
  range: GanttRange;
  /** Named dates drawn on the grid. */
  markers?: PlanMarker[];
}

export function GanttByPerson({
  assignments,
  team,
  range,
  markers,
}: GanttByPersonProps) {
  // One lane per assignee (team members and helpers alike), first-seen order.
  const lanes = personRows(assignments, team.offDays);

  const rows: GanttRow[] = lanes.map((lane) => ({
    key: lane.key,
    labelBorderColor: lane.borderColor,
    offDays: lane.offDays,
    label: <span className="lbl-title">{lane.title}</span>,
    bars: lane.bars.map((b) => (
      <GanttBar
        key={b.taskId}
        bar={b}
        rangeStart={range.rangeStart}
        colWidth={COL_WIDTH}
        label={b.taskName}
      />
    )),
  }));

  // Utilization: assigned workdays ÷ working days available in the visible
  // range, capped at 100%.
  const util = lanes.map((lane) => {
    const assigned = lane.bars.reduce(
      (s, b) => s + Math.ceil(Number(b.estimateDays) || 0),
      0,
    );
    let capacity = 0;
    for (const d of range.dates) {
      if (!isWeekend(d) && !lane.offDays.has(toISO(d))) capacity++;
    }
    const pct = capacity
      ? Math.min(100, Math.round((assigned / capacity) * 100))
      : 0;
    return { id: lane.key, name: lane.title, assigned, pct };
  });

  return (
    <>
      <DateGrid
        range={range}
        colWidth={COL_WIDTH}
        labelWidth={130}
        rows={rows}
        markers={markers}
      />
      <div className="util-grid">
        {util.map((u) => (
          <Fragment key={u.id}>
            <div className="util-name" title={u.name}>
              {u.name}
            </div>
            <div className="util-bar-bg">
              <div className="util-bar-fg" style={{ width: `${u.pct}%` }} />
            </div>
            <div>{u.assigned}d</div>
          </Fragment>
        ))}
      </div>
    </>
  );
}
