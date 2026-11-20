import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { type Assignment, fromISO } from "@planner/core";

import {
  COL_WIDTH,
  DateGrid,
  computeGanttRange,
  formatShortDate,
  stackLabels,
  type GanttRange,
} from "./DateGrid";

function assignment(over: Partial<Assignment>): Assignment {
  return {
    taskId: "t1",
    taskName: "T1",
    epicId: "e1",
    epicName: "E1",
    specialization: "FE",
    estimateDays: 2,
    workDays: 2,
    memberId: "m1",
    memberName: "Alice",
    start: "2026-07-27",
    end: "2026-07-28",
    ...over,
  };
}

describe("computeGanttRange", () => {
  it("spans from the project start with padding, min 14 days", () => {
    const r = computeGanttRange("2026-07-27", [
      assignment({ end: "2026-08-05" }),
    ]);
    expect(r.rangeEnd).toBe("2026-08-05");
    // diffDays(Jul27, Aug5) = 9, +8 = 17.
    expect(r.totalDays).toBe(17);
    expect(r.dates).toHaveLength(17);
  });

  it("stretches to a marker after the finish, keeping the plan's end", () => {
    const r = computeGanttRange(
      "2026-07-27",
      [assignment({ end: "2026-08-05" })],
      [{ id: "mk", name: "Beta gate", date: "2026-08-20" }],
    );
    expect(r.rangeEnd).toBe("2026-08-05");
    // diffDays(Jul27, Aug20) = 24, +8 = 32.
    expect(r.totalDays).toBe(32);
  });

  it("enforces the 14-day minimum for short plans", () => {
    const r = computeGanttRange("2026-07-27", [
      assignment({ end: "2026-07-28" }),
    ]);
    expect(r.totalDays).toBe(14);
  });
});

describe("stackLabels", () => {
  it("keeps apart labels on one row and stacks overlapping ones", () => {
    expect(
      stackLabels([
        { x: 0, width: 50 },
        { x: 30, width: 50 }, // overlaps the first
        { x: 60, width: 20 }, // clears the first
        { x: 100, width: 20 },
      ]),
    ).toEqual([0, 1, 0, 0]);
  });
});

describe("formatShortDate", () => {
  it("formats an ISO date as 'Mon D'", () => {
    expect(formatShortDate("2026-07-29")).toBe("Jul 29");
  });
});

describe("DateGrid", () => {
  const range: GanttRange = {
    rangeStart: fromISO("2026-07-27"), // Monday
    rangeEnd: "2026-08-02",
    totalDays: 7,
    dates: Array.from({ length: 7 }, (_, i) =>
      fromISO(
        [
          "2026-07-27",
          "2026-07-28",
          "2026-07-29",
          "2026-07-30",
          "2026-07-31",
          "2026-08-01",
          "2026-08-02",
        ][i],
      ),
    ),
    todayIndex: 2,
  };

  it("shades weekends and off-days with visually distinct classes", () => {
    const { container } = render(
      <DateGrid
        range={range}
        colWidth={COL_WIDTH}
        labelWidth={130}
        rows={[
          {
            key: "r1",
            label: "Row",
            offDays: new Set(["2026-07-29"]), // a weekday off
            bars: null,
          },
        ]}
      />,
    );
    // Sat 08-01 + Sun 08-02 are weekend cells.
    expect(container.querySelectorAll(".gantt-bgcell.weekend")).toHaveLength(2);
    // The personal off-day uses the distinct 'nonwork' treatment.
    expect(container.querySelectorAll(".gantt-bgcell.nonwork")).toHaveLength(1);
  });

  it("positions the today marker using labelWidth + todayIndex*colWidth", () => {
    const { container } = render(
      <DateGrid
        range={range}
        colWidth={COL_WIDTH}
        labelWidth={130}
        rows={[{ key: "r1", label: "Row", offDays: new Set(), bars: null }]}
      />,
    );
    const line = container.querySelector(".gantt-todayline") as HTMLElement;
    expect(line).toBeTruthy();
    expect(line.style.left).toBe(`${130 + 2 * COL_WIDTH}px`);
  });

  it("labels today in the header and names the label column", () => {
    const { container, getByText } = render(
      <DateGrid
        range={range}
        colWidth={COL_WIDTH}
        labelWidth={130}
        corner="Person"
        rows={[{ key: "r1", label: "Row", offDays: new Set(), bars: null }]}
      />,
    );
    const label = getByText("Today");
    // Centred over today's column.
    expect(label.style.left).toBe(`${130 + 2 * COL_WIDTH + COL_WIDTH / 2}px`);
    expect(container.querySelector(".gantt-corner")).toHaveTextContent(
      "Person",
    );
    expect(getByText("Jul 2026")).toBeInTheDocument();
    // 18px columns are wide enough to number every day.
    expect(container.querySelectorAll(".gantt-daylabel")).toHaveLength(7);
    expect(container.querySelector(".gantt-daylabel.today")).toHaveTextContent(
      "29",
    );
  });

  it("draws each marker in range as a line with a label", () => {
    const { container, getByText, queryByText } = render(
      <DateGrid
        range={range}
        colWidth={COL_WIDTH}
        labelWidth={130}
        rows={[{ key: "r1", label: "Row", offDays: new Set(), bars: null }]}
        markers={[
          { id: "a", name: "Alpha gate", date: "2026-07-28" },
          { id: "z", name: "Too late", date: "2026-09-01" },
        ]}
      />,
    );
    const lines = container.querySelectorAll(".gantt-markerline");
    expect(lines).toHaveLength(1);
    // Centred on its day's column.
    expect((lines[0] as HTMLElement).style.left).toBe(
      `${130 + 1 * COL_WIDTH + COL_WIDTH / 2}px`,
    );
    expect(getByText("Alpha gate")).toBeInTheDocument();
    expect(queryByText("Too late")).toBeNull();
  });
});
