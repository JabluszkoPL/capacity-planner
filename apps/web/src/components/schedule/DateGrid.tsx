import { useState, type ReactNode } from "react";
import {
  type Assignment,
  addDays,
  diffDays,
  fromISO,
  isWeekend,
  toISO,
  type PlanMarker,
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

/** A date with its year, e.g. "Dec 18, 2026". */
export function formatLongDate(iso: string): string {
  const d = fromISO(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
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
 *  one assignment. Markers later than the plan's finish stretch the range so
 *  they stay on screen; `rangeEnd` is still the plan's own finish. */
export function computeGanttRange(
  startISO: string,
  assignments: Assignment[],
  markers: PlanMarker[] = [],
): GanttRange {
  const rangeStart = fromISO(startISO);
  const rangeEnd = assignments.reduce(
    (max, a) => (a.end > max ? a.end : max),
    assignments[0].end,
  );
  const lastDay = markers.reduce(
    (max, m) => (m.date > max ? m.date : max),
    rangeEnd,
  );
  const totalDays = Math.max(diffDays(rangeStart, fromISO(lastDay)) + 8, 14);
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
  meta,
}: {
  bar: TimelineBar;
  rangeStart: Date;
  colWidth: number;
  label: string;
  /** Hover text; defaults to the task / epic / assignee summary. */
  title?: string;
  /** Extra classes, e.g. to set a suggestion apart from settled work. */
  className?: string;
  /** A quieter suffix after the label, e.g. the estimate ("5d"). */
  meta?: string;
}) {
  const left = diffDays(rangeStart, fromISO(bar.start)) * colWidth;
  const width = Math.max(
    (diffDays(fromISO(bar.start), fromISO(bar.end)) + 1) * colWidth - 2,
    colWidth - 2,
  );
  // The bar is a light wash of its colour with darker text (see .gantt-bar);
  // the colour itself travels as a custom property.
  return (
    <div
      className={"gantt-bar" + (className ? " " + className : "")}
      style={{ left, width, ["--bar" as string]: bar.color }}
      title={
        title ??
        `${bar.taskName} (${bar.epicName})\n${bar.memberName} · ${bar.start} → ${bar.end} · ${bar.estimateDays}d`
      }
    >
      <span className="gantt-bar-label">{label}</span>
      {meta && <span className="gantt-bar-meta">{meta}</span>}
    </div>
  );
}

/** Rough rendered width of a marker label (10px semibold text plus padding).
 *  Only used to stack labels that would otherwise overlap. */
export function markerLabelWidth(name: string): number {
  return name.length * 6 + 12;
}

/**
 * Give each label the first level (row) where it does not overlap the label
 * before it. Labels are left-anchored at `x`; input must be sorted by `x`.
 * Returns one level per label, 0 being the top row.
 */
export function stackLabels(items: { x: number; width: number }[]): number[] {
  const ends: number[] = [];
  return items.map(({ x, width }) => {
    let level = ends.findIndex((end) => end <= x);
    if (level === -1) level = ends.length;
    ends[level] = x + width + 4;
    return level;
  });
}

/** Marker height per label row in the gantt header. */
const MARKER_ROW_H = 18;

/** Width of the diamond drawn ahead of a marker's name. */
const MARKER_DIAMOND_W = 10;

/** Height of the month row and of the day row in the gantt header. */
const MONTH_ROW_H = 18;
const DAY_ROW_H = 20;

/** Columns at least this wide get a label for every day, not only Mondays. */
const EVERY_DAY_FROM = 16;

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
  /** Label every day, even when the columns are narrow. Columns of 16px or
   *  more always get one. */
  dayLabels?: boolean;
  /** Heading over the label column, e.g. "Person". */
  corner?: ReactNode;
  rows: GanttRow[];
  /** Named dates drawn as labelled vertical lines. Sorted by date. */
  markers?: PlanMarker[];
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
 * Shared gantt frame: sticky label column, a two-row date header (months over
 * days), per-row weekend/off-day background shading, and a single "today"
 * marker. Every gantt view composes this so the today line and columns line up
 * identically.
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
  corner,
  rows,
  markers = [],
}: DateGridProps) {
  const { dates, totalDays, todayIndex, rangeStart } = range;
  const innerWidth = labelWidth + totalDays * colWidth;

  // Markers inside the visible range, centred on their day's column, with
  // their labels stacked into rows under the date labels when they collide.
  const placed = markers
    .map((m) => ({ marker: m, col: diffDays(rangeStart, fromISO(m.date)) }))
    .filter(({ col }) => col >= 0 && col < totalDays)
    .map((p) => {
      const x = labelWidth + p.col * colWidth + colWidth / 2;
      const width = markerLabelWidth(p.marker.name) + MARKER_DIAMOND_W;
      // A label that would run off the right edge sits left of its line.
      return { ...p, x, width, flip: x + width > innerWidth };
    });
  const levels = stackLabels(
    placed.map(({ x, width, flip }) => ({ x: flip ? x - width : x, width })),
  );
  const markerRows = placed.length > 0 ? Math.max(...levels) + 1 : 0;
  const everyDay = dayLabels || colWidth >= EVERY_DAY_FROM;
  const baseHeaderH = MONTH_ROW_H + DAY_ROW_H;
  const showToday = todayIndex >= 0 && todayIndex <= totalDays;

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

  // The "Today" pill sits centred over today's column, on the same row as the
  // month names; a month name it would cover moves just past it instead.
  const todayCenter = labelWidth + todayIndex * colWidth + colWidth / 2;
  const TODAY_PILL_HALF = 22;
  const MONTH_LABEL_W = 70;
  const monthLabelLeft = (left: number) =>
    showToday &&
    todayCenter + TODAY_PILL_HALF > left &&
    todayCenter - TODAY_PILL_HALF < left + MONTH_LABEL_W
      ? todayCenter + TODAY_PILL_HALF + 4
      : left;
  // One label per month, placed where it fits. When two would overlap (the
  // chart starting a day before a new month would print "Nov 2026" over
  // "Dec 2026"), the month with more days on the chart keeps its label.
  const monthLabels: { i: number; left: number }[] = [];
  const shownDays = (i: number) => {
    let n = 0;
    const month = dates[i]!.getMonth();
    while (i + n < dates.length && dates[i + n]!.getMonth() === month) n++;
    return n;
  };
  dates.forEach((d, i) => {
    if (i !== 0 && d.getDate() !== 1) return;
    const left = monthLabelLeft(labelWidth + i * colWidth);
    const prev = monthLabels[monthLabels.length - 1];
    if (prev && left - prev.left < MONTH_LABEL_W) {
      if (shownDays(prev.i) > shownDays(i)) return;
      monthLabels.pop();
    }
    monthLabels.push({ i, left });
  });

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
            scrolling down through the rows. Months on top, days beneath (or
            only Mondays when the columns are too narrow for every day). */}
        <div
          className="gantt-header"
          style={{ height: baseHeaderH + markerRows * MARKER_ROW_H }}
        >
          <div className="gantt-corner" style={{ width: labelWidth }}>
            {corner}
          </div>
          {monthLabels.map(({ i, left }) => (
            <div key={"m" + i} className="gantt-monthlabel" style={{ left }}>
              {MONTHS[dates[i]!.getMonth()]} {dates[i]!.getFullYear()}
            </div>
          ))}
          {everyDay
            ? dates.map((d, i) => (
                <div
                  key={"d" + i}
                  className={
                    "gantt-daylabel" +
                    (isWeekend(d) ? " weekend" : "") +
                    (i === todayIndex ? " today" : "")
                  }
                  style={{ left: labelWidth + i * colWidth, width: colWidth }}
                >
                  {colWidth >= 44
                    ? `${WEEKDAYS[d.getDay()]} ${d.getDate()}`
                    : d.getDate()}
                </div>
              ))
            : dates.map((d, i) =>
                i === 0 || d.getDay() === 1 ? (
                  <div
                    key={"w" + i}
                    className="gantt-datelabel"
                    style={{ left: labelWidth + i * colWidth }}
                  >
                    {d.getDate()}
                  </div>
                ) : null,
              )}
          {showToday && (
            <div className="gantt-todaylabel" style={{ left: todayCenter }}>
              Today
            </div>
          )}
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
          {placed.map(({ marker, x, flip }, i) => (
            <div
              key={marker.id}
              className={"gantt-markerlabel" + (flip ? " flip" : "")}
              style={{ left: x, top: baseHeaderH + levels[i] * MARKER_ROW_H }}
              title={`${marker.name} · ${formatHoverDate(fromISO(marker.date))}`}
            >
              {marker.name}
            </div>
          ))}
        </div>

        {rows.map((row) => (
          <div
            className={"gantt-row" + (row.className ? " " + row.className : "")}
            key={row.key}
          >
            <div
              className={
                "gantt-label" +
                (wideLabels ? " wide" : "") +
                (row.labelBorderColor ? " accented" : "")
              }
              style={{
                width: labelWidth,
                ...(row.labelBorderColor
                  ? { ["--row-accent" as string]: row.labelBorderColor }
                  : {}),
              }}
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

        {placed.map(({ marker, x }) => (
          <div
            key={"ml" + marker.id}
            className="gantt-markerline"
            data-testid="gantt-marker"
            style={{ left: x }}
          />
        ))}

        {showToday && (
          <div
            className="gantt-todayline"
            style={{ left: labelWidth + todayIndex * colWidth }}
          />
        )}
      </div>
    </div>
  );
}
