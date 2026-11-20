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
import { Avatar } from "../ui/IconTile";

/** Trim a day count to at most one decimal, dropping a trailing ".0". */
function fmtDays(n: number): string {
  return Number((Number(n) || 0).toFixed(1)).toString();
}

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
  const memberById = new Map(team.members.map((m) => [m.id, m]));

  const rows: GanttRow[] = lanes.map((lane) => {
    // A helper outside every team has no member record; their work still
    // says what they were planned as.
    const spec =
      memberById.get(lane.key)?.specialization ?? lane.bars[0].specialization;
    return {
      key: lane.key,
      offDays: lane.offDays,
      label: (
        <span className="lbl-person">
          <Avatar name={lane.title} color={lane.borderColor} size="sm" />
          <span className="lbl-text">
            <span className="lbl-title">{lane.title}</span>
            {spec && <span className="lbl-sub">{spec}</span>}
          </span>
        </span>
      ),
      bars: lane.bars.map((b) => (
        <GanttBar
          key={b.taskId}
          bar={b}
          rangeStart={range.rangeStart}
          colWidth={COL_WIDTH}
          label={b.taskName}
          meta={`${fmtDays(b.estimateDays)}d`}
        />
      )),
    };
  });

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
        labelWidth={168}
        corner="Person"
        rows={rows}
        markers={markers}
      />
      <div className="util-section">
        <div className="util-title">Load across the visible range</div>
        <div className="util-grid">
          {util.map((u) => (
            <Fragment key={u.id}>
              <div className="util-name" title={u.name}>
                {u.name}
              </div>
              <div
                className="util-bar-bg"
                role="img"
                aria-label={`${u.name}: ${u.pct}% of available working days`}
              >
                <div className="util-bar-fg" style={{ width: `${u.pct}%` }} />
              </div>
              <div className="util-days">{u.assigned}d</div>
            </Fragment>
          ))}
        </div>
      </div>
    </>
  );
}
