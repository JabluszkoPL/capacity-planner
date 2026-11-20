// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { JiraIssue, Project, Team, Tracker } from "@planner/core";
import { AutoSprintPlanner, nextMonday } from "./AutoSprintPlanner";
import { SprintSection } from "./SprintSection";

const TEAMS: Team[] = [
  {
    id: "team1",
    name: "Core",
    members: [{ id: "m1", name: "Ana", specialization: "dev" }],
    offDays: {},
  },
];

const PROJECT: Project = {
  id: "p1",
  name: "Atlas",
  startDate: "2026-11-02",
  plan: null,
  planViewMode: "person",
  buffer: 20,
  epics: [
    {
      id: "e1",
      name: "Alpha",
      tasks: [
        {
          id: "t1",
          name: "Wallet",
          estimateDays: 4,
          specialization: "dev",
          excluded: false,
        },
        {
          id: "t2",
          name: "Popup",
          estimateDays: 0,
          specialization: "dev",
          excluded: false,
        },
      ],
    },
  ],
};

const issue = (key: string): JiraIssue => ({
  key,
  summary: key,
  issueType: "Task",
  status: "To Do",
  statusCategory: "new",
  updated: "2026-11-19T09:00:00.000Z",
});

const TRACKER: Tracker = {
  id: "tr1",
  name: "Atlas tracking",
  initiativeUrl: "https://acme.atlassian.net/browse/ATL-1",
  initiativeKey: "ATL-1",
  baseUrl: "https://acme.atlassian.net",
  projectId: "p1",
  epicMap: { "J-E": "e1" },
  taskMap: { "J-1": "t1", "J-2": "t2" },
  snapshot: {
    fetchedAt: "2026-11-19T09:00:00.000Z",
    initiative: { ...issue("ATL-1"), statusCategory: "indeterminate" },
    epics: [
      {
        ...issue("J-E"),
        issueType: "Epic",
        children: [issue("J-1"), issue("J-2")],
        totals: {
          originalSec: 0,
          spentSec: 0,
          remainingSec: 0,
          done: 0,
          all: 2,
        },
      },
    ],
    fieldIds: {},
  },
};

const renderPlanner = () =>
  render(
    <AutoSprintPlanner
      tracker={TRACKER}
      project={PROJECT}
      teams={TEAMS}
      today="2026-11-19"
    />,
  );

describe("AutoSprintPlanner", () => {
  it("starts on the next Monday", () => {
    expect(nextMonday("2026-11-19")).toBe("2026-11-23"); // Thursday
    expect(nextMonday("2026-11-23")).toBe("2026-11-23"); // Monday
    expect(nextMonday("2026-11-22")).toBe("2026-11-23"); // Sunday
  });

  it("plans the sprints on demand, and says how many and when they end", () => {
    renderPlanner();
    expect(screen.getByLabelText("First sprint starts")).toHaveValue(
      "2026-11-23",
    );
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.change(screen.getByLabelText("Sprint length"), {
      target: { value: "1" },
    });
    // Two of five days: the 4-day task takes ten working days.
    fireEvent.change(screen.getByLabelText(/Days per person per sprint/), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Plan sprints" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "2 sprints: the last ends 2026-12-04, and all the work is done by 2026-12-04. Each person counts 2 of 5 days per sprint.",
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows.slice(1).map((r) => r.textContent)).toEqual([
      "Sprint 12026-11-232026-11-2700",
      "Sprint 22026-11-302026-12-0414",
    ]);
    expect(screen.getByRole("note")).toHaveTextContent(
      "1 task with no estimate is not planned, so the sprints may run longer.",
    );
    expect(screen.getByTitle(/Wallet/)).toBeInTheDocument();
  });

  it("can plan the tasks with no estimate too", () => {
    renderPlanner();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Also plan tasks with no estimate, at",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Plan sprints" }));
    expect(screen.getByRole("note")).toHaveTextContent(
      "1 task with no estimate is planned at 1 d each (dotted outline).",
    );
    expect(screen.getByTitle(/Popup .*no estimate, assumed/s)).toHaveClass(
      "assumed",
    );
  });

  it("won't plan with more days per person than the sprint has", () => {
    renderPlanner();
    fireEvent.change(screen.getByLabelText(/Days per person per sprint/), {
      target: { value: "11" },
    });
    expect(screen.getByRole("button", { name: "Plan sprints" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "between 0.5 and 10 days per person",
    );
  });
});

describe("SprintSection", () => {
  it("shows one planner at a time, automatic first", () => {
    render(
      <SprintSection auto={<p>Automatic inside</p>}>
        <p>Manual inside</p>
      </SprintSection>,
    );
    expect(screen.getByText("Automatic inside")).toBeInTheDocument();
    expect(screen.queryByText("Manual inside")).toBeNull();
    const manual = screen.getByRole("radio", { name: "Manual" });
    expect(manual).toHaveAttribute("aria-checked", "false");
    fireEvent.click(manual);
    expect(screen.getByText("Manual inside")).toBeInTheDocument();
    expect(screen.queryByText("Automatic inside")).toBeNull();
    // Arrow keys move between the two, like any radio group.
    fireEvent.keyDown(manual, { key: "ArrowLeft" });
    expect(screen.getByText("Automatic inside")).toBeInTheDocument();
  });

  it("shows only the manual planner when there is no automatic one", () => {
    render(
      <SprintSection>
        <p>Manual inside</p>
      </SprintSection>,
    );
    expect(screen.getByText("Manual inside")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
