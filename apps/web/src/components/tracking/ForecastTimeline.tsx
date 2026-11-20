import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  addDays,
  diffDays,
  fromISO,
  mergedOffDays,
  personRows,
  type PlanMarker,
  type RemainingWork,
  type Team,
} from "@planner/core";
import {
  DateGrid,
  GanttBar,
  type GanttRange,
  type GanttRow,
} from "../schedule/DateGrid";
import { days } from "./StatusPanel";
import { Icon } from "../ui/Icon";
import "../schedule/schedule.css";

/** Width of the person column in the timeline. */
const LABEL_WIDTH = 130;
/** Day widths the zoom buttons step through, in pixels. */
const ZOOM_STEPS = [12, 18, 24, 32, 44, 60, 80, 110];
/** Fit never squeezes a day narrower than this; the chart scrolls instead. */
const MIN_FIT = 12;
/** Columns at least this wide get a label for every day. */
const DAY_LABELS_FROM = 22;

/** Today to a couple of days past the last finish: no empty weeks after it. */
function forecastRange(from: string, finish: string): GanttRange {
  const rangeStart = fromISO(from);
  const totalDays = Math.max(diffDays(rangeStart, fromISO(finish)) + 3, 10);
  return {
    rangeStart,
    rangeEnd: finish,
    totalDays,
    dates: Array.from({ length: totalDays }, (_, i) => addDays(rangeStart, i)),
    todayIndex: 0,
  };
}

/** The width of an element, kept current as the window resizes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const specKey = (s: string) => s.trim().toLowerCase();

interface ForecastTimelineProps {
  work: RemainingWork;
  teams: Team[];
  /** Options that change the forecast, shown beside the chart. */
  controls?: ReactNode;
  /** A warning shown under the legend. */
  note?: ReactNode;
  /** Lines drawn across the chart, e.g. where each sprint starts. */
  markers?: PlanMarker[];
}

/**
 * A forecast of the work left as a timeline, one lane per person in the
 * forecast's order, with its legend and zoom. Shared by the work-left panel
 * and the sprint planner, so both draw the same work the same way.
 */
export function ForecastTimeline({
  work,
  teams,
  controls,
  note,
  markers = [],
}: ForecastTimelineProps) {
  const offDays = useMemo(() => mergedOffDays(teams), [teams]);
  // "fit" spreads the days over the width; a number is a fixed day width.
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [chartRef, chartWidth] = useWidth();

  const range =
    work.items.length > 0 && work.finish
      ? forecastRange(
          work.from,
          markers.reduce(
            (max, m) => (m.date > max ? m.date : max),
            work.finish,
          ),
        )
      : null;
  const fitWidth = range
    ? Math.max(
        MIN_FIT,
        Math.floor((chartWidth - LABEL_WIDTH - 4) / range.totalDays),
      )
    : MIN_FIT;
  const colWidth = zoom === "fit" ? fitWidth : zoom;
  const zoomIn = ZOOM_STEPS.find((w) => w > colWidth);
  const zoomOut = [...ZOOM_STEPS].reverse().find((w) => w < colWidth);

  // Lanes in the table's order: whoever finishes last on top.
  const order = new Map(work.people.map((p, i) => [p.memberId, i]));
  const lanes = personRows(work.items, offDays).sort(
    (a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
  );
  const byTask = new Map(work.items.map((a) => [a.taskId, a]));
  const rows: GanttRow[] = range
    ? lanes.map((lane) => {
        const index = order.get(lane.key) ?? 0;
        const person = work.people[index];
        const previous = lanes[lanes.indexOf(lane) - 1];
        const previousPerson = previous
          ? work.people[order.get(previous.key) ?? 0]
          : undefined;
        return {
          key: lane.key,
          className:
            previousPerson &&
            specKey(previousPerson.specialization) !==
              specKey(person.specialization)
              ? "group-start"
              : undefined,
          labelBorderColor: lane.borderColor,
          offDays: lane.offDays,
          label: (
            <span className="lbl-title" title={`done by ${person.finish}`}>
              {lane.title}
            </span>
          ),
          bars: lane.bars.map((bar) => {
            const item = byTask.get(bar.taskId);
            const started = item?.inProgress ?? false;
            const keys = item?.jiraKeys.join(", ");
            const how =
              item?.assignedBy === "planner"
                ? "suggested by the planner"
                : "assigned in Jira";
            return (
              <GanttBar
                key={bar.taskId}
                bar={bar}
                rangeStart={range.rangeStart}
                colWidth={colWidth}
                className={
                  [
                    item?.assignedBy === "planner" && "suggested",
                    item?.bug && "bug",
                    item?.estimateFrom === "assumed" && "assumed",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                label={
                  (started ? "▶ " : item?.waiting ? "⏸ " : "") + bar.taskName
                }
                title={`${keys ? keys + " " : ""}${bar.taskName} (${bar.epicName})\n${item?.bug ? "Bug · " : ""}${item?.priority ? `${item.priority} priority · ` : ""}${bar.memberName} · ${bar.start} → ${bar.end} · ${days(bar.estimateDays)} d${item?.estimateFrom === "assumed" ? " (no estimate, assumed)" : ""}${started ? " left · in progress" : ""}${item?.waiting ? " · waiting to be closed, counted at its whole estimate" : ""}\n${how}${item && !item.inPlan && item.estimateFrom === "jira" ? " · not in the plan, Jira's estimate" : ""}`}
              />
            );
          }),
        };
      })
    : [];

  return (
    <div className="forecast-gantt" ref={chartRef}>
      {(range || controls || note) && (
        <div className="forecast-toolbar">
          <div className="forecast-options">
            {controls}
            {range && (
              <span className="muted">
                <span className="forecast-swatch" /> assigned in Jira{" "}
                <span className="forecast-swatch suggested" /> suggested
                {work.items.some((a) => a.bug) && (
                  <>
                    {" "}
                    <span className="forecast-swatch bug" /> bug
                  </>
                )}
                {work.assumed > 0 && (
                  <>
                    {" "}
                    <span className="forecast-swatch assumed" /> no estimate
                  </>
                )}
              </span>
            )}
            {note && (
              <span className="forecast-unestimated" role="note">
                <span aria-hidden="true">⚠ </span>
                {note}
              </span>
            )}
          </div>
          {range && (
            // The kit's segmented look, but plain buttons: − and + are
            // actions and Fit is a toggle, not one choice among three, so a
            // radiogroup (<Segmented>) would announce the wrong thing.
            <div
              className="segmented segmented-sm forecast-zoom"
              role="group"
              aria-label="Zoom"
            >
              <button
                type="button"
                className="segmented-option"
                onClick={() => zoomOut && setZoom(zoomOut)}
                disabled={!zoomOut}
                aria-label="Zoom out"
                title="Zoom out"
              >
                <Icon name="minus" size={13} />
              </button>
              <button
                type="button"
                className={
                  "segmented-option" + (zoom === "fit" ? " active" : "")
                }
                aria-pressed={zoom === "fit"}
                onClick={() => setZoom("fit")}
              >
                Fit to width
              </button>
              <button
                type="button"
                className="segmented-option"
                onClick={() => zoomIn && setZoom(zoomIn)}
                disabled={!zoomIn}
                aria-label="Zoom in"
                title="Zoom in"
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
          )}
        </div>
      )}
      {range && (
        <DateGrid
          range={range}
          colWidth={colWidth}
          labelWidth={LABEL_WIDTH}
          dayLabels={colWidth >= DAY_LABELS_FROM}
          rows={rows}
          markers={markers}
        />
      )}
    </div>
  );
}
