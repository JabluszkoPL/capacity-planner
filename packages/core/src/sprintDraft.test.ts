import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type {
  Epic,
  JiraEpic,
  JiraIssue,
  JiraSnapshot,
  Project,
  SprintDraft,
  SprintDraftItem,
  Team,
} from "./types";
import { personRows } from "./planLayout";
import { mergedOffDays } from "./teams";
import {
  autoStack,
  defaultEstimateDays,
  defaultSprintWindow,
  draftAssignments,
  draftFlags,
  draftItemSpan,
  draftSpans,
  resolveWorkers,
} from "./sprintDraft";

/* ---------------------------------------------------------------------------
 * Calendar used throughout (2026):
 *
 *   Mon 03-02  Tue 03-03  Wed 03-04  Thu 03-05  Fri 03-06
 *   Mon 03-09  Tue 03-10  Wed 03-11  Thu 03-12  Fri 03-13
 *
 * so 03-02 .. 03-13 is a two-working-week sprint window of 10 working days.
 * ------------------------------------------------------------------------- */

const SPRINT_START = "2026-03-02"; // Monday
const SPRINT_END = "2026-03-13"; // Friday

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: "t1",
    name: "Core",
    members: [
      { id: "m1", name: "Ada", specialization: "dev" },
      { id: "m2", name: "Linus", specialization: "dev" },
    ],
    offDays: {},
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Atlas",
    startDate: SPRINT_START,
    epics: [],
    plan: null,
    planViewMode: "person",
    ...overrides,
  };
}

function item(overrides: Partial<SprintDraftItem> = {}): SprintDraftItem {
  return {
    issueKey: "AB-1",
    memberId: "m1",
    estimateDays: 1,
    start: SPRINT_START,
    ...overrides,
  };
}

function draft(items: SprintDraftItem[]): SprintDraft {
  return { start: SPRINT_START, end: SPRINT_END, items };
}

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "AB-1",
    summary: "Do the thing",
    issueType: "Story",
    status: "To Do",
    statusCategory: "new",
    updated: "2026-03-01T09:00:00.000Z",
    ...overrides,
  };
}

function jiraEpic(key: string, children: JiraIssue[]): JiraEpic {
  return {
    ...issue({ key, summary: `Epic ${key}`, issueType: "Epic" }),
    children,
    totals: {
      originalSec: 0,
      spentSec: 0,
      remainingSec: 0,
      done: 0,
      all: children.length,
    },
  };
}

function snapshot(epics: JiraEpic[]): JiraSnapshot {
  return {
    fetchedAt: "2026-03-01T09:00:00.000Z",
    initiative: issue({ key: "AB-0", issueType: "Initiative" }),
    epics,
    fieldIds: {},
  };
}

/* --------------------------------- spans ---------------------------------- */

describe("draftItemSpan", () => {
  it("skips weekends and the member's off-days", () => {
    // 3 days from Friday, with the following Monday off: Fri, Tue, Wed.
    const workers = resolveWorkers(
      [team({ offDays: { m1: ["2026-03-09"] } })],
      project(),
    );
    const span = draftItemSpan(
      item({ estimateDays: 3, start: "2026-03-06" }),
      workers.get("m1"),
    );
    expect(span.start).toBe("2026-03-06");
    expect(span.end).toBe("2026-03-11"); // Wednesday
    expect(span.workDays).toBe(3);
  });

  it("pushes a start that lands on a weekend to the next working day", () => {
    const workers = resolveWorkers([team()], project());
    const span = draftItemSpan(
      item({ estimateDays: 1, start: "2026-03-07" }), // Saturday
      workers.get("m1"),
    );
    expect(span.start).toBe("2026-03-09");
    expect(span.end).toBe("2026-03-09");
  });

  it("blocks out 4 working days for a 0.5-speed worker's 2-day estimate", () => {
    const slow = team({
      members: [{ id: "m1", name: "Ada", specialization: "dev", speed: 0.5 }],
    });
    const workers = resolveWorkers([slow], project());
    expect(workers.get("m1")!.speed).toBe(0.5);
    const span = draftItemSpan(item({ estimateDays: 2 }), workers.get("m1"));
    expect(span.workDays).toBe(4);
    expect(span.start).toBe("2026-03-02");
    expect(span.end).toBe("2026-03-05"); // Mon..Thu
  });

  it("multiplies member speed by the project's team velocity", () => {
    const halved = resolveWorkers(
      [team()],
      project({ teamInclusions: [{ teamId: "t1", velocity: 0.5 }] }),
    );
    expect(halved.get("m1")!.speed).toBe(0.5);
    expect(
      draftItemSpan(item({ estimateDays: 2 }), halved.get("m1")).workDays,
    ).toBe(4);

    const doubled = resolveWorkers(
      [
        team({
          members: [{ id: "m1", name: "Ada", specialization: "dev", speed: 2 }],
        }),
      ],
      project({ teamInclusions: [{ teamId: "t1", velocity: 2 }] }),
    );
    expect(doubled.get("m1")!.speed).toBe(4);
    expect(
      draftItemSpan(item({ estimateDays: 4 }), doubled.get("m1")).workDays,
    ).toBe(1);
  });

  it("falls back to speed 1 and no off-days with nobody assigned", () => {
    const span = draftItemSpan(item({ estimateDays: 3 }), undefined);
    expect(span.workDays).toBe(3);
    expect(span.end).toBe("2026-03-04");
  });

  it("always blocks out at least one day", () => {
    expect(draftItemSpan(item({ estimateDays: 0 }), undefined).workDays).toBe(
      1,
    );
    expect(
      draftItemSpan(item({ estimateDays: 0.25 }), undefined).workDays,
    ).toBe(1);
  });
});

