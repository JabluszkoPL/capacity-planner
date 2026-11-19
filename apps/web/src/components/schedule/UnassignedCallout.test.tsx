import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UnassignedTask } from "@planner/core";
import { UnassignedCallout } from "./UnassignedCallout";

const task = (over: Partial<UnassignedTask> = {}): UnassignedTask => ({
  id: "t1",
  name: "Deploy",
  estimateDays: 1,
  specialization: "DevOps",
  excluded: false,
  epicId: "e1",
  epicName: "Ops",
  reason: 'No team member with specialization "DevOps"',
  ...over,
});

describe("UnassignedCallout", () => {
  it("renders nothing when there are no unassigned tasks", () => {
    const { container } = render(<UnassignedCallout unassigned={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists each unassigned task with its epic and reason", () => {
    render(<UnassignedCallout unassigned={[task()]} />);
    expect(
      screen.getByText(/1 task could not be scheduled/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Ops \/ Deploy — No team member with specialization "DevOps"/,
      ),
    ).toBeInTheDocument();
  });
});
