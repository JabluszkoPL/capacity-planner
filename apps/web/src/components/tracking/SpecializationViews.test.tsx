// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SpecializationStatus, TrackerStatus } from "@planner/core";
import { StatusPanel } from "./StatusPanel";
import { SPEC_VIEWS } from "./SpecializationViews";

const row = (over: Partial<SpecializationStatus>): SpecializationStatus => ({
  specialization: "Client",
  kind: "on-plan",
  plannedDays: 30,
  earnedDays: 30,
  totalDays: 100,
  varianceDays: 0,
  firstStart: "2026-09-07",
  unbufferedEnd: "2026-11-27",
  projectedFinish: "2026-11-27",
  marginDays: 20,
  bufferDays: 20,
  unestimatedTasks: 0,
  ...over,
});

function status(): TrackerStatus {
  return {
    kind: "using-buffer",
    today: "2026-09-21",
    plannedDays: 60,
    earnedDays: 50,
    varianceDays: -5,
    bufferDays: 20,
    bufferUsedDays: 5,
    overrunDays: 0,
    effortBufferDays: 17,
    roundingBufferDays: 1.5,
    unbufferedEnd: "2026-11-27",
    bufferedEnd: "2026-12-25",
    projectedFinish: "2026-12-04",
    marginDays: 15,
    jiraSetDays: 118,
    jiraSpentDays: 41,
    jiraRemainingDays: 61,
    planRemainingDays: 68,
    deadline: "2026-12-25",
    deadlineKind: "end",
    deadlines: null,
    scope: "all",
    window: null,
    bySpecialization: [
      row({
        specialization: "Backend",
        kind: "late",
        earnedDays: 10,
        varianceDays: -25,
        projectedFinish: "2027-01-08",
        marginDays: -10,
        unestimatedTasks: 2,
      }),
      row({}),
    ],
  };
}

afterEach(() => localStorage.clear());

describe("specialization views", () => {
  it("starts on the table", () => {
    render(<StatusPanel status={status()} />);
    expect(screen.getByRole("radio", { name: "Table" })).toBeChecked();
    expect(screen.getByRole("row", { name: /^Backend/ })).toBeInTheDocument();
  });

  it.each(SPEC_VIEWS.filter((v) => v.id !== "table"))(
    "$label keeps every verdict in words",
    ({ label }) => {
      render(<StatusPanel status={status()} />);
      fireEvent.click(screen.getByRole("radio", { name: label }));
      expect(screen.getByRole("radio", { name: label })).toBeChecked();
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByText(/10 days late for the end date/)).toBeVisible();
      expect(screen.getByText("On time")).toBeVisible();
    },
  );

  it("draws each specialization as a described image on the timeline", () => {
    render(<StatusPanel status={status()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Timeline" }));
    expect(
      screen.getByRole("img", {
        name: /^Backend: .*projected finish 2027-01-08; end date 2026-12-25; 10 days late$/,
      }),
    ).toBeInTheDocument();
  });

  it("remembers the picked view on this device", () => {
    const { unmount } = render(<StatusPanel status={status()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    unmount();
    render(<StatusPanel status={status()} />);
    expect(screen.getByRole("radio", { name: "Cards" })).toBeChecked();
    expect(
      screen.getByText("2 tasks without an estimate — not counted yet"),
    ).toBeInTheDocument();
  });
});
