import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type {
  JiraEpic,
  JiraSnapshot,
  Project,
  SprintDraft,
  Team,
  Tracker,
} from "@planner/core";
import { ToastProvider } from "../ui/Toast";
import { SprintPlanner } from "./SprintPlanner";

vi.mock("../../lib/jiraTransport", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/jiraTransport")
  >("../../lib/jiraTransport");
  return {
    ...actual,
    createJiraTransport: () => ({
      kind: "none" as const,
      description: "nowhere",
      canWrite: false,
      request: vi.fn(),
    }),
  };
});

const h = (n: number) => n * 3600;

function child(key: string, summary: string, remainingHours: number) {
  return {
    key,
    summary,
    issueType: "Story",
    status: "To Do",
    statusCategory: "new" as const,
    updated: "2026-09-13T09:00:00.000Z",
    originalEstimateSec: h(remainingHours),
    remainingEstimateSec: h(remainingHours),
    timeSpentSec: 0,
  };
}

function snapshot(): JiraSnapshot {
  const epic: JiraEpic = {
    key: "ACME-10",
    summary: "Meta loop",
    issueType: "Epic",
    status: "In Progress",
    statusCategory: "indeterminate",
    updated: "2026-09-13T09:00:00.000Z",
    children: [
      child("ACME-101", "Quest board", 16),
      child("ACME-102", "Quest rewards", 16),
      child("ACME-103", "Daily streaks", 16),
    ],
    totals: {
      originalSec: h(48),
      spentSec: 0,
      remainingSec: h(48),
      done: 0,
      all: 3,
    },
  };
  return {
    fetchedAt: "2026-09-13T10:00:00.000Z",
    fieldIds: {},
    initiative: {
      key: "ACME-1",
      summary: "Season 4",
      issueType: "Initiative",
      status: "In Progress",
      statusCategory: "indeterminate",
      updated: "2026-09-13T09:00:00.000Z",
    },
    epics: [epic],
  };
}

const teams: Team[] = [
  {
    id: "team1",
    name: "Core",
    members: [
      { id: "m1", name: "Ada Lovelace", specialization: "client" },
      { id: "m2", name: "Grace Hopper", specialization: "server" },
    ],
    offDays: {},
  },
];

function project(): Project {
  return {
    id: "p1",
    name: "Season 4",
    startDate: "2026-09-07",
    planViewMode: "person",
    plan: null,
    epics: [{ id: "e-meta", name: "Meta loop", tasks: [] }],
  };
}

/** A tracker already holding a draft: two rows for one person, one for another. */
function tracker(draft?: SprintDraft): Tracker {
  return {
    id: "tr1",
    name: "Season 4",
    initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
    initiativeKey: "ACME-1",
    baseUrl: "https://acme.atlassian.net",
    projectId: "p1",
    epicMap: { "ACME-10": "e-meta" },
    snapshot: snapshot(),
    ...(draft ? { sprintDraft: draft } : {}),
  };
}

const twoForOnePerson: SprintDraft = {
  start: "2026-09-21", // a Monday
  end: "2026-10-02",
  items: [
    {
      issueKey: "ACME-101",
      memberId: "m1",
      estimateDays: 2,
      start: "2026-09-21",
    },
    {
      issueKey: "ACME-102",
      memberId: "m1",
      estimateDays: 2,
      start: "2026-09-21",
    },
    {
      issueKey: "ACME-103",
      memberId: "m2",
      estimateDays: 2,
      start: "2026-09-21",
    },
  ],
};

function renderPlanner(t: Tracker, onChange = vi.fn()) {
  render(
    <ToastProvider>
      <SprintPlanner
        tracker={t}
        snapshot={t.snapshot!}
        project={project()}
        teams={teams}
        hoursPerDay={8}
        onChange={onChange}
      />
    </ToastProvider>,
  );
  return onChange;
}

describe("SprintPlanner", () => {
  beforeEach(() => localStorage.clear());

  it("lists the open issues grouped by epic", () => {
    renderPlanner(tracker());
    expect(screen.getByText("ACME-10 · Meta loop")).toBeInTheDocument();
    expect(screen.getByText("Quest board")).toBeInTheDocument();
  });

  it("seeds a new row from Jira's remaining estimate", () => {
    const onChange = renderPlanner(tracker());
    fireEvent.click(screen.getAllByRole("checkbox")[1]); // first issue
    const draft = onChange.mock.calls[0][0] as SprintDraft;
    expect(draft.items).toHaveLength(1);
    // 16h remaining at 8h/day.
    expect(draft.items[0].estimateDays).toBe(2);
    expect(draft.items[0].start).toBe(draft.start);
  });

  it("computes each row's due date from its start, estimate and the calendar", () => {
    renderPlanner(tracker(twoForOnePerson));
    const rows = screen.getAllByRole("row").slice(1);
    // Mon 21 Sep + 2 working days ends Tue 22 Sep.
    expect(rows[0]).toHaveTextContent("2026-09-22");
  });

  it("auto-stack moves a person's second row after their first", () => {
    const onChange = renderPlanner(tracker(twoForOnePerson));
    fireEvent.click(
      screen.getByRole("button", { name: "Auto-stack per person" }),
    );

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as SprintDraft;
    const starts = Object.fromEntries(
      next.items.map((i) => [i.issueKey, i.start]),
    );
    expect(starts["ACME-101"]).toBe("2026-09-21");
    // Ada's second row starts the working day after her first one ends.
    expect(starts["ACME-102"]).toBe("2026-09-23");
    // Grace is independent of Ada.
    expect(starts["ACME-103"]).toBe("2026-09-21");
  });

  it("clears the draft entirely", () => {
    const onChange = renderPlanner(tracker(twoForOnePerson));
    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("flags a row with nobody on it", () => {
    renderPlanner(
      tracker({
        ...twoForOnePerson,
        items: [{ issueKey: "ACME-101", estimateDays: 2, start: "2026-09-21" }],
      }),
    );
    expect(screen.getByText("No assignee")).toBeInTheDocument();
  });

  it("flags a row that runs past the end of the sprint", () => {
    renderPlanner(
      tracker({
        start: "2026-09-21",
        end: "2026-09-25",
        items: [
          {
            issueKey: "ACME-101",
            memberId: "m1",
            estimateDays: 10,
            start: "2026-09-21",
          },
        ],
      }),
    );
    expect(screen.getByText("Won't finish in sprint")).toBeInTheDocument();
  });

  it("warns when someone is booked past their capacity", () => {
    renderPlanner(
      tracker({
        start: "2026-09-21",
        end: "2026-10-02", // 10 working days
        items: [
          {
            issueKey: "ACME-101",
            memberId: "m1",
            estimateDays: 12,
            start: "2026-09-21",
          },
        ],
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /Over capacity: Ada Lovelace by 2 d/,
    );
  });
});
