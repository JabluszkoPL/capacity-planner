// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  JiraIssue,
  Project,
  SpecializationStatus,
  Team,
  Tracker,
  TrackerStatus,
} from "@planner/core";
import { RemainingWorkPanel } from "./RemainingWorkPanel";

const TEAMS: Team[] = [
  {
    id: "team1",
    name: "Core",
    members: [
      { id: "m1", name: "Ana", specialization: "dev" },
      { id: "m2", name: "Bo", specialization: "dev" },
      { id: "m3", name: "Di", specialization: "design" },
    ],
    offDays: {},
  },
];

const task = (id: string, estimateDays: number) => ({
  id,
  name: `Task ${id}`,
  estimateDays,
  specialization: "dev",
  excluded: false,
});

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
      tasks: [task("t1", 2), task("t2", 3), task("t3", 0), task("t4", 1)],
    },
  ],
};

const issue = (
  key: string,
  status: string,
  statusCategory: JiraIssue["statusCategory"],
  over: Partial<JiraIssue> = {},
): JiraIssue => ({
  key,
  summary: key,
  issueType: "Task",
  status,
  statusCategory,
  updated: "2026-11-19T09:00:00.000Z",
  ...over,
});

const TRACKER: Tracker = {
  id: "tr1",
  name: "Atlas tracking",
  initiativeUrl: "https://acme.atlassian.net/browse/ATL-1",
  initiativeKey: "ATL-1",
  baseUrl: "https://acme.atlassian.net",
  projectId: "p1",
  epicMap: { "J-E": "e1" },
  taskMap: { "J-1": "t1", "J-2": "t2", "J-3": "t3", "J-4": "t4" },
  snapshot: {
    fetchedAt: "2026-11-19T09:00:00.000Z",
    initiative: issue("ATL-1", "In Progress", "indeterminate"),
    epics: [
      {
        ...issue("J-E", "In Progress", "indeterminate"),
        issueType: "Epic",
        children: [
          issue("J-1", "In Progress", "indeterminate", {
            assignee: { accountId: "a-bo", displayName: "Bo" },
          }),
          issue("J-2", "To Do", "new"),
          issue("J-3", "To Do", "new"),
          issue("J-4", "In Review", "indeterminate"),
        ],
        totals: {
          originalSec: 0,
          spentSec: 0,
          remainingSec: 0,
          done: 0,
          all: 4,
        },
      },
    ],
    fieldIds: {},
  },
};

const renderPanel = (status?: TrackerStatus) =>
  render(
    <RemainingWorkPanel
      tracker={TRACKER}
      project={PROJECT}
      teams={TEAMS}
      today="2026-11-19"
      status={status}
    />,
  );

