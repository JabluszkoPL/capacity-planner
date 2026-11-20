import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Assignment } from "@planner/core";
import { computeGanttRange } from "./DateGrid";
import { GanttByPerson } from "./GanttByPerson";

function assignment(over: Partial<Assignment>): Assignment {
  return {
    taskId: "t1",
    taskName: "T1",
    epicId: "e1",
    epicName: "E1",
    specialization: "FE",
    estimateDays: 3,
    workDays: 3,
    memberId: "m1",
    memberName: "Alice",
    start: "2026-07-27",
    end: "2026-07-29",
    ...over,
  };
}

const team = {
  members: [{ id: "m1", name: "Alice", specialization: "FE" }],
  offDays: {},
};

describe("GanttByPerson utilization", () => {
  it("computes assigned ÷ working-days available in the visible range", () => {
    const assignments = [assignment({})]; // 3 workdays
    const range = computeGanttRange("2026-07-27", assignments);
    // 14-day window from Mon Jul 27 has 10 weekdays; 3/10 = 30%.
    const { container } = render(
      <GanttByPerson assignments={assignments} team={team} range={range} />,
    );
    // "3d" also labels the bar itself; the utilization row has its own.
    expect(container.querySelector(".util-days")).toHaveTextContent("3d");
    const fill = container.querySelector(".util-bar-fg") as HTMLElement;
    expect(fill.style.width).toBe("30%");
  });

  it("caps utilization at 100%", () => {
    const assignments = [assignment({ estimateDays: 20 })];
    const range = computeGanttRange("2026-07-27", assignments);
    const { container } = render(
      <GanttByPerson assignments={assignments} team={team} range={range} />,
    );
    const fill = container.querySelector(".util-bar-fg") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("only lists members that have assigned work", () => {
    const twoMemberTeam = {
      members: [
        { id: "m1", name: "Alice", specialization: "FE" },
        { id: "m2", name: "Idle Ivan", specialization: "BE" },
      ],
      offDays: {},
    };
    const assignments = [assignment({})];
    const range = computeGanttRange("2026-07-27", assignments);
    render(
      <GanttByPerson
        assignments={assignments}
        team={twoMemberTeam}
        range={range}
      />,
    );
    expect(screen.queryByText("Idle Ivan")).not.toBeInTheDocument();
  });
});