describe("resolveWorkers", () => {
  it("includes project helpers with their own speed and off-days", () => {
    const workers = resolveWorkers(
      [team()],
      project({
        helpers: [
          {
            id: "h1",
            name: "Grace",
            specialization: "qa",
            speed: 0.5,
            availableFrom: SPRINT_START,
            availableTo: SPRINT_END,
            offDays: ["2026-03-04"],
          },
        ],
      }),
    );
    const helper = workers.get("h1")!;
    expect(helper.teamId).toBeNull();
    expect(helper.speed).toBe(0.5);
    expect(helper.offDays.has("2026-03-04")).toBe(true);
    expect(workers.get("m1")!.teamId).toBe("t1");
  });

  it("defaults speed and velocity to 1", () => {
    const workers = resolveWorkers([team()], undefined);
    expect(workers.get("m1")!.speed).toBe(1);
    expect(workers.get("m2")!.speed).toBe(1);
  });
});

describe("draftSpans", () => {
  it("keys spans by issue key and falls back to the sprint start", () => {
    const workers = resolveWorkers([team()], project());
    const spans = draftSpans(
      draft([
        item({ issueKey: "AB-1", estimateDays: 2 }),
        item({ issueKey: "AB-2", estimateDays: 1, start: "" }),
      ]),
      workers,
    );
    expect(spans.get("AB-1")!.end).toBe("2026-03-03");
    expect(spans.get("AB-2")!.start).toBe(SPRINT_START);
  });
});

/* ------------------------------- auto-stack -------------------------------- */

