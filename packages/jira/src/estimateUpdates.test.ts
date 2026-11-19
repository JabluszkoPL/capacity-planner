import { describe, it, expect } from "vitest";
import type { JiraIssue, JiraSnapshot, Project } from "@planner/core";
import { estimateUpdates } from "./estimateUpdates";

const H = 3600;

function issue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: key,
    issueType: "Task",
    status: "To Do",
    statusCategory: "new",
    updated: "2026-09-20T08:00:00.000Z",
    ...over,
  };
}

function snapshot(children: JiraIssue[]): JiraSnapshot {
  return {
    fetchedAt: "2026-09-25T08:00:00.000Z",
    fieldIds: {},
    initiative: issue("I-1"),
    epics: [
      {
        ...issue("E-1"),
        children,
        totals: {
          originalSec: 0,
          spentSec: 0,
          remainingSec: 0,
          done: 0,
          all: 0,
        },
      },
    ],
  };
}

function project(): Project {
  return {
    id: "p",
    name: "Atlas",
    startDate: "2026-09-07",
    plan: null,
    planViewMode: "person",
    epics: [
      {
        id: "e",
        name: "Epic",
        tasks: [
          {
            id: "dev",
            name: "Build",
            estimateDays: 3,
            specialization: "dev",
            excluded: false,
          },
          // Imported with no Jira estimate: skipped at 0 days.
          {
            id: "qa",
            name: "QA pass",
            estimateDays: 0,
            specialization: "qa",
            excluded: true,
          },
          {
            id: "same",
            name: "Docs",
            estimateDays: 2,
            specialization: "dev",
            excluded: false,
          },
        ],
      },
    ],
  };
}

describe("estimateUpdates", () => {
  it("lists skipped and changed tasks, and leaves matching ones out", () => {
    const snap = snapshot([
      issue("J-1", { originalEstimateSec: 4 * 8 * H }),
      issue("J-2", { originalEstimateSec: 5 * 8 * H }),
      issue("J-3", { originalEstimateSec: 2 * 8 * H }),
    ]);
    const updates = estimateUpdates(
      project(),
      snap,
      { "J-1": "dev", "J-2": "qa", "J-3": "same" },
      8,
    );
    expect(
      updates.map((u) => [
        u.taskId,
        u.currentDays,
        u.currentExcluded,
        u.jiraDays,
      ]),
    ).toEqual([
      ["dev", 3, false, 4],
      ["qa", 0, true, 5],
    ]);
    expect(updates[1]).toMatchObject({ epicId: "e", issueKeys: ["J-2"] });
  });

  it("un-skips a task whose estimate already matches", () => {
    const p = project();
    p.epics[0].tasks[1].estimateDays = 5;
    const updates = estimateUpdates(
      p,
      snapshot([issue("J-2", { originalEstimateSec: 5 * 8 * H })]),
      { "J-2": "qa" },
      8,
    );
    expect(updates.map((u) => u.taskId)).toEqual(["qa"]);
  });

  it("ignores unmapped, excluded and unestimated issues", () => {
    const updates = estimateUpdates(
      project(),
      snapshot([
        issue("J-1", { originalEstimateSec: 9 * 8 * H }),
        issue("J-2", { originalEstimateSec: 9 * 8 * H }),
        issue("J-3"),
      ]),
      { "J-2": null, "J-3": "dev" },
      8,
    );
    expect(updates).toEqual([]);
  });

  it("sums several Jira issues mapped to one task, using the hours per day", () => {
    const updates = estimateUpdates(
      project(),
      snapshot([
        issue("J-1", { originalEstimateSec: 6 * H }),
        issue("J-2", { originalEstimateSec: 6 * H }),
      ]),
      { "J-1": "dev", "J-2": "dev" },
      6,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      jiraDays: 2,
      issueKeys: ["J-1", "J-2"],
    });
  });
});
