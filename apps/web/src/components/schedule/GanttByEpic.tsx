import {
  type Assignment,
  type Epic,
  type UnassignedTask,
  colorFor,
  epicSpans,
} from "@planner/core";

import {
  COL_WIDTH,
  DateGrid,
  GanttBar,
  formatShortDate,
  type GanttRange,
  type GanttRow,
} from "./DateGrid";

interface GanttByEpicProps {
  assignments: Assignment[];
  epics: Epic[];
  unassigned: UnassignedTask[];
  range: GanttRange;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * One row per epic: a single bar from the day its first task starts to the day
 * its last task ends. An epic with tasks the plan couldn't place is flagged,
 * because its real end is later than the bar shows.
 */
export function GanttByEpic({
  assignments,
  epics,
  unassigned,
  range,
}: GanttByEpicProps) {
  const rows: GanttRow[] = epicSpans(assignments, epics, unassigned).map(
    (s) => {
      const color = colorFor(s.epicName);
      const dates = `${formatShortDate(s.start)} → ${formatShortDate(s.end)}`;
      const summary = [
        plural(s.taskCount, "task"),
        s.peopleCount === 1 ? "1 person" : `${s.peopleCount} people`,
        `${Number(s.estimateDays.toFixed(1))}d estimated`,
      ].join(" · ");
      const warning = s.unassignedCount
        ? `${plural(s.unassignedCount, "task")} unassigned — ends later than shown`
        : "";
      return {
        key: s.epicId,
        labelBorderColor: color,
        offDays: new Set<string>(),
        label: (
          <>
            <span className="lbl-title">{s.epicName}</span>
            <span className="lbl-sub">
              {dates} · {plural(s.taskCount, "task")}
            </span>
            {warning && <span className="lbl-sub lbl-warn">⚠ {warning}</span>}
          </>
        ),
        bars: (
          <GanttBar
            bar={{
              taskId: s.epicId,
              taskName: s.epicName,
              memberName: "",
              epicName: s.epicName,
              specialization: "",
              estimateDays: s.estimateDays,
              start: s.start,
              end: s.end,
              color,
            }}
            rangeStart={range.rangeStart}
            colWidth={COL_WIDTH}
            label={dates}
            title={[s.epicName, `${s.start} → ${s.end}`, summary, warning]
              .filter(Boolean)
              .join("\n")}
          />
        ),
      };
    },
  );

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