describe("autoStack", () => {
  const workers = resolveWorkers([team()], project());

  it("starts a person's second item the working day after the first ends", () => {
    const stacked = autoStack(
      draft([
        item({ issueKey: "AB-1", estimateDays: 2 }),
        item({ issueKey: "AB-2", estimateDays: 3 }),
      ]),
      workers,
    );
    expect(stacked.items[0].start).toBe("2026-03-02"); // Mon, ends Tue 03-03
    expect(stacked.items[1].start).toBe("2026-03-04"); // Wed
    const spans = draftSpans(stacked, workers);
    expect(spans.get("AB-2")!.end).toBe("2026-03-06"); // Fri
  });

  it("keeps a manually moved first item and stacks after it", () => {
    const stacked = autoStack(
      draft([
        item({ issueKey: "AB-1", estimateDays: 2, start: "2026-03-04" }),
        item({ issueKey: "AB-2", estimateDays: 3 }),
      ]),
      workers,
    );
    expect(stacked.items[0].start).toBe("2026-03-04"); // Wed, ends Thu 03-05
    expect(stacked.items[1].start).toBe("2026-03-06"); // Fri
    const spans = draftSpans(stacked, workers);
    expect(spans.get("AB-2")!.end).toBe("2026-03-10"); // Fri, Mon, Tue
  });

  it("pulls a first item that starts before the sprint to the sprint start", () => {
    const stacked = autoStack(
      draft([item({ issueKey: "AB-1", start: "2026-02-24" })]),
      workers,
    );
    expect(stacked.items[0].start).toBe(SPRINT_START);
  });

  it("stacks each person independently", () => {
    const stacked = autoStack(
      draft([
        item({ issueKey: "AB-1", memberId: "m1", estimateDays: 3 }),
        item({ issueKey: "AB-2", memberId: "m2", estimateDays: 2 }),
        item({ issueKey: "AB-3", memberId: "m2", estimateDays: 1 }),
      ]),
      workers,
    );
    expect(stacked.items[0].start).toBe("2026-03-02"); // Ada's first
    expect(stacked.items[1].start).toBe("2026-03-02"); // Linus's first
    expect(stacked.items[2].start).toBe("2026-03-04"); // after Linus's Tue end
  });

  it("stacks over a person's off-days", () => {
    const off = resolveWorkers(
      [team({ offDays: { m1: ["2026-03-04"] } })],
      project(),
    );
    const stacked = autoStack(
      draft([
        item({ issueKey: "AB-1", estimateDays: 2 }), // Mon..Tue
        item({ issueKey: "AB-2", estimateDays: 2 }), // Wed is off -> Thu..Fri
      ]),
      off,
    );
    expect(stacked.items[1].start).toBe("2026-03-04");
    const spans = draftSpans(stacked, off);
    expect(spans.get("AB-2")!.start).toBe("2026-03-05");
    expect(spans.get("AB-2")!.end).toBe("2026-03-06");
  });

  it("leaves unassigned items where they are", () => {
    const original = draft([
      item({ issueKey: "AB-1", memberId: undefined, start: "2026-03-11" }),
    ]);
    const stacked = autoStack(original, workers);
    expect(stacked.items[0].start).toBe("2026-03-11");
    expect(stacked.items[0]).toBe(original.items[0]);
  });

  it("does not mutate the input draft", () => {
    const original = draft([
      item({ issueKey: "AB-1", estimateDays: 2 }),
      item({ issueKey: "AB-2", estimateDays: 2 }),
    ]);
    autoStack(original, workers);
    expect(original.items[1].start).toBe(SPRINT_START);
  });
});

/* --------------------------------- flags ---------------------------------- */

describe("draftFlags", () => {
  it("reports over capacity for 12 planned days in a 10-day window", () => {
    const workers = resolveWorkers([team()], project());
    const d = draft([
      item({ issueKey: "AB-1", estimateDays: 4 }),
      item({ issueKey: "AB-2", estimateDays: 4 }),
      item({ issueKey: "AB-3", estimateDays: 4 }),
    ]);
    const flags = draftFlags(d, draftSpans(d, workers), workers);
    const m1 = flags.perMember.get("m1")!;
    expect(m1.plannedDays).toBe(12);
    expect(m1.capacityDays).toBe(10);
    expect(m1.overBy).toBe(2);
  });

  it("lowers capacity by an off-day inside the window", () => {
    const workers = resolveWorkers(
      [team({ offDays: { m1: ["2026-03-04", "2026-03-07", "2026-03-20"] } })],
      project(),
    );
    const d = draft([
      item({ issueKey: "AB-1", estimateDays: 4 }),
      item({ issueKey: "AB-2", estimateDays: 4 }),
      item({ issueKey: "AB-3", estimateDays: 4 }),
    ]);
    const flags = draftFlags(d, draftSpans(d, workers), workers);
    const m1 = flags.perMember.get("m1")!;
    // Only the weekday 03-04 counts: 03-07 is a Saturday, 03-20 is outside.
    expect(m1.capacityDays).toBe(9);
    expect(m1.overBy).toBe(3);
  });

  it("counts blocked days, not raw estimates, against capacity", () => {
    const workers = resolveWorkers(
      [
        team({
          members: [
            { id: "m1", name: "Ada", specialization: "dev", speed: 0.5 },
          ],
        }),
      ],
      project(),
    );
    const d = draft([item({ issueKey: "AB-1", estimateDays: 6 })]);
    const flags = draftFlags(d, draftSpans(d, workers), workers);
    expect(flags.perMember.get("m1")!.plannedDays).toBe(12);
  });

  it("flags an item that ends after the sprint end", () => {
    const workers = resolveWorkers([team()], project());
    const d = draft([
      item({ issueKey: "AB-1", estimateDays: 5, start: "2026-03-09" }),
      item({ issueKey: "AB-2", estimateDays: 6, start: "2026-03-09" }),
    ]);
    const spans = draftSpans(d, workers);
    expect(spans.get("AB-1")!.end).toBe("2026-03-13");
    expect(spans.get("AB-2")!.end).toBe("2026-03-16");
    const flags = draftFlags(d, spans, workers);
    expect(flags.perItem.get("AB-1")!.overflowsSprint).toBe(false);
    expect(flags.perItem.get("AB-2")!.overflowsSprint).toBe(true);
  });

  it("flags rows with nobody on them and gives them no capacity row", () => {
    const workers = resolveWorkers([team()], project());
    const d = draft([
      item({ issueKey: "AB-1", memberId: undefined }),
      item({ issueKey: "AB-2", memberId: "gone" }),
      item({ issueKey: "AB-3", memberId: "m1" }),
    ]);
    const flags = draftFlags(d, draftSpans(d, workers), workers);
    expect(flags.perItem.get("AB-1")!.unassigned).toBe(true);
    expect(flags.perItem.get("AB-2")!.unassigned).toBe(true);
    expect(flags.perItem.get("AB-3")!.unassigned).toBe(false);
    expect(flags.perMember.has("m1")).toBe(true);
    expect(flags.perMember.size).toBe(2); // m1 and the dangling "gone" id
    expect(flags.perMember.get("gone")!.capacityDays).toBe(10);
  });
});

