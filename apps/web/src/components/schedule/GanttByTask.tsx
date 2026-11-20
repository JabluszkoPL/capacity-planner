import {
  type Assignment,
  type Epic,
  type OffDayMap,
  taskRows,
  type PlanMarker,
} from "@planner/core";

import {
  COL_WIDTH,
  DateGrid,
  GanttBar,
  type GanttRange,
  type GanttRow,
} from "./DateGrid";

interface GanttByTaskProps {
  assignments: Assignment[];
  epics: Epic[];
  offDays: OffDayMap;
  range: GanttRange;
  /** Named dates drawn on the grid. */
  markers?: PlanMarker[];
}

export function GanttByTask({
  assignments,
  epics,
  offDays,
  range,
  markers,
}: GanttByTaskProps) {
  // Rows come in epic order; a rule above each epic's first task groups them.
  const rows: GanttRow[] = taskRows(assignments, epics, offDays).map(
    (r, i, all) => ({
      key: r.key,
      className:
        i > 0 && all[i - 1].bars[0].epicName !== r.bars[0].epicName
          ? "group-start"
          : undefined,
      labelBorderColor: r.borderColor,
      offDays: r.offDays,
      label: (
        <>
          <span className="lbl-title">{r.title}</span>
          <span className="lbl-sub">{r.subtitle}</span>
        </>
      ),
      bars: (
        <GanttBar
          bar={r.bars[0]}
          rangeStart={range.rangeStart}
          colWidth={COL_WIDTH}
          label={r.bars[0].memberName}
        />
      ),
    }),
  );

  return (
    <DateGrid
      range={range}
      colWidth={COL_WIDTH}
      labelWidth={240}
      wideLabels
      corner="Task"
      rows={rows}
      markers={markers}
    />
  );
}
