import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Assignment } from "@planner/core";
import { AssignmentsTable } from "./AssignmentsTable";

const a = (over: Partial<Assignment>): Assignment => ({
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
});

describe("AssignmentsTable", () => {
  it("renders rows sorted by start date", () => {
    render(
      <AssignmentsTable
        assignments={[
          a({
            taskId: "t2",
            taskName: "Later",
            start: "2026-08-10",
            end: "2026-08-11",
          }),
          a({
            taskId: "t1",
            taskName: "Earlier",
            start: "2026-07-27",
            end: "2026-07-28",
          }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1); // drop header
    expect(within(rows[0]).getByText("Earlier")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Later")).toBeInTheDocument();
  });

  it("shows assignee, specialization and formatted dates", () => {
    render(
      <AssignmentsTable
        assignments={[a({ start: "2026-07-27", end: "2026-07-29" })]}
      />,
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("FE")).toBeInTheDocument();
    expect(screen.getByText("Jul 27")).toBeInTheDocument();
    expect(screen.getByText("Jul 29")).toBeInTheDocument();
  });
});
