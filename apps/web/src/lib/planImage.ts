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
  const total = Math.max(diffDays(start, end) + 3, 7);
  const dates = Array.from({ length: total }, (_, i) => addDays(start, i));

  return {
    rows,
    dates,
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
  const { rows, dates, labelWidth, title } = layout;

  const titleH = 34;
  const gridW = labelWidth + dates.length * COL_W;
  const width = gridW + PAD * 2;
  const height = titleH + HEADER_H + rows.length * ROW_H + PAD * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(SCALE, SCALE);

  // Background.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const originX = PAD;
  const originY = PAD;

  // Title.
  ctx.fillStyle = "#0f172a";
  ctx.font = "600 16px system-ui, -apple-system, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(title, originX, originY + titleH / 2);

  const gridTop = originY + titleH;
  const tracksLeft = originX + labelWidth;
  const tracksTop = gridTop + HEADER_H;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = toISO(today);

  // Column background shading (weekends) + date labels.
  ctx.font = "10px system-ui, -apple-system, sans-serif";
  dates.forEach((d, i) => {
    const x = tracksLeft + i * COL_W;
    if (isWeekend(d)) {
      ctx.fillStyle = "#f1f4f8";
      ctx.fillRect(x, tracksTop, COL_W, rows.length * ROW_H);
    }
    if (i === 0 || d.getDay() === 1) {
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(x, gridTop, 1, HEADER_H + rows.length * ROW_H);
      ctx.fillStyle = "#64748b";
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
        ctx.fillStyle = "#fbeaea";
        ctx.fillRect(tracksLeft + i * COL_W, y, COL_W, ROW_H);
      }
    });

    // Row separator.
    ctx.fillStyle = "#eef1f5";
    ctx.fillRect(originX, y + ROW_H - 1, gridW, 1);

    // Left accent + label.
    ctx.fillStyle = row.borderColor;
    ctx.fillRect(originX, y, 3, ROW_H);
    ctx.fillStyle = "#0f172a";
    ctx.textBaseline = "middle";
    ctx.font = "600 12px system-ui, -apple-system, sans-serif";
    ctx.fillText(
      clip(ctx, row.title, labelWidth - 14),
      originX + 8,
      y + (row.subtitle ? ROW_H / 2 - 8 : ROW_H / 2),
    );
    if (row.subtitle) {
      ctx.fillStyle = "#64748b";
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
      ctx.fillStyle = bar.color;
      ctx.fill();
      ctx.fillStyle = "#ffffff";
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
    ctx.fillStyle = "#e03131";
    ctx.fillRect(x, gridTop, 2, HEADER_H + rows.length * ROW_H);
  }

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
