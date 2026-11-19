import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { type Assignment, fromISO } from "@planner/core";

import {
  COL_WIDTH,
  DateGrid,
  computeGanttRange,
  formatShortDate,
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

  it("enforces the 14-day minimum for short plans", () => {
    const r = computeGanttRange("2026-07-27", [
      assignment({ end: "2026-07-28" }),
    ]);
    expect(r.totalDays).toBe(14);
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
});
