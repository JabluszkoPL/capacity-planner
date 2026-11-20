/**
 * Render a project's timeline to a single wide PNG (the whole schedule, not
 * just the visible viewport) so it can be pasted into a doc or chat.
 *
 * Drawn straight to a canvas from the shared timeline model — no DOM capture,
 * so the output is the full width regardless of what's scrolled into view.
 */
import {
  addDays,
  diffDays,
  epicRows,
  fromISO,
  isWeekend,
  personRows,
  taskRows,
  toISO,
  visiblePlanMarkers,
  type PlanMarker,
  type PlanViewMode,
  type Project,
  type TeamMember,
  type TimelineRow,
} from "@planner/core";

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

// Layout constants (device-independent pixels; scaled up for crispness).
const COL_W = 26;
const ROW_H = 40;
const HEADER_H = 40;
const MARKER_ROW_H = 20;
const MARKER_COLOR = "#7a5aa6";
// The app's "Warm Focus" palette (styles/tokens.css), so a saved image looks
// like the screen it came from.
const C = {
  bg: "#fffdf8",
  text: "#2b2721",
  muted: "#7b7266",
  weekend: "#f5efe4",
  gridline: "#e5dccd",
  rowLine: "#efe7da",
  offDay: "#f6d6cb",
  today: "#bf4f3a",
};

