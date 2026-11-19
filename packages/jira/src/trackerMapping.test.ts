import { describe, it, expect } from "vitest";
import type {
  JiraEpic,
  JiraIssue,
  JiraSnapshot,
  Project,
  Team,
} from "@planner/core";
import { trackerMapping } from "./trackerMapping";

function issue(
  key: string,
  summary: string,
  extra: Partial<JiraIssue> = {},
): JiraIssue {
  return {
    key,
    summary,
    issueType: "Story",
    status: "To Do",
    statusCategory: "new",
    updated: "2026-09-01T00:00:00.000Z",
    ...extra,
  };
}

function epic(key: string, summary: string, children: JiraIssue[]): JiraEpic {
  return {
    ...issue(key, summary, { issueType: "Epic" }),
    children,
    totals: { originalSec: 0, spentSec: 0, remainingSec: 0, done: 0, all: 0 },
  };
}

function snapshotOf(epics: JiraEpic[]): JiraSnapshot {
  return {
    fetchedAt: "2026-09-20T10:00:00.000Z",
    initiative: issue("INI-1", "Checkout", { issueType: "Initiative" }),
    epics,
    fieldIds: {},
  };
}

const teams: Team[] = [
  {
    id: "t1",
    name: "Core",
    members: [
      { id: "m-fe", name: "Alice", specialization: "Frontend" },
      { id: "m-be", name: "Bob", specialization: "Backend" },
      { id: "m-qa", name: "Cleo", specialization: "QA" },
    ],
    offDays: {},
  },
];

const project: Project = {
  id: "p1",
  name: "Plan",
  startDate: "2026-09-07",
  planViewMode: "person",
  plan: null,
  epics: [
    {
      id: "e1",
      name: "Checkout",
      tasks: [
        {
          id: "t-pay",
          name: "Payment form",
          estimateDays: 3,
          specialization: "Frontend",
          excluded: false,
        },
      ],
    },
  ],
};

describe("trackerMapping", () => {
  it("matches plan tasks by name, and gives new tasks their tagged specialization", () => {
    const snapshot = snapshotOf([
      epic("E-1", "Checkout", [
        issue("A-1", "Payment form", { labels: ["qa"] }),
        issue("A-2", "Refund endpoint", { labels: ["backend"] }),
        issue("A-3", "[QA] Refund regression"),
        issue("A-4", "Refund copy tweaks"),
      ]),
    ]);
    const out = trackerMapping({ project, teams, snapshot, tracker: {} });

    // A name match wins over a label: it is planned work.
    expect(out.taskMap["A-1"]).toBe("t-pay");
    // New work: a label, else a bracketed tag in the summary.
    expect(out.addedScope).toEqual({ "A-2": "Backend", "A-3": "QA" });
    expect(out.taskMap["A-2"]).toBeNull();
    expect(out.taskMap["A-3"]).toBeNull();
    // Nothing names one: unmapped, in neither map.
    expect("A-4" in out.taskMap).toBe(false);
    expect("A-4" in out.addedScope).toBe(false);
  });

  it("keeps a specialization already set, whatever the tags say", () => {
    const snapshot = snapshotOf([
      epic("E-1", "Checkout", [
        issue("A-2", "Refund endpoint", { labels: ["backend"] }),
      ]),
    ]);
    const out = trackerMapping({
      project,
      teams,
      snapshot,
      tracker: { taskMap: { "A-2": null }, addedScope: { "A-2": "QA" } },
    });
    expect(out.addedScope).toEqual({ "A-2": "QA" });
  });

  it("never name-matches added scope onto a plan task", () => {
    const snapshot = snapshotOf([
      epic("E-1", "Checkout", [issue("A-1", "Payment form")]),
    ]);
    const out = trackerMapping({
      project,
      teams,
      snapshot,
      tracker: { addedScope: { "A-1": "Backend" } },
    });
    expect(out.taskMap["A-1"]).toBeNull();
    expect(out.addedScope).toEqual({ "A-1": "Backend" });
  });

  it("drops a bare null, so the task is matched by name again", () => {
    const snapshot = snapshotOf([
      epic("E-1", "Checkout", [issue("A-1", "Payment form")]),
    ]);
    const out = trackerMapping({
      project,
      teams,
      snapshot,
      tracker: { taskMap: { "A-1": null } },
    });
    expect(out.taskMap["A-1"]).toBe("t-pay");
  });

  it("reads tags through the caller's aliases, and leaves ambiguous ones alone", () => {
    const snapshot = snapshotOf([
      epic("E-1", "Checkout", [
        issue("A-5", "Wallet screen", { labels: ["ui"] }),
        issue("A-6", "Handover", { labels: ["backend", "qa"] }),
      ]),
    ]);
    const out = trackerMapping({
      project,
      teams,
      snapshot,
      tracker: {},
      tagAliases: [{ tag: "ui", specialization: "Frontend" }],
    });
    expect(out.addedScope).toEqual({ "A-5": "Frontend" });
  });

  it("leaves issues under untracked epics alone", () => {
    const snapshot = snapshotOf([
      epic("E-2", "Theirs", [
        issue("B-1", "Their endpoint", { labels: ["backend"] }),
      ]),
    ]);
    const out = trackerMapping({
      project,
      teams,
      snapshot,
      tracker: { untrackedEpics: ["E-2"] },
    });
    expect(out.addedScope).toEqual({});
  });
});