/* ------------------------------- estimates -------------------------------- */

describe("defaultEstimateDays", () => {
  const plannerEpic: Epic = {
    id: "e1",
    name: "Alpha",
    tasks: [
      {
        id: "t1",
        name: "a",
        estimateDays: 3,
        specialization: "dev",
        excluded: false,
      },
      {
        id: "t2",
        name: "b",
        estimateDays: 100,
        specialization: "dev",
        excluded: true,
      },
      {
        id: "t3",
        name: "c",
        estimateDays: 2,
        specialization: "dev",
        excluded: false,
      },
    ],
  };

  it("uses the Jira remaining estimate first", () => {
    const i = issue({
      remainingEstimateSec: 14400, // half an 8h day
      originalEstimateSec: 57600,
    });
    expect(defaultEstimateDays(i, plannerEpic, 8)).toBe(0.5);
  });

  it("falls back to the original estimate", () => {
    const i = issue({ remainingEstimateSec: 0, originalEstimateSec: 57600 });
    expect(defaultEstimateDays(i, plannerEpic, 8)).toBe(2);
  });

  it("falls back to the planner epic's mean non-excluded estimate", () => {
    expect(defaultEstimateDays(issue(), plannerEpic, 8)).toBe(2.5);
  });

  it("falls back to one day", () => {
    expect(defaultEstimateDays(issue(), undefined, 8)).toBe(1);
    expect(defaultEstimateDays(issue(), { ...plannerEpic, tasks: [] }, 8)).toBe(
      1,
    );
  });

  it("honours the tracker's hours per day", () => {
    const i = issue({ remainingEstimateSec: 21600 }); // 6h
    expect(defaultEstimateDays(i, undefined, 6)).toBe(1);
    expect(defaultEstimateDays(i, undefined, 8)).toBe(0.8);
  });

  it("skips an estimate that rounds away to nothing", () => {
    const i = issue({ remainingEstimateSec: 900, originalEstimateSec: 57600 });
    expect(defaultEstimateDays(i, undefined, 8)).toBe(2);
  });

  it("rounds to one decimal", () => {
    const i = issue({ remainingEstimateSec: 40000 });
    expect(defaultEstimateDays(i, undefined, 8)).toBe(1.4);
  });
});

/* ----------------------------- the mini Gantt ------------------------------ */