describe("RemainingWorkPanel", () => {
  it("says who is on what, who takes what next, and when they are done", () => {
    renderPanel();
    const section = screen.getByRole("region", {
      name: "Work left, by person",
    });
    // Only To Do and In Progress: the task in review (J-4) is left out.
    expect(section).toHaveTextContent(
      "2 estimated tasks still open (5 plan days), laid out from today without buffer. All of it is done by 2026-11-23; Ana finishes last. 1 task nobody holds in Jira is given to whoever is free first (marked suggested).",
    );
    expect(section).toHaveTextContent(
      "Only tasks in To Do or In Progress are planned.",
    );
    expect(section).toHaveTextContent(
      "Left out: 1 task in review or ready to deploy (1 d) · 1 task without an estimate (J-3).",
    );

    // Each specialization together, under a heading of its own.
    const people = screen.getAllByRole("table")[0];
    expect(
      [...people.querySelectorAll("tbody tr")].map((r) =>
        r.classList.contains("forecast-group")
          ? r.textContent
          : within(r as HTMLElement).getByRole("rowheader").textContent,
      ),
    ).toEqual([
      "dev · 2 people · done by 2026-11-23",
      "Ana",
      "Bo",
      "design · 1 person · nothing planned",
      "Di",
    ]);

    const bo = screen.getByRole("row", { name: /^Bo/ });
    expect(within(bo).getByRole("link", { name: "J-1" })).toHaveAttribute(
      "href",
      "https://acme.atlassian.net/browse/J-1",
    );
    expect(bo).toHaveTextContent("Task t1 · until 2026-11-20");
    expect(bo).toHaveTextContent("nothing after it");

    const ana = screen.getByRole("row", { name: /^Ana/ });
    expect(ana).toHaveTextContent("J-2 Task t2 suggested");
    expect(ana).toHaveTextContent("3 d · 2026-11-19 → 2026-11-23");

    const di = screen.getByRole("row", { name: /^Di/ });
    expect(di).toHaveTextContent("nothing planned for them");
    expect(di).toHaveTextContent("free now");

    expect(screen.getByTitle(/in progress/)).toHaveTextContent("▶ Task t1");
    expect(screen.queryByTitle(/waiting to be closed/)).toBeNull();
    expect(screen.getByTitle(/J-2 .*suggested by the planner/s)).toHaveClass(
      "suggested",
    );
    expect(
      screen.getByRole("button", { name: "Fit to width" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("warns beside the chart that tasks with no estimate are not on it", () => {
    renderPanel();
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(
      "1 task has no estimate (J-3) and is not on the chart, so the work may take longer than shown.",
    );
    const zoom = screen.getByRole("group", { name: "Zoom" });
    expect(note.closest(".forecast-toolbar")).toBe(
      zoom.closest(".forecast-toolbar"),
    );
  });

  it("can plan the tasks with no estimate at the days typed in", () => {
    renderPanel();
    expect(screen.queryByTitle(/no estimate, assumed/)).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Also plan tasks with no estimate, at",
      }),
    );
    expect(
      screen.getByTitle(/Task t3 .*1 d \(no estimate, assumed\)/s),
    ).toHaveClass("assumed");
    expect(screen.getByRole("note")).toHaveTextContent(
      "1 task with no estimate is planned at 1 d each (dotted outline), so the real finish may differ.",
    );
    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "Days for each task with no estimate",
      }),
      { target: { value: "2.5" } },
    );
    expect(
      screen.getByTitle(/Task t3 .*2\.5 d \(no estimate, assumed\)/s),
    ).toBeInTheDocument();
    const section = screen.getByRole("region", {
      name: "Work left, by person",
    });
    expect(section).not.toHaveTextContent("without an estimate");
  });

  it("sets bugs apart on the chart, and names their priority", () => {
    const epic = TRACKER.snapshot!.epics[0];
    const tracker: Tracker = {
      ...TRACKER,
      snapshot: {
        ...TRACKER.snapshot!,
        epics: [
          {
            ...epic,
            children: epic.children.map((c) =>
              c.key === "J-2"
                ? { ...c, issueType: "Bug", priority: "High" }
                : c,
            ),
          },
        ],
      },
    };
    render(
      <RemainingWorkPanel
        tracker={tracker}
        project={PROJECT}
        teams={TEAMS}
        today="2026-11-19"
      />,
    );
    const bar = screen.getByTitle(/^J-2 Task t2/);
    expect(bar).toHaveClass("bug");
    expect(bar.title).toContain("Bug · High priority");
    expect(screen.getByTitle(/^J-1 Task t1/)).not.toHaveClass("bug");
  });

  it("puts the plan options beside the chart and the list under it", () => {
    renderPanel();
    const box = screen.getByRole("checkbox", {
      name: "Also plan tasks in review or ready to deploy (as the status counts them)",
    });
    const zoom = screen.getByRole("group", { name: "Zoom" });
    expect(box.closest(".forecast-toolbar")).toBe(
      zoom.closest(".forecast-toolbar"),
    );
    const chart = zoom.closest(".forecast-gantt")!;
    const table = screen.getByRole("columnheader", { name: "Person" });
    expect(
      chart.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("can plan the tasks in review too, as the status counts them", () => {
    renderPanel();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Also plan tasks in review or ready to deploy (as the status counts them)",
      }),
    );
    const section = screen.getByRole("region", {
      name: "Work left, by person",
    });
    expect(section).toHaveTextContent(
      "3 estimated tasks still open (6 plan days)",
    );
    expect(section).toHaveTextContent(
      "1 task waiting to be closed (⏸, 1 d) still counts as work at its whole estimate, as in the status.",
    );
    expect(screen.getByRole("row", { name: /^Bo/ })).toHaveTextContent(
      "J-4 Task t4 waiting to be closed suggested",
    );
    expect(screen.getByTitle(/waiting to be closed/)).toHaveTextContent(
      "⏸ Task t4",
    );
  });

  it("sets each finish beside the status's, and says why they differ", () => {
    const row = (
      specialization: string,
      projectedFinish: string,
    ): SpecializationStatus => ({
      specialization,
      kind: "behind",
      plannedDays: 0,
      earnedDays: 0,
      totalDays: 6,
      varianceDays: 0,
      firstStart: null,
      unbufferedEnd: null,
      projectedFinish,
      marginDays: 0,
      bufferDays: 0,
      unestimatedTasks: 0,
    });
    renderPanel({
      bySpecialization: [row("dev", "2026-11-25")],
      deadlines: null,
    } as unknown as TrackerStatus);
    const table = screen.getByRole("table", {
      name: "Compared with the status above",
    });
    const dev = within(table).getByRole("row", { name: /^dev/ });
    expect(dev).toHaveTextContent("2026-11-23");
    expect(dev).toHaveTextContent("2026-11-25");
    expect(dev).toHaveTextContent(
      "−1 d: 1 task in review or ready to deploy isn't planned here",
    );
    expect(dev).toHaveTextContent(/laid out task by task here/);
  });
});
