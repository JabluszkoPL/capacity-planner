import {
  type Assignment,
  type Epic,
  type OffDayMap,
  taskRows,
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
}

export function GanttByTask({
  assignments,
  epics,
  offDays,
  range,
}: GanttByTaskProps) {
  const rows: GanttRow[] = taskRows(assignments, epics, offDays).map((r) => ({
    key: r.key,
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
  }));

  return (
    <DateGrid
      range={range}
      colWidth={COL_WIDTH}
      labelWidth={220}
      wideLabels
      rows={rows}
    />
  );
}
