import { describe, it, expect } from "vitest";
import type { Assignment, Epic } from "./types";
import {
  epicRows,
  epicSpans,
  personRows,
  planViewModeOf,
  taskRows,
} from "./planLayout";

function a(over: Partial<Assignment>): Assignment {
  return {
    taskId: "t",
    taskName: "T",
    epicId: "e1",
    epicName: "E1",
    specialization: "FE",
    estimateDays: 1,
    workDays: 1,
    memberId: "m1",
    memberName: "Alice",
    start: "2026-07-27",
    end: "2026-07-27",
    ...over,
  };
}

describe("personRows", () => {
  it("groups by assignee in first-seen order and sorts bars by start", () => {
    const rows = personRows(
      [
        a({
          taskId: "1",
          memberId: "m1",
          memberName: "Alice",
          start: "2026-07-29",
        }),
        a({
          taskId: "2",
          memberId: "m2",
          memberName: "Bob",
          start: "2026-07-27",
        }),
        a({
          taskId: "3",
          memberId: "m1",
          memberName: "Alice",
          start: "2026-07-27",
        }),
      ],
      {},
    );
    expect(rows.map((r) => r.title)).toEqual(["Alice", "Bob"]);
    // Alice's bars are sorted by start.
    expect(rows[0].bars.map((b) => b.taskId)).toEqual(["3", "1"]);
  });

  it("attaches each member's off days", () => {
    const rows = personRows([a({ memberId: "m1" })], { m1: ["2026-07-28"] });
    expect(rows[0].offDays.has("2026-07-28")).toBe(true);
  });
});

describe("taskRows", () => {
  it("orders rows by epic/task order in the project", () => {
    const epics: Epic[] = [
      {
        id: "e1",
        name: "E1",
        tasks: [
          {
            id: "t1",
            name: "First",
            estimateDays: 1,
            specialization: "FE",
            excluded: false,
          },
          {
            id: "t2",
            name: "Second",
            estimateDays: 1,
            specialization: "FE",
            excluded: false,
          },
        ],
      },
    ];
    const rows = taskRows(
      [
        a({ taskId: "t2", taskName: "Second" }),
        a({ taskId: "t1", taskName: "First" }),
      ],
      epics,
      {},
    );
    expect(rows.map((r) => r.title)).toEqual(["First", "Second"]);
    expect(rows[0].subtitle).toBe("Alice · E1");
  });
});

describe("epicSpans", () => {
  const epics: Epic[] = [
    { id: "e1", name: "Login", tasks: [] },
    { id: "e2", name: "Payments", tasks: [] },
  ];

  it("spans each epic from its first start to its last end, in epic order", () => {
    const spans = epicSpans(
      [
        a({
          taskId: "p1",
          epicId: "e2",
          start: "2026-08-03",
          end: "2026-08-05",
        }),
        a({
          taskId: "l1",
          epicId: "e1",
          start: "2026-07-29",
          end: "2026-07-30",
        }),
        a({
          taskId: "l2",
          epicId: "e1",
          memberId: "m2",
          start: "2026-07-27",
          end: "2026-07-28",
          estimateDays: 2,
        }),
      ],
      epics,
    );
    expect(spans.map((s) => [s.epicId, s.start, s.end])).toEqual([
      ["e1", "2026-07-27", "2026-07-30"],
      ["e2", "2026-08-03", "2026-08-05"],
    ]);
    expect(spans[0]).toMatchObject({
      epicName: "Login",
      taskCount: 2,
      peopleCount: 2,
      estimateDays: 3,
      unassignedCount: 0,
    });
  });

  it("counts unassigned tasks and skips epics with nothing scheduled", () => {
    const spans = epicSpans([a({ epicId: "e1" })], epics, [
      {
        id: "u1",
        name: "U",
        estimateDays: 1,
        specialization: "BE",
        excluded: false,
        epicId: "e1",
        epicName: "Login",
        reason: "no one",
      },
      {
        id: "u2",
        name: "U2",
        estimateDays: 1,
        specialization: "BE",
        excluded: false,
        epicId: "e2",
        epicName: "Payments",
        reason: "no one",
      },
    ]);
    expect(spans.map((s) => s.epicId)).toEqual(["e1"]);
    expect(spans[0].unassignedCount).toBe(1);
  });

  it("builds one bar per epic for the timeline", () => {
    const rows = epicRows(
      [
        a({
          taskId: "1",
          epicId: "e1",
          start: "2026-07-27",
          end: "2026-07-28",
        }),
        a({
          taskId: "2",
          epicId: "e1",
          start: "2026-07-29",
          end: "2026-07-31",
        }),
      ],
      epics,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Login");
    expect(rows[0].subtitle).toBe("2026-07-27 → 2026-07-31 · 2 tasks");
    expect(rows[0].bars.map((b) => [b.start, b.end])).toEqual([
      ["2026-07-27", "2026-07-31"],
    ]);
  });
});

describe("planViewModeOf", () => {
  it("keeps known modes and falls back to person", () => {
    expect(planViewModeOf("task")).toBe("task");
    expect(planViewModeOf("epic")).toBe("epic");
    expect(planViewModeOf("person")).toBe("person");
    expect(planViewModeOf("timeline")).toBe("person");
    expect(planViewModeOf(undefined)).toBe("person");
  });
});
