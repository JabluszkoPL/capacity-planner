import { useState, type ReactNode } from "react";
import {
  type Assignment,
  addDays,
  diffDays,
  fromISO,
  isWeekend,
  toISO,
  type TimelineBar,
} from "@planner/core";

export const COL_WIDTH = 18;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatShortDate(iso: string): string {
  const d = fromISO(iso);
  return MONTHS[d.getMonth()] + " " + d.getDate();
}

/** Weekday-prefixed label shown in the hover tooltip, e.g. "Wed, Jul 29". */
export function formatHoverDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export interface GanttRange {
  rangeStart: Date;
  rangeEnd: string; // ISO
  totalDays: number;
  dates: Date[];
  todayIndex: number; // column index of today (may be < 0 or > totalDays)
}

/** Compute the visible date range for a set of assignments. Assumes at least
 *  one assignment. */
export function computeGanttRange(
  startISO: string,
  assignments: Assignment[],
): GanttRange {
  const rangeStart = fromISO(startISO);
  const rangeEnd = assignments.reduce(
    (max, a) => (a.end > max ? a.end : max),
    assignments[0].end,
  );
  const totalDays = Math.max(diffDays(rangeStart, fromISO(rangeEnd)) + 8, 14);
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

/** A single schedule bar positioned within a gantt track. */
export function GanttBar({
  bar,
  rangeStart,
  colWidth,
  label,
  title,
  className,
}: {
  bar: TimelineBar;
  rangeStart: Date;
  colWidth: number;
  label: string;
  /** Hover text; defaults to the task / epic / assignee summary. */
  title?: string;
  /** Extra classes, e.g. to set a suggestion apart from settled work. */
  className?: string;
}) {
  const left = diffDays(rangeStart, fromISO(bar.start)) * colWidth;
  const width = Math.max(
    (diffDays(fromISO(bar.start), fromISO(bar.end)) + 1) * colWidth - 2,
    colWidth - 2,
  );
  return (
    <div
      className={"gantt-bar" + (className ? " " + className : "")}
      style={{ left, width, background: bar.color }}
      title={
        title ??
        `${bar.taskName} (${bar.epicName})\n${bar.memberName} · ${bar.start} → ${bar.end} · ${bar.estimateDays}d`
      }
    >
      {label}
    </div>
  );
}

export interface GanttRow {
  key: string;
  label: ReactNode;
  offDays: Set<string>;
  bars: ReactNode;
  labelBorderColor?: string;
  /** Extra classes for the row, e.g. to mark where a group starts. */
  className?: string;
}

interface DateGridProps {
  range: GanttRange;
  colWidth: number;
  labelWidth: number;
  wideLabels?: boolean;
  /** Label every day under the week labels; for wide columns. */
  dayLabels?: boolean;
  rows: GanttRow[];
}

function backgroundCells(
  dates: Date[],
  colWidth: number,
  offDays: Set<string>,
) {
  return dates.map((d, i) => {
    let cls: string | null = null;
    if (isWeekend(d)) cls = "weekend";
    else if (offDays.has(toISO(d))) cls = "nonwork";
    if (!cls) return null;
    return (
      <div
        key={i}
        className={"gantt-bgcell " + cls}
        style={{ left: i * colWidth, width: colWidth }}
      />
    );
  });
}

/**
 * Shared gantt frame: sticky label column, a date-label header, per-row
 * weekend/off-day background shading, and a single "today" marker. Both gantt
 * views compose this so the today line and columns line up identically.
 *
 * The header labels and today line are offset by labelWidth so they align with
 * the tracks (which begin after the sticky label column).
 */
export function DateGrid({
  range,
  colWidth,
  labelWidth,
  wideLabels = false,
  dayLabels = false,
  rows,
}: DateGridProps) {
  const { dates, totalDays, todayIndex } = range;
  const innerWidth = labelWidth + totalDays * colWidth;

  // Column the mouse is currently over (null when outside the tracks). Drives
  // the full-height highlight and the floating date tooltip.
  const [hoverCol, setHoverCol] = useState<number | null>(null);

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - labelWidth;
    if (x < 0) {
      setHoverCol(null);
      return;
    }
    const col = Math.floor(x / colWidth);
    setHoverCol(col >= 0 && col < totalDays ? col : null);
  }

  return (
    <div className="gantt-wrap">
      <div
        className="gantt-inner"
        style={{ width: innerWidth }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverCol(null)}
      >
        {hoverCol !== null && (
          <div
            className="gantt-hovercol"
            style={{ left: labelWidth + hoverCol * colWidth, width: colWidth }}
          />
        )}

        {/* Full-height vertical week gridlines. Kept separate from the header so
            they scroll with the chart body while the date labels stay pinned. */}
        {dates.map((d, i) =>
          i === 0 || d.getDay() === 1 ? (
            <div
              key={"gl" + i}
              className="gantt-gridline"
              style={{ left: labelWidth + i * colWidth }}
            />
          ) : null,
        )}

        {/* Date labels: sticky to the top so the date is always visible while
            scrolling down through the rows. */}
        <div className={"gantt-header" + (dayLabels ? " with-days" : "")}>
          {dates.map((d, i) =>
            i === 0 || d.getDay() === 1 ? (
              <div
                key={i}
                className="gantt-datelabel"
                style={{ left: labelWidth + i * colWidth }}
              >
                {MONTHS[d.getMonth()]} {d.getDate()}
              </div>
            ) : null,
          )}
          {dayLabels &&
            dates.map((d, i) => (
              <div
                key={"d" + i}
                className={"gantt-daylabel" + (isWeekend(d) ? " weekend" : "")}
                style={{ left: labelWidth + i * colWidth, width: colWidth }}
              >
                {colWidth >= 44
                  ? `${WEEKDAYS[d.getDay()]} ${d.getDate()}`
                  : d.getDate()}
              </div>
            ))}
          {/* Full date of the hovered column, pinned in the sticky header so it
              stays visible while scrolling vertically. */}
          {hoverCol !== null && (
            <div
              className="gantt-hoverdate"
              style={{ left: labelWidth + hoverCol * colWidth + colWidth / 2 }}
            >
              {formatHoverDate(dates[hoverCol])}
            </div>
          )}
        </div>

        {rows.map((row) => (
          <div
            className={"gantt-row" + (row.className ? " " + row.className : "")}
            key={row.key}
          >
            <div
              className={"gantt-label" + (wideLabels ? " wide" : "")}
              style={
                row.labelBorderColor
                  ? { borderLeft: `4px solid ${row.labelBorderColor}` }
                  : undefined
              }
            >
              {row.label}
            </div>
            <div
              className="gantt-track"
              style={{ width: totalDays * colWidth }}
            >
              {backgroundCells(dates, colWidth, row.offDays)}
              {row.bars}
            </div>
          </div>
        ))}

        {todayIndex >= 0 && todayIndex <= totalDays && (
          <div
            className="gantt-todayline"
            style={{ left: labelWidth + todayIndex * colWidth }}
          />
        )}
      </div>
    </div>
  );
}