/** Mix a #rrggbb colour toward another by `t` (0 = a, 1 = b). */
function mixHex(a: string, b: string, t: number): string {
  const parse = (h: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return a;
  const out = x.map((v, i) => Math.round(v + (y[i]! - v) * t));
  return "#" + out.map((v) => v.toString(16).padStart(2, "0")).join("");
}
const PAD = 16;
const SCALE = 2;

const VIEW_TITLES: Record<PlanViewMode, string> = {
  person: "By Person",
  task: "By Task",
  epic: "By Epic",
};

interface TimelineImageOptions {
  project: Project;
  team: { members: TeamMember[]; offDays: Record<string, string[]> };
  mode: PlanViewMode;
}

interface Layout {
  rows: TimelineRow[];
  dates: Date[];
  markers: PlanMarker[];
  labelWidth: number;
  title: string;
}

function buildLayout(opts: TimelineImageOptions): Layout | null {
  const { project, team, mode } = opts;
  const plan = project.plan;
  if (!plan || plan.assignments.length === 0) return null;

  const rows =
    mode === "person"
      ? personRows(plan.assignments, team.offDays)
      : mode === "epic"
        ? epicRows(plan.assignments, project.epics, plan.unassigned)
        : taskRows(plan.assignments, project.epics, team.offDays);

  const start = fromISO(project.startDate);
  let end = start;
  for (const a of plan.assignments) {
    const e = fromISO(a.end);
    if (e > end) end = e;
  }
  // Markers later than the finish stretch the image so they stay in it.
  const markers = visiblePlanMarkers(project).filter(
    (m) => fromISO(m.date) >= start,
  );
  for (const m of markers) {
    const d = fromISO(m.date);
    if (d > end) end = d;
  }
  const total = Math.max(diffDays(start, end) + 3, 7);
  const dates = Array.from({ length: total }, (_, i) => addDays(start, i));

  return {
    rows,
    dates,
    markers,
    labelWidth: mode === "person" ? 150 : 240,
    title: `${project.name} — ${VIEW_TITLES[mode]}`,
  };
}

/**
 * Draw the timeline onto a fresh canvas. Returns null when there's nothing to
 * draw (no plan / no assignments).
 */
export function renderTimelineCanvas(
  opts: TimelineImageOptions,
): HTMLCanvasElement | null {
  const layout = buildLayout(opts);
  if (!layout) return null;
  const { rows, dates, markers, labelWidth, title } = layout;

  const titleH = 34;
  const gridW = labelWidth + dates.length * COL_W;
  const width = gridW + PAD * 2;

  // Marker labels go in a strip under the date labels, stacked into rows
  // where they would overlap. Measured with the same font they draw in.
  const measure = document.createElement("canvas").getContext("2d");
  if (measure) measure.font = "600 11px system-ui, -apple-system, sans-serif";
  const markerX = (m: PlanMarker) =>
    diffDays(dates[0], fromISO(m.date)) * COL_W + COL_W / 2;
  const tracksW = dates.length * COL_W;
  const labelW = (m: PlanMarker) =>
    (measure?.measureText(m.name).width ?? m.name.length * 7) + 12;
  // A label that would run off the right edge sits left of its line.
  const flips = markers.map((m) => markerX(m) + labelW(m) > tracksW);
  const levelEnds: number[] = [];
  const markerLevels = markers.map((m, i) => {
    const w = labelW(m);
    const x = flips[i] ? markerX(m) - w : markerX(m);
    let level = levelEnds.findIndex((e) => e <= x);
    if (level === -1) level = levelEnds.length;
    levelEnds[level] = x + w + 4;
    return level;
  });
  const markersH = levelEnds.length * MARKER_ROW_H;
  const headerH = HEADER_H + markersH;
  const height = titleH + headerH + rows.length * ROW_H + PAD * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(SCALE, SCALE);

  // Background.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  const originX = PAD;
  const originY = PAD;

  // Title.
  ctx.fillStyle = C.text;
  ctx.font = '600 17px "Iowan Old Style", Charter, Georgia, serif';
  ctx.textBaseline = "middle";
  ctx.fillText(title, originX, originY + titleH / 2);

  const gridTop = originY + titleH;
  const tracksLeft = originX + labelWidth;
  const tracksTop = gridTop + headerH;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = toISO(today);

  // Column background shading (weekends) + date labels.
  ctx.font = "10px system-ui, -apple-system, sans-serif";
  dates.forEach((d, i) => {
    const x = tracksLeft + i * COL_W;
    if (isWeekend(d)) {
      ctx.fillStyle = C.weekend;
      ctx.fillRect(x, tracksTop, COL_W, rows.length * ROW_H);
    }
    if (i === 0 || d.getDay() === 1) {
      ctx.fillStyle = C.gridline;
      ctx.fillRect(x, gridTop, 1, headerH + rows.length * ROW_H);
      ctx.fillStyle = C.muted;
      ctx.textBaseline = "top";
      ctx.fillText(
        `${MONTHS[d.getMonth()]} ${d.getDate()}`,
        x + 3,
        gridTop + 6,
      );
    }
  });

  // Rows.
  rows.forEach((row, r) => {
    const y = tracksTop + r * ROW_H;
    const offDays = row.offDays;

    // Off-day shading for this row.
    dates.forEach((d, i) => {
      if (!isWeekend(d) && offDays.has(toISO(d))) {
        ctx.fillStyle = C.offDay;
        ctx.fillRect(tracksLeft + i * COL_W, y, COL_W, ROW_H);
      }
    });

    // Row separator.
    ctx.fillStyle = C.rowLine;
    ctx.fillRect(originX, y + ROW_H - 1, gridW, 1);

    // Left accent + label.
    ctx.fillStyle = row.borderColor;
    ctx.fillRect(originX, y, 3, ROW_H);
    ctx.fillStyle = C.text;
    ctx.textBaseline = "middle";
    ctx.font = "600 12px system-ui, -apple-system, sans-serif";
    ctx.fillText(
      clip(ctx, row.title, labelWidth - 14),
      originX + 8,
      y + (row.subtitle ? ROW_H / 2 - 8 : ROW_H / 2),
    );
    if (row.subtitle) {
      ctx.fillStyle = C.muted;
      ctx.font = "10px system-ui, -apple-system, sans-serif";
      ctx.fillText(
        clip(ctx, row.subtitle, labelWidth - 14),
        originX + 8,
        y + ROW_H / 2 + 8,
      );
    }

    // Bars.
    for (const bar of row.bars) {
      const startIdx = diffDays(dates[0], fromISO(bar.start));
      const span = diffDays(fromISO(bar.start), fromISO(bar.end)) + 1;
      const bx = tracksLeft + startIdx * COL_W;
      const bw = Math.max(span * COL_W - 3, COL_W - 3);
      const by = y + 5;
      const bh = ROW_H - 10;
      roundRect(ctx, bx, by, bw, bh, 5);
      // A light wash of the bar's colour with a firmer edge and dark text,
      // as the on-screen bars are drawn.
      ctx.fillStyle = mixHex(bar.color, "#ffffff", 0.8);
      ctx.fill();
      ctx.strokeStyle = mixHex(bar.color, "#ffffff", 0.55);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = mixHex(bar.color, "#000000", 0.35);
      ctx.font = "600 11px system-ui, -apple-system, sans-serif";
      // Person lanes name the task; task lanes name the assignee; epic rows
      // carry their task count in memberName.
      const barLabel = opts.mode === "person" ? bar.taskName : bar.memberName;
      ctx.fillText(clip(ctx, barLabel, bw - 12), bx + 6, by + bh / 2);
    }
  });

  // Today line.
  const todayIdx = dates.findIndex((d) => toISO(d) === todayISO);
  if (todayIdx >= 0) {
    const x = tracksLeft + todayIdx * COL_W;
    ctx.fillStyle = C.today;
    ctx.fillRect(x, gridTop, 2, headerH + rows.length * ROW_H);
  }

  // Markers: a dashed line down the tracks and a labelled flag above them.
  markers.forEach((m, i) => {
    const x = tracksLeft + markerX(m);
    const ly = gridTop + HEADER_H + markerLevels[i] * MARKER_ROW_H + 2;
    ctx.save();
    ctx.strokeStyle = MARKER_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x, tracksTop + rows.length * ROW_H);
    ctx.stroke();
    ctx.restore();

    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    const w = ctx.measureText(m.name).width + 12;
    const lx = flips[i] ? x - w + 1 : x - 1;
    ctx.fillStyle = MARKER_COLOR;
    roundRect(ctx, lx, ly, w, MARKER_ROW_H - 4, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(m.name, lx + 6, ly + (MARKER_ROW_H - 4) / 2);
  });

  return canvas;
}

function clip(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) {
    s = s.slice(0, -1);
  }
  return s + "…";
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** True when the current project/mode has a drawable timeline. */
export function canRenderTimeline(opts: TimelineImageOptions): boolean {
  const plan = opts.project.plan;
  return !!plan && plan.assignments.length > 0;
}

/**
 * Render the timeline and trigger a PNG download. Resolves once the download
 * has been kicked off; rejects if the canvas can't be produced.
 */
export function downloadTimelinePng(
  opts: TimelineImageOptions,
  filename: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const canvas = renderTimelineCanvas(opts);
    if (!canvas) {
      reject(new Error("There's no timeline to export yet."));
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Couldn't render the timeline image."));
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      resolve();
    }, "image/png");
  });
}
