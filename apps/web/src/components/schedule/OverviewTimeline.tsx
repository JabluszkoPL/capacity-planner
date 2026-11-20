import { useLayoutEffect, useRef, useState } from "react";
import {
  type Assignment,
  type PlanMarker,
  addDays,
  diffDays,
  fromISO,
  toISO,
  colorFor,
} from "@planner/core";
import {
  formatHoverDate,
  formatShortDate,
  markerLabelWidth,
  stackLabels,
  type GanttRange,
} from "./DateGrid";

/** Width of the sticky discipline-label column (must match .overview-label). */
const LABEL_W = 72;

/**
 * Approximate rendered width of a "MMM D" date label at the 8px header font.
 * The end-date label is right-anchored and each weekly tick is left-anchored,
 * so a tick collides with the end label unless it clears roughly two label
 * widths. Used to hide the last weekly tick(s) that would overlap the end date.
 */
const LABEL_EST_PX = 36;

/**
 * The three disciplines this compact summary tracks. Specializations are
 * free-text, so each lane matches by keyword (e.g. a task tagged "Frontend"
 * counts as Client work). Lanes are shown in this order.
 */
type Discipline = "backend" | "client" | "qa";

const LANES: { key: Discipline; label: string }[] = [
  { key: "backend", label: "Backend" },
  { key: "client", label: "Client" },
  { key: "qa", label: "QA" },
];

/** Bucket a specialization into one of the three tracked disciplines (or null
 *  when it's something else — Design, PM, etc. — which the overview omits). */
function classify(spec: string): Discipline | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("qa") || s.includes("test") || s.includes("quality"))
    return "qa";
  if (s.includes("back") || s.includes("server") || s === "be")
    return "backend";
  if (
    s.includes("client") ||
    s.includes("front") ||
    s.includes("ui") ||
    s === "fe"
  )
    return "client";
  return null;
}

/** Height of one row of marker labels above the lanes. */
const MARKER_ROW_H = 16;

interface OverviewTimelineProps {
  assignments: Assignment[];
  range: GanttRange;
  /** Named dates drawn across every lane. Sorted by date. */
  markers?: PlanMarker[];
}

/**
 * A condensed, always-fits-the-screen summary of the plan. Each row is a
 * discipline (Backend / Client / QA) and every assignment of that discipline is
 * drawn as a bar positioned by percentage of the total range — so the entire
 * timeline is visible at once regardless of how long the project runs, with no
 * horizontal scrolling. Meant to sit above the detailed day-by-day Gantt.
 */
