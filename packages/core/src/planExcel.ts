/**
 * Build an Excel workbook from a project's plan.
 *
 * Tabs:
 *  - Assignments — the flat schedule table (one row per assigned task).
 *  - By Person   — a date grid, one row per assignee, bars colored by spec.
 *  - By Task      — a date grid, one row per task.
 *  - Unassigned   — only when the plan has unassigned tasks.
 */
import type { Project, TeamMember } from "./types";
import { addDays, diffDays, fromISO, isWeekend, toISO } from "./dates";
import { epicRows, personRows, taskRows, type TimelineRow } from "./planLayout";
import type { Workbook, XlsxCellInput, XlsxSheet } from "./xlsx";

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

const HEADER_FILL = "1E293B";
const HEADER_COLOR = "FFFFFF";
const WEEKEND_FILL = "EEF1F5";

function shortDate(iso: string): string {
  const d = fromISO(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function headerCell(value: string): XlsxCellInput {
  return { value, bold: true, fill: HEADER_FILL, color: HEADER_COLOR };
}

/** The full inclusive date span covered by a plan's assignments. */
function planDates(project: Project): Date[] {
  const plan = project.plan;
  if (!plan || plan.assignments.length === 0) return [];
  const start = fromISO(project.startDate);
  let end = start;
  for (const a of plan.assignments) {
    const e = fromISO(a.end);
    if (e > end) end = e;
  }
  const total = Math.max(diffDays(start, end) + 1, 1);
  return Array.from({ length: total }, (_, i) => addDays(start, i));
}

function assignmentsSheet(project: Project): XlsxSheet {
  const rows: XlsxCellInput[][] = [
    ["Task", "Epic", "Assignee", "Specialization", "Days", "Start", "End"].map(
      headerCell,
    ),
  ];
  const sorted = project
    .plan!.assignments.slice()
    .sort((a, b) => a.start.localeCompare(b.start));
  for (const a of sorted) {
    rows.push([
      a.taskName,
      a.epicName,
      a.memberName,
      a.specialization,
      a.estimateDays,
      shortDate(a.start),
      shortDate(a.end),
    ]);
  }
  return {
    name: "Assignments",
    freezeHeader: true,
    columns: [
      { width: 34 },
      { width: 22 },
      { width: 20 },
      { width: 16 },
      { width: 7 },
      { width: 11 },
      { width: 11 },
    ],
    rows,
  };
}

/**
 * A date-grid sheet: label columns on the left, then one column per day.
 * Two header rows — month labels, then day-of-month — matching the on-screen
 * Gantt. Cells within a bar's [start, end] are filled with the spec color;
 * other weekend/off-day cells get a light shade.
 */
function gridSheet(
  name: string,
  labelHeaders: string[],
  timelineRows: TimelineRow[],
  dates: Date[],
): XlsxSheet {
  const labelCount = labelHeaders.length;
  const dateISO = dates.map(toISO);

  // Row 1: month labels (only where a new month starts), spanning label cols.
  const monthRow: XlsxCellInput[] = labelHeaders.map(() => null);
  dates.forEach((d, i) => {
    const isFirst = i === 0 || d.getMonth() !== dates[i - 1].getMonth();
    monthRow.push(isFirst ? { value: MONTHS[d.getMonth()], bold: true } : null);
  });

  // Row 2: label headers + day-of-month numbers.
  const dayRow: XlsxCellInput[] = labelHeaders.map(headerCell);
  dates.forEach((d) => {
    dayRow.push({
      value: d.getDate(),
      bold: true,
      fill: HEADER_FILL,
      color: HEADER_COLOR,
      align: "center",
    });
  });

  const rows: XlsxCellInput[][] = [monthRow, dayRow];

  for (const r of timelineRows) {
    const labels: XlsxCellInput[] = [{ value: r.title }];
    if (labelCount > 1) labels.push({ value: r.subtitle ?? "" });

    const cells: XlsxCellInput[] = [...labels];
    for (let i = 0; i < dateISO.length; i++) {
      const iso = dateISO[i];
      const bar = r.bars.find((b) => iso >= b.start && iso <= b.end);
      if (bar) {
        cells.push({ value: null, fill: bar.color.replace(/^#/, "") });
      } else if (isWeekend(dates[i]) || r.offDays.has(iso)) {
        cells.push({ value: null, fill: WEEKEND_FILL });
      } else {
        cells.push(null);
      }
    }
    rows.push(cells);
  }

  const columns = [
    ...labelHeaders.map((_, i) => ({ width: i === 0 ? 30 : 22 })),
    ...dates.map(() => ({ width: 3 })),
  ];

  return { name, freezeHeader: false, columns, rows };
}

/** Build the full workbook for a project's plan. Assumes the plan exists. */
export function buildPlanWorkbook(
  project: Project,
  team: { members: TeamMember[]; offDays: Record<string, string[]> },
): Workbook {
  const plan = project.plan!;
  const dates = planDates(project);

  const sheets: XlsxSheet[] = [assignmentsSheet(project)];

  sheets.push(
    gridSheet(
      "By Person",
      ["Person"],
      personRows(plan.assignments, team.offDays),
      dates,
    ),
  );
  sheets.push(
    gridSheet(
      "By Task",
      ["Task", "Assignee · Epic"],
      taskRows(plan.assignments, project.epics, team.offDays),
      dates,
    ),
  );
  sheets.push(
    gridSheet(
      "By Epic",
      ["Epic", "Dates · Tasks"],
      epicRows(plan.assignments, project.epics, plan.unassigned),
      dates,
    ),
  );

  if (plan.unassigned.length > 0) {
    const rows: XlsxCellInput[][] = [
      ["Task", "Epic", "Specialization", "Days", "Reason"].map(headerCell),
    ];
    for (const u of plan.unassigned) {
      rows.push([
        u.name,
        u.epicName,
        u.specialization,
        u.estimateDays,
        u.reason,
      ]);
    }
    sheets.push({
      name: "Unassigned",
      freezeHeader: true,
      columns: [
        { width: 34 },
        { width: 22 },
        { width: 16 },
        { width: 7 },
        { width: 40 },
      ],
      rows,
    });
  }

  return { sheets };
}

/** A filesystem-safe, dated filename stem for a project export. */
export function planFilenameStem(project: Project): string {
  const now = new Date();
  const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const slug =
    project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "plan";
  return `${slug}-${stamp}`;
}