describe("draftAssignments", () => {
  const snap = snapshot([
    jiraEpic("AB-10", [
      issue({ key: "AB-11", summary: "Login form" }),
      issue({ key: "AB-12", summary: "Password reset" }),
    ]),
    jiraEpic("AB-20", [issue({ key: "AB-21", summary: "Audit log" })]),
  ]);
  const teams = [team()];
  const workers = resolveWorkers(teams, project());

  const d = draft([
    item({ issueKey: "AB-11", memberId: "m1", estimateDays: 2 }),
    item({ issueKey: "AB-12", memberId: "m1", estimateDays: 1 }),
    item({ issueKey: "AB-21", memberId: "m2", estimateDays: 3 }),
    item({ issueKey: "AB-99", memberId: undefined, estimateDays: 3 }),
  ]);

  it("carries Jira names, worker specialization, and the computed span", () => {
    const spans = draftSpans(d, workers);
    const assignments = draftAssignments(d, spans, snap, workers);
    expect(assignments).toHaveLength(3);
    const first = assignments[0];
    expect(first).toEqual({
      taskId: "AB-11",
      taskName: "Login form",
      epicId: "AB-10",
      epicName: "Epic AB-10",
      specialization: "dev",
      estimateDays: 2,
      workDays: 2,
      memberId: "m1",
      memberName: "Ada",
      start: "2026-03-02",
      end: "2026-03-03",
    });
  });

  it("omits items with nobody assigned", () => {
    const assignments = draftAssignments(
      d,
      draftSpans(d, workers),
      snap,
      workers,
    );
    expect(assignments.map((a) => a.taskId)).toEqual([
      "AB-11",
      "AB-12",
      "AB-21",
    ]);
  });

  it("feeds personRows() one lane per assigned person", () => {
    const stacked = autoStack(d, workers);
    const rows = personRows(
      draftAssignments(stacked, draftSpans(stacked, workers), snap, workers),
      mergedOffDays(teams),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title)).toEqual(["Ada", "Linus"]);
    expect(rows[0].bars.map((b) => b.taskName)).toEqual([
      "Login form",
      "Password reset",
    ]);
    expect(rows[0].bars[1].start).toBe("2026-03-04");
    expect(rows[1].bars).toHaveLength(1);
    expect(rows[1].bars[0].epicName).toBe("Epic AB-20");
  });

  it("carries a person's off-days into their lane", () => {
    const teamsOff = [team({ offDays: { m1: ["2026-03-04"] } })];
    const w = resolveWorkers(teamsOff, project());
    const rows = personRows(
      draftAssignments(d, draftSpans(d, w), snap, w),
      mergedOffDays(teamsOff),
    );
    expect(rows[0].offDays.has("2026-03-04")).toBe(true);
  });

  it("falls back to the issue key when the snapshot doesn't know it", () => {
    const d2 = draft([item({ issueKey: "AB-77", memberId: "m1" })]);
    const assignments = draftAssignments(
      d2,
      draftSpans(d2, workers),
      snap,
      workers,
    );
    expect(assignments[0].taskName).toBe("AB-77");
    expect(assignments[0].epicId).toBe("");
  });
});

/* -------------------------------- the window ------------------------------- */

describe("defaultSprintWindow", () => {
  it("runs the next Monday to the Friday two weeks on", () => {
    expect(defaultSprintWindow("2026-03-04")).toEqual({
      start: "2026-03-09",
      end: "2026-03-20",
    });
  });

  it("skips the week already underway when today is a Monday", () => {
    expect(defaultSprintWindow("2026-03-02")).toEqual({
      start: "2026-03-09",
      end: "2026-03-20",
    });
  });

  it("always spans ten working days", () => {
    for (const today of [
      "2026-03-01",
      "2026-03-05",
      "2026-03-07",
      "2026-03-08",
    ]) {
      const w = defaultSprintWindow(today);
      const workers = resolveWorkers([team()], project());
      const d = { start: w.start, end: w.end, items: [item()] };
      expect(
        draftFlags(d, draftSpans(d, workers), workers).perMember.get("m1")!
          .capacityDays,
      ).toBe(10);
    }
  });
});

/* --------------------------------- purity --------------------------------- */

describe("sprintDraft module purity", () => {
  it("does not import React or reference the DOM", () => {
    const src = readFileSync("src/sprintDraft.ts", "utf8");
    expect(src).not.toMatch(/from\s+['"]react/);
    // DOM globals as property access (window.x / document.x), not the English
    // words that appear in comments.
    expect(src).not.toMatch(/\bdocument\.\w/);
    expect(src).not.toMatch(/\bwindow\.\w/);
  });

  it("never reads the clock", () => {
    const src = readFileSync("src/sprintDraft.ts", "utf8");
    expect(src).not.toMatch(/Date\.now\(/);
    expect(src).not.toMatch(/new Date\(\)/);
  });
});