export function OverviewTimeline({
  assignments,
  range,
  markers = [],
}: OverviewTimelineProps) {
  const { rangeStart, todayIndex } = range;

  // Unlike the detailed Gantt (which pads a week past the end for breathing
  // room), the overview ends exactly on the last day of work — no trailing
  // empty space — unless a marker falls later, when it ends on that marker.
  // Everything below scales to this trimmed span.
  const finishDays = Math.max(
    diffDays(rangeStart, fromISO(range.rangeEnd)) + 1,
    1,
  );
  const shownMarkers = markers.filter((m) => m.date >= toISO(rangeStart));
  const totalDays = shownMarkers.reduce(
    (max, m) => Math.max(max, diffDays(rangeStart, fromISO(m.date)) + 1),
    finishDays,
  );
  const dates = Array.from({ length: totalDays }, (_, i) =>
    addDays(rangeStart, i),
  );

  // Day the mouse is currently over (null when outside the tracks). Drives the
  // vertical cursor line and the floating date label, like the detailed Gantt.
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  // Measured pixel width of the tracks (the header matches it). Weekly tick
  // labels are placed by percentage, but collision with the right-anchored
  // end-date label is a pixel problem — a fixed day-count can't be right for
  // both a 2-week plan and a 6-month one — so we thin ticks against real width.
  const headerRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => setTrackW(el.clientWidth);
    update();
    // ResizeObserver is universal in browsers but absent in jsdom/SSR; the
    // single measure above still gives a correct initial layout without it.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Whether weekly tick index `i` clears the end-date label. The end label is
  // right-anchored (occupies ~one label width at the far right) and each tick
  // is left-anchored, so a tick needs ~two label widths of clearance. Until the
  // width is measured, keep every tick (the layout effect corrects before paint).
  const finishX = (finishDays / totalDays) * trackW;
  const clearsEnd = (i: number) => {
    if (trackW === 0) return true;
    const x = (i / totalDays) * trackW;
    return x <= finishX - LABEL_EST_PX * 2 || x >= finishX + 4;
  };

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const trackWidth = rect.width - LABEL_W;
    const rel = e.clientX - rect.left - LABEL_W;
    if (rel < 0 || rel > trackWidth || trackWidth <= 0) {
      setHoverDay(null);
      return;
    }
    const day = Math.floor((rel / trackWidth) * totalDays);
    setHoverDay(day >= 0 && day < totalDays ? day : null);
  }

  // Group assignments into discipline buckets, keeping only the three we track.
  const byLane = new Map<Discipline, Assignment[]>();
  for (const a of assignments) {
    const lane = classify(a.specialization);
    if (!lane) continue;
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane)!.push(a);
  }

  const lanes = LANES.filter((l) => byLane.has(l.key));
  if (lanes.length === 0) return null;

  const pct = (days: number) => (days / totalDays) * 100;

  // Marker labels sit in their own strip above the lanes, stacked into rows
  // when they would overlap (measured against the real track width).
  const placedMarkers = shownMarkers.map((m) => {
    const at = pct(diffDays(rangeStart, fromISO(m.date)) + 0.5);
    const x = (at / 100) * trackW;
    const width = trackW === 0 ? 0 : markerLabelWidth(m.name) - 12;
    // A label that would run off the right edge sits left of its line.
    return { marker: m, at, x, width, flip: x + width > trackW };
  });
  const markerLevels = stackLabels(
    placedMarkers.map(({ x, width, flip }) => ({
      x: flip ? x - width : x,
      width,
    })),
  );
  const markerRows =
    placedMarkers.length > 0 ? Math.max(...markerLevels) + 1 : 0;

  return (
    <div className="overview-timeline">
      <div className="overview-title">Overview — Backend · Client · QA</div>
      <div
        className="overview-grid"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverDay(null)}
      >
        {/* Hover cursor line + date, spanning every lane. Offset by the label
            column so it lines up with the tracks. */}
        {hoverDay !== null && (
          <div className="overview-hover" style={{ left: LABEL_W }}>
            <div
              className="overview-hoverline"
              style={{ left: `${pct(hoverDay + 0.5)}%` }}
            />
            <div
              className="overview-hoverdate"
              style={{ left: `${pct(hoverDay + 0.5)}%` }}
            >
              {formatHoverDate(dates[hoverDay])}
            </div>
          </div>
        )}

        {/* Month markers across the top, aligned to the lanes below. Weekly
            ticks that would collide with the end-date label pinned to the right
            edge are dropped (measured against the real track width). */}
        <div className="overview-header" ref={headerRef}>
          {dates.map((d, i) =>
            i === 0 || (d.getDay() === 1 && clearsEnd(i)) ? (
              <span
                key={i}
                className="overview-datelabel"
                style={{ left: `${pct(i)}%` }}
              >
                {formatShortDate(toISO(d))}
              </span>
            ) : null,
          )}
          {/* The plan's actual last day, right-anchored to the end of the track.
              Without this the final label falls on the last Monday, leaving the
              real finish (a few days later) unlabelled. */}
          <span
            className="overview-datelabel end"
            style={{ left: `${pct(finishDays)}%` }}
          >
            {formatShortDate(range.rangeEnd)}
          </span>
        </div>

        {markerRows > 0 && (
          <div
            className="overview-markers"
            style={{ height: markerRows * MARKER_ROW_H }}
          >
            {placedMarkers.map(({ marker, at, flip }, i) => (
              <span
                key={marker.id}
                className={"overview-markerlabel" + (flip ? " flip" : "")}
                style={{ left: `${at}%`, top: markerLevels[i] * MARKER_ROW_H }}
                title={`${marker.name} · ${formatHoverDate(fromISO(marker.date))}`}
              >
                {marker.name}
              </span>
            ))}
          </div>
        )}

        {lanes.map(({ key, label }) => (
          <div className="overview-row" key={key}>
            <div className="overview-label">{label}</div>
            <div className="overview-track">
              {byLane.get(key)!.map((a) => {
                const startOff = diffDays(rangeStart, fromISO(a.start));
                const span = diffDays(fromISO(a.start), fromISO(a.end)) + 1;
                return (
                  <div
                    key={a.taskId}
                    className="overview-bar"
                    style={{
                      left: `${pct(startOff)}%`,
                      width: `${pct(span)}%`,
                      ["--bar" as string]: colorFor(a.specialization),
                    }}
                    title={`${a.taskName} (${a.epicName})\n${a.memberName} · ${a.start} → ${a.end} · ${a.estimateDays}d`}
                  />
                );
              })}
              {placedMarkers.map(({ marker, at }) => (
                <div
                  key={marker.id}
                  className="overview-markerline"
                  style={{ left: `${at}%` }}
                />
              ))}
              {todayIndex >= 0 && todayIndex <= totalDays && (
                <div
                  className="overview-todayline"
                  style={{ left: `${pct(todayIndex)}%` }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
