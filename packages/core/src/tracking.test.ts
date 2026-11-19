import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type {
  JiraEpic,
  JiraEpicTotals,
  JiraIssue,
  JiraSnapshot,
  JiraStatusCategory,
  Project,
  Team,
  Tracker,
} from "./types";
import { runPlan } from "./scheduling";
import {
  autoEpicMap,
  autoTaskMap,
  baselinePlans,
  earnedDays,
  earnedScheduleDate,
  earnedTaskDays,
  epicCompletion,
  jiraTasks,
  plannedDaysByEpic,
  plannedDaysByTask,
  plannedDoneBy,
  sampleFromStatus,
  taskCompletion,
  addWorkdays,
  resolveDeadlines,
  suggestedEndPhase,
  teamCalendar,
  trackedMapping,
  trackerStatus,
  jiraTaskTeams,
  trackerTeams,
  awaitingCloseWhatIf,
  isAwaitingClose,
  untrackedIssueKeys,
  withAddedScope,
  workdaysBetween,
} from "./tracking";

/* ---------------------------------------------------------------------------
 * The fixture, hand-computed.
 *
 * Project "Atlas" starts Mon 2026-09-07, buffer 20%. One team: M1 does "dev",
 * M2 does "qa". Three epics hold ten 10-day dev tasks (100 days, all on M1, in
 * epic/task order) plus one 5-day qa task in the last epic (M2, day one).
 *
 *   Alpha  a1..a4   4 x 10 = 40 plan days
 *   Beta   b1..b3   3 x 10 = 30
 *   Gamma  g1..g3   3 x 10 = 30  + q1 (qa, 5) = 35
 *                              plan total = 105
 *
 * Unbuffered, M1's chain is 100 working days = 20 weeks, so each dev task ends
 * on every other Friday (a1 on 09-18, a2 on 10-02, ... g3 on 2027-01-22) and
 * the cumulative curve is:
 *
 *   2026-09-11   5   (q1, run by M2 in parallel on day one)
 *   2026-09-18  15
 *   2026-10-02  25   U (unbuffered finish) = 2027-01-22
 *   2026-10-16  35
 *   2026-10-30  45   Buffered, every dev task is 10 x 1.2 = 12 days, so the
 *   2026-11-13  55   chain is 120 working days = 24 weeks and
 *   2026-11-27  65   B (buffered finish) = 2027-02-19
 *   2026-12-11  75
 *   2026-12-25  85   => schedule buffer = 20 working days
 *   2027-01-08  95
 *   2027-01-22 105
 * ------------------------------------------------------------------------- */

const START = "2026-09-07"; // Monday
const U = "2027-01-22"; // unbuffered finish (Friday)
const B = "2027-02-19"; // buffered finish (Friday)
const TODAY = "2026-10-23"; // Friday, 5 working days after the curve hits 35

const H = 3600; // seconds in an hour

const TEAMS: Team[] = [
  {
    id: "team1",
    name: "Core",
    members: [
      { id: "m1", name: "Dana", specialization: "dev" },
      { id: "m2", name: "Quinn", specialization: "qa" },
    ],
    offDays: {},
  },
];

function devTasks(ids: string[]) {
  return ids.map((id) => ({
    id,
    name: id.toUpperCase(),
    estimateDays: 10,
    specialization: "dev",
    excluded: false,
  }));
}

function fixtureProject(over: Partial<Project> = {}): Project {
  return {
    id: "p-atlas",
    name: "Atlas",
    startDate: START,
    plan: null,
    planViewMode: "person",
    buffer: 20,
    epics: [
      {
        id: "e-alpha",
        name: "Alpha",
        tasks: devTasks(["a1", "a2", "a3", "a4"]),
      },
      { id: "e-beta", name: "Beta", tasks: devTasks(["b1", "b2", "b3"]) },
      {
        id: "e-gamma",
        name: "Gamma",
        tasks: [
          ...devTasks(["g1", "g2", "g3"]),
          {
            id: "q1",
            name: "Q1",
            estimateDays: 5,
            specialization: "qa",
            excluded: false,
          },
        ],
      },
    ],
    ...over,
  };
}

function totals(over: Partial<JiraEpicTotals> = {}): JiraEpicTotals {
  return {
    originalSec: 0,
    spentSec: 0,
    remainingSec: 0,
    done: 0,
    all: 0,
    ...over,
  };
}

function jiraEpic(
  key: string,
  summary: string,
  t: Partial<JiraEpicTotals> = {},
  statusCategory: JiraStatusCategory = "indeterminate",
  children: JiraIssue[] = [],
): JiraEpic {
  return {
    key,
    summary,
    issueType: "Epic",
    status: statusCategory === "done" ? "Done" : "In Progress",
    statusCategory,
    updated: "2026-10-23T09:00:00.000Z",
    children,
    totals: totals(t),
  };
}

function jiraTask(
  key: string,
  summary: string,
  statusCategory: JiraStatusCategory = "indeterminate",
  originalEstimateSec = 0,
): JiraIssue {
  return {
    key,
    summary,
    issueType: "Task",
    status: statusCategory === "done" ? "Done" : "In Progress",
    statusCategory,
    originalEstimateSec,
    updated: "2026-10-23T09:00:00.000Z",
  };
}

/** Alpha: 20h spent of 40h => 0.5. Beta: 10h of 40h => 0.25. Gamma: nothing. */
const ALPHA = jiraEpic("JIRA-100", "Alpha", {
  originalSec: 40 * H,
  spentSec: 20 * H,
  remainingSec: 20 * H,
  done: 1,
  all: 4,
});
const BETA = jiraEpic("JIRA-200", "Beta", {
  originalSec: 40 * H,
  spentSec: 10 * H,
  remainingSec: 30 * H,
  done: 0,
  all: 3,
});
const GAMMA = jiraEpic("JIRA-300", "Gamma", { all: 3 });

function snapshotOf(epics: JiraEpic[]): JiraSnapshot {
  return {
    fetchedAt: "2026-10-23T09:00:00.000Z",
    initiative: {
      key: "ATL-1",
      summary: "Atlas",
      issueType: "Initiative",
      status: "In Progress",
      statusCategory: "indeterminate",
      updated: "2026-10-23T09:00:00.000Z",
    },
    epics,
    fieldIds: {},
  };
}

const FULL_MAP = {
  "JIRA-100": "e-alpha",
  "JIRA-200": "e-beta",
  "JIRA-300": "e-gamma",
};

function fixtureTracker(over: Partial<Tracker> = {}): Tracker {
  return {
    id: "t1",
    name: "Atlas tracking",
    initiativeUrl: "https://acme.atlassian.net/browse/ATL-1",
    initiativeKey: "ATL-1",
    baseUrl: "https://acme.atlassian.net",
    projectId: "p-atlas",
    snapshot: snapshotOf([ALPHA, BETA, GAMMA]),
    epicMap: { ...FULL_MAP },
    ...over,
  };
}

/* ------------------------------ working days ------------------------------ */

describe("workdaysBetween", () => {
  it("counts Fri -> Mon as one working day", () => {
    expect(workdaysBetween("2026-09-11", "2026-09-14")).toBe(1);
  });

  it("is zero for the same day and antisymmetric", () => {
    expect(workdaysBetween("2026-09-11", "2026-09-11")).toBe(0);
    expect(workdaysBetween("2026-09-14", "2026-09-11")).toBe(-1);
    expect(workdaysBetween("2026-10-23", "2027-01-22")).toBe(65);
    expect(workdaysBetween("2027-01-22", "2026-10-23")).toBe(-65);
  });

  it("counts weekdays inside one week and skips whole weekends", () => {
    expect(workdaysBetween("2026-09-07", "2026-09-11")).toBe(4);
    expect(workdaysBetween("2026-09-07", "2026-09-21")).toBe(10);
  });
});

/* -------------------------------- the plans ------------------------------- */

describe("baselinePlans", () => {
  it("re-runs the project unbuffered and reports both finishes", () => {
    const base = baselinePlans(fixtureProject(), TEAMS);
    expect(base.unbufferedEnd).toBe(U);
    expect(base.bufferedEnd).toBe(B);
    expect(base.bufferDays).toBe(20);
    expect(base.effortBufferDays).toBe(21); // 105 x 20%
  });

  it("keeps raw estimates on the unbuffered plan", () => {
    const base = baselinePlans(fixtureProject(), TEAMS);
    const a1 = base.unbuffered.assignments.find((a) => a.taskId === "a1");
    const buffered = base.buffered.assignments.find((a) => a.taskId === "a1");
    expect(a1?.estimateDays).toBe(10);
    expect(buffered?.estimateDays).toBeCloseTo(12, 10);
  });

  it("has no schedule buffer when the project buffer is 0", () => {
    const base = baselinePlans(fixtureProject({ buffer: 0 }), TEAMS);
    expect(base.bufferedEnd).toBe(U);
    expect(base.bufferDays).toBe(0);
    expect(base.effortBufferDays).toBe(0);
  });

  it("is stale without a stored plan, fresh with a matching one", () => {
    expect(baselinePlans(fixtureProject(), TEAMS).stale).toBe(true);

    const project = fixtureProject();
    const stored = runPlan(project, TEAMS, "2026-09-01T00:00:00.000Z");
    const withPlan = fixtureProject({ plan: stored });
    expect(baselinePlans(withPlan, TEAMS).stale).toBe(false);
  });

  it("is stale once the project's task set changes", () => {
    const project = fixtureProject();
    const stored = runPlan(project, TEAMS, "2026-09-01T00:00:00.000Z");
    const edited = fixtureProject({ plan: stored });
    edited.epics[1].tasks.push({
      id: "b4",
      name: "B4",
      estimateDays: 3,
      specialization: "dev",
      excluded: false,
    });
    expect(baselinePlans(edited, TEAMS).stale).toBe(true);
  });

  it("re-runs the buffered plan instead of trusting a stored one", () => {
    // A stored plan from before three weeks off were entered: it finishes
    // earlier than the project can now, and must not be the "with buffer" date.
    const stored = runPlan(fixtureProject(), TEAMS, "2026-09-01T00:00:00.000Z");
    const offTeams: Team[] = [
      {
        ...TEAMS[0],
        offDays: {
          m1: [
            "2026-11-02",
            "2026-11-03",
            "2026-11-04",
            "2026-11-05",
            "2026-11-06",
          ],
        },
      },
    ];
    const base = baselinePlans(fixtureProject({ plan: stored }), offTeams);
    expect(base.buffered).not.toBe(stored);
    expect(base.storedEnd).toBe(B);
    expect(base.bufferedEnd! > B).toBe(true);
    // Same inputs on both sides, so without buffer is never the later one.
    expect(base.unbufferedEnd! <= base.bufferedEnd!).toBe(true);
    expect(base.stale).toBe(true);
  });
});

/* ---------------------------- the planned curve --------------------------- */

describe("plannedDoneBy", () => {
  it("walks the cumulative curve of the unbuffered plan", () => {
    const { unbuffered } = baselinePlans(fixtureProject(), TEAMS);
    expect(plannedDoneBy(unbuffered, "2026-09-06")).toBe(0);
    expect(plannedDoneBy(unbuffered, "2026-09-11")).toBe(5);
    expect(plannedDoneBy(unbuffered, "2026-09-18")).toBe(15);
    expect(plannedDoneBy(unbuffered, "2026-10-16")).toBe(35);
    expect(plannedDoneBy(unbuffered, TODAY)).toBe(35);
    expect(plannedDoneBy(unbuffered, U)).toBe(105);
    expect(plannedDoneBy(unbuffered, "9999-12-31")).toBe(105);
  });
});

describe("plannedDaysByEpic", () => {
  it("sums non-excluded raw estimates per epic", () => {
    const map = plannedDaysByEpic(fixtureProject());
    expect(map.get("e-alpha")).toBe(40);
    expect(map.get("e-beta")).toBe(30);
    expect(map.get("e-gamma")).toBe(35);
  });

  it("ignores excluded tasks", () => {
    const project = fixtureProject();
    project.epics[0].tasks[0].excluded = true;
    expect(plannedDaysByEpic(project).get("e-alpha")).toBe(30);
  });
});

describe("earnedScheduleDate", () => {
  const { unbuffered } = baselinePlans(fixtureProject(), TEAMS);

  it("returns the working day before the start when nothing is earned", () => {
    expect(earnedScheduleDate(unbuffered, 0, START)).toBe("2026-09-04");
    expect(earnedScheduleDate(unbuffered, -3, START)).toBe("2026-09-04");
  });

  it("finds the earliest day the curve reached that many days", () => {
    expect(earnedScheduleDate(unbuffered, 5, START)).toBe("2026-09-11");
    expect(earnedScheduleDate(unbuffered, 5.5, START)).toBe("2026-09-18");
    expect(earnedScheduleDate(unbuffered, 27.5, START)).toBe("2026-10-16");
    expect(earnedScheduleDate(unbuffered, 35, START)).toBe("2026-10-16");
  });

  it("caps at the plan's own finish", () => {
    expect(earnedScheduleDate(unbuffered, 105, START)).toBe(U);
    expect(earnedScheduleDate(unbuffered, 400, START)).toBe(U);
  });
});

/* ------------------------------ Jira progress ----------------------------- */

describe("epicCompletion", () => {
  it("is 1 for a done epic whatever the time fields say", () => {
    const e = jiraEpic(
      "X-1",
      "Done thing",
      { spentSec: 1 * H, remainingSec: 99 * H, done: 0, all: 4 },
      "done",
    );
    expect(epicCompletion(e)).toBe(1);
  });

  it("prefers time tracking: 30h spent / 10h remaining is 0.75", () => {
    const e = jiraEpic("X-2", "Timed", {
      spentSec: 30 * H,
      remainingSec: 10 * H,
      done: 0,
      all: 4,
    });
    expect(epicCompletion(e)).toBe(0.75);
  });

  it("falls back to child counts: 2 of 4 done is 0.5", () => {
    const e = jiraEpic("X-3", "Untimed", { done: 2, all: 4 });
    expect(epicCompletion(e)).toBe(0.5);
  });

  it("is 0 for an empty epic", () => {
    expect(epicCompletion(jiraEpic("X-4", "Empty"))).toBe(0);
  });

  it("clamps to [0, 1]", () => {
    const over = jiraEpic("X-5", "Odd", { done: 9, all: 4 });
    expect(epicCompletion(over)).toBe(1);
    const negative = jiraEpic("X-6", "Odd", { spentSec: -5 * H, all: 0 });
    expect(epicCompletion(negative)).toBe(0);
  });
});

describe("earnedDays", () => {
  const project = fixtureProject();

  it("turns completion into plan days, epic by epic", () => {
    const out = earnedDays(project, snapshotOf([ALPHA, BETA, GAMMA]), FULL_MAP);
    expect(out.total).toBe(27.5); // 40*0.5 + 30*0.25 + 35*0

    const alpha = out.perJiraEpic.get("JIRA-100");
    expect(alpha).toEqual({
      plannerEpicId: "e-alpha",
      plannedDays: 40,
      completion: 0.5,
      earned: 20,
    });
    expect(out.perJiraEpic.get("JIRA-200")?.earned).toBe(7.5);
    expect(out.perJiraEpic.get("JIRA-300")?.earned).toBe(0);
  });

  it("ignores an unmapped Jira epic but still lists it", () => {
    const extra = jiraEpic("JIRA-900", "Delta", {
      spentSec: 100 * H,
      remainingSec: 0,
      done: 4,
      all: 4,
    });
    const out = earnedDays(
      project,
      snapshotOf([ALPHA, BETA, GAMMA, extra]),
      FULL_MAP,
    );
    expect(out.total).toBe(27.5);
    expect(out.perJiraEpic.get("JIRA-900")).toEqual({
      plannerEpicId: null,
      plannedDays: 0,
      completion: 1,
      earned: 0,
    });
  });

  it("ignores an epic mapped to null (deliberately out of plan)", () => {
    const out = earnedDays(project, snapshotOf([ALPHA, BETA, GAMMA]), {
      ...FULL_MAP,
      "JIRA-100": null,
    });
    expect(out.total).toBe(7.5);
    expect(out.perJiraEpic.get("JIRA-100")?.plannerEpicId).toBe(null);
  });

  it("counts a plan epic once when several Jira epics map to it", () => {
    const first = jiraEpic(
      "JIRA-101",
      "Alpha part 1",
      { originalSec: 3 * H },
      "done",
    );
    const second = jiraEpic("JIRA-102", "Alpha part 2", {
      originalSec: 1 * H,
      all: 2,
    });
    const out = earnedDays(project, snapshotOf([first, second]), {
      "JIRA-101": "e-alpha",
      "JIRA-102": "e-alpha",
    });
    // 40 days split 3:1, so 30 earned + 0 earned — not 40 + 0.
    expect(out.perJiraEpic.get("JIRA-101")?.plannedDays).toBe(30);
    expect(out.perJiraEpic.get("JIRA-102")?.plannedDays).toBe(10);
    expect(out.total).toBe(30);
  });

  it("weights them equally when every original estimate is 0", () => {
    const first = jiraEpic("JIRA-101", "Alpha part 1", {}, "done");
    const second = jiraEpic("JIRA-102", "Alpha part 2", { all: 2 });
    const out = earnedDays(project, snapshotOf([first, second]), {
      "JIRA-101": "e-alpha",
      "JIRA-102": "e-alpha",
    });
    expect(out.perJiraEpic.get("JIRA-101")?.plannedDays).toBe(20);
    expect(out.perJiraEpic.get("JIRA-102")?.plannedDays).toBe(20);
    expect(out.total).toBe(20); // 40 x (1 + 0) / 2
  });

  it("counts a Jira epic mapped to a deleted plan epic as 0 days", () => {
    const out = earnedDays(project, snapshotOf([ALPHA]), {
      "JIRA-100": "e-gone",
    });
    expect(out.total).toBe(0);
    expect(out.perJiraEpic.get("JIRA-100")?.plannerEpicId).toBe("e-gone");
  });
});

describe("task-level progress", () => {
  const project = fixtureProject();
  const snap = snapshotOf([
    jiraEpic("JIRA-100", "A different epic", {}, "indeterminate", [
      jiraTask("JIRA-1", "A1", "done", 8 * H),
      jiraTask("JIRA-2", "A2", "indeterminate", 8 * H),
    ]),
    jiraEpic("JIRA-200", "Another epic name", {}, "indeterminate", [
      jiraTask("JIRA-3", "Q1", "done", 4 * H),
    ]),
  ]);

  it("flattens children independently of their Jira epic", () => {
    expect(jiraTasks(snap).map((task) => task.key)).toEqual([
      "JIRA-1",
      "JIRA-2",
      "JIRA-3",
    ]);
  });

  it("uses Jira Done as the only completed state", () => {
    expect(taskCompletion(jiraTask("J-1", "x", "done"))).toBe(1);
    expect(taskCompletion(jiraTask("J-2", "x", "indeterminate"))).toBe(0);
    expect(taskCompletion(jiraTask("J-3", "x", "new"))).toBe(0);
  });

  it("reads planned days per task and ignores excluded work", () => {
    const edited = fixtureProject();
    edited.epics[0].tasks[0].excluded = true;
    const days = plannedDaysByTask(edited);
    expect(days.has("a1")).toBe(false);
    expect(days.get("a2")).toBe(10);
  });

  it("earns each mapped Planner task only when its Jira task is done", () => {
    const earned = earnedTaskDays(project, snap, {
      "JIRA-1": "a1",
      "JIRA-2": "a2",
      "JIRA-3": "q1",
    });
    expect(earned.total).toBe(15);
    expect(earned.perJiraTask.get("JIRA-1")).toMatchObject({
      plannerTaskId: "a1",
      plannedDays: 10,
      completion: 1,
      earned: 10,
    });
    expect(earned.perJiraTask.get("JIRA-2")?.earned).toBe(0);
    expect(earned.perJiraTask.get("JIRA-3")?.earned).toBe(5);
  });

  it("splits one Planner task across duplicate manual mappings", () => {
    const duplicate = snapshotOf([
      jiraEpic("JIRA-100", "Any epic", {}, "indeterminate", [
        jiraTask("JIRA-1", "A1 part one", "done", 3 * H),
        jiraTask("JIRA-2", "A1 part two", "indeterminate", 1 * H),
      ]),
    ]);
    const earned = earnedTaskDays(project, duplicate, {
      "JIRA-1": "a1",
      "JIRA-2": "a1",
    });
    expect(earned.perJiraTask.get("JIRA-1")?.plannedDays).toBe(7.5);
    expect(earned.perJiraTask.get("JIRA-2")?.plannedDays).toBe(2.5);
    expect(earned.total).toBe(7.5);
  });

  it("drives tracker status from tasks even when epic names do not match", () => {
    const tracker = fixtureTracker({
      snapshot: snap,
      epicMap: undefined,
      taskMap: {
        "JIRA-1": "a1",
        "JIRA-2": "a2",
        "JIRA-3": "q1",
      },
    });
    const status = trackerStatus(tracker, project, TEAMS, TODAY);
    expect(status.reason).toBeUndefined();
    expect(status.earnedDays).toBe(15);
  });
});

/* -------------------------------- status ---------------------------------- */

describe("trackerStatus", () => {
  it("reproduces the worked example of spec 7.5", () => {
    const s = trackerStatus(fixtureTracker(), fixtureProject(), TEAMS, TODAY);
    expect(s.kind).toBe("using-buffer");
    expect(s.today).toBe(TODAY);
    expect(s.plannedDays).toBe(35);
    expect(s.earnedDays).toBe(27.5);
    // The curve first reached 27.5 on 2026-10-16, five working days ago.
    expect(s.varianceDays).toBe(-5);
    expect(s.bufferDays).toBe(20);
    expect(s.bufferUsedDays).toBe(5); // 5 of 20 = 25%
    expect(s.overrunDays).toBe(0);
    expect(s.effortBufferDays).toBe(21);
    expect(s.unbufferedEnd).toBe(U);
    expect(s.bufferedEnd).toBe(B);
    expect(s.projectedFinish).toBe("2027-01-29"); // U + 5 working days
    expect(s.jiraSetDays).toBe(10); // 80h at 8h/day
    expect(s.jiraSpentDays).toBe(3.75); // 30h
    expect(s.jiraRemainingDays).toBe(6.25); // 50h
    expect(s.planRemainingDays).toBe(77.5); // 105 - 27.5
    expect(s.reason).toBeUndefined();
  });

  it("goes straight to over-buffer with no buffer at all", () => {
    const s = trackerStatus(
      fixtureTracker(),
      fixtureProject({ buffer: 0 }),
      TEAMS,
      TODAY,
    );
    expect(s.bufferDays).toBe(0);
    expect(s.varianceDays).toBe(-5);
    expect(s.bufferUsedDays).toBe(0);
    expect(s.overrunDays).toBe(5);
    expect(s.kind).toBe("over-buffer");
    expect(s.projectedFinish).toBe("2027-01-29");
  });

  it("is over-buffer once the whole buffer is gone", () => {
    // Nothing earned at all: ES is the working day before the start, so the
    // variance is the whole elapsed span (33 working days) — well past 20.
    const s = trackerStatus(
      fixtureTracker({ snapshot: snapshotOf([GAMMA]) }),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(s.earnedDays).toBe(0);
    expect(s.varianceDays).toBe(-workdaysBetween("2026-09-04", TODAY));
    expect(s.bufferUsedDays).toBe(20);
    expect(s.overrunDays).toBe(s.varianceDays * -1 - 20);
    expect(s.kind).toBe("over-buffer");
  });

  it("is ahead when everything is earned before the plan's finish", () => {
    const done = [
      jiraEpic("JIRA-100", "Alpha", {}, "done"),
      jiraEpic("JIRA-200", "Beta", {}, "done"),
      jiraEpic("JIRA-300", "Gamma", {}, "done"),
    ];
    const s = trackerStatus(
      fixtureTracker({ snapshot: snapshotOf(done) }),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(s.earnedDays).toBe(105);
    expect(s.varianceDays).toBe(65);
    expect(s.kind).toBe("ahead");
    expect(s.planRemainingDays).toBe(0);
    expect(s.projectedFinish).toBe("2026-10-23"); // finishing today
  });

  it("is on-plan when everything is earned exactly on the finish day", () => {
    const done = [
      jiraEpic("JIRA-100", "Alpha", {}, "done"),
      jiraEpic("JIRA-200", "Beta", {}, "done"),
      jiraEpic("JIRA-300", "Gamma", {}, "done"),
    ];
    const s = trackerStatus(
      fixtureTracker({ snapshot: snapshotOf(done) }),
      fixtureProject(),
      TEAMS,
      U,
    );
    expect(s.varianceDays).toBe(0);
    expect(s.kind).toBe("on-plan");
    expect(s.projectedFinish).toBe(U);
  });

  it("has no baseline without a project, and still shows Jira's own days", () => {
    const s = trackerStatus(fixtureTracker(), undefined, TEAMS, TODAY);
    expect(s.kind).toBe("no-baseline");
    expect(s.reason).toMatch(/project/i);
    expect(s.jiraRemainingDays).toBe(6.25);
    expect(s.unbufferedEnd).toBe(null);
  });

  it("has no baseline before the first refresh", () => {
    const s = trackerStatus(
      fixtureTracker({ snapshot: undefined }),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(s.kind).toBe("no-baseline");
    expect(s.reason).toMatch(/refresh/i);
  });

  it("has no baseline when nothing is mapped, but keeps the plan numbers", () => {
    const s = trackerStatus(
      fixtureTracker({ epicMap: undefined }),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(s.kind).toBe("no-baseline");
    expect(s.reason).toMatch(/mapped/i);
    expect(s.earnedDays).toBe(0);
    expect(s.plannedDays).toBe(35);
    expect(s.bufferDays).toBe(20);
    expect(s.planRemainingDays).toBe(105);
  });

  it("has no baseline when the project schedules nothing", () => {
    const empty = fixtureProject({ epics: [] });
    const s = trackerStatus(fixtureTracker(), empty, TEAMS, TODAY);
    expect(s.kind).toBe("no-baseline");
    expect(s.reason).toMatch(/no scheduled work/i);
  });

  it("converts Jira seconds with the tracker's hours per day", () => {
    const s = trackerStatus(
      fixtureTracker({ hoursPerDay: 6 }),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(s.jiraSpentDays).toBe(5); // 30h at 6h/day
    expect(s.jiraRemainingDays).toBeCloseTo(8.33, 2);
  });

  it("is deterministic", () => {
    const a = trackerStatus(fixtureTracker(), fixtureProject(), TEAMS, TODAY);
    const b = trackerStatus(fixtureTracker(), fixtureProject(), TEAMS, TODAY);
    expect(a).toEqual(b);
  });
});

describe("sampleFromStatus", () => {
  it("keeps the numbers worth remembering", () => {
    const s = trackerStatus(fixtureTracker(), fixtureProject(), TEAMS, TODAY);
    expect(sampleFromStatus(s)).toEqual({
      date: TODAY,
      plannedDays: 35,
      earnedDays: 27.5,
      varianceDays: -5,
      bufferUsedDays: 5,
      bufferDays: 20,
      jiraSpentDays: 3.75,
      jiraRemainingDays: 6.25,
    });
  });
});

/* ------------------------------- auto-mapping ----------------------------- */

describe("autoEpicMap", () => {
  const project = fixtureProject();

  it("matches on the normalised name, then on containment", () => {
    const snap = snapshotOf([
      jiraEpic("J-1", "  ALPHA  "),
      jiraEpic("J-2", "Beta   API"),
      jiraEpic("J-3", "Gam"),
      jiraEpic("J-4", "Delta"),
    ]);
    const map = autoEpicMap(project, snap);
    expect(map["J-1"]).toBe("e-alpha"); // exact after normalising
    expect(map["J-2"]).toBe("e-beta"); // planner name inside the summary
    expect(map["J-3"]).toBe("e-gamma"); // summary inside the planner name
    expect(map).not.toHaveProperty("J-4"); // no relation either way
  });

  it("matches a summary contained in the planner epic name", () => {
    const wide = fixtureProject();
    wide.epics[0].name = "Alpha platform work";
    const map = autoEpicMap(wide, snapshotOf([jiraEpic("J-1", "alpha")]));
    expect(map["J-1"]).toBe("e-alpha");
  });

  it("leaves an unmatched epic absent rather than guessing", () => {
    const map = autoEpicMap(project, snapshotOf([jiraEpic("J-9", "Zephyr")]));
    expect(Object.prototype.hasOwnProperty.call(map, "J-9")).toBe(false);
  });

  it("never overrides an existing entry, including an explicit null", () => {
    const snap = snapshotOf([
      jiraEpic("J-1", "Alpha"),
      jiraEpic("J-2", "Beta"),
    ]);
    const map = autoEpicMap(project, snap, {
      "J-1": null,
      "J-2": "e-gamma",
    });
    expect(map["J-1"]).toBe(null);
    expect(map["J-2"]).toBe("e-gamma");
  });

  it("does not mutate the map it was given", () => {
    const existing = { "J-1": null };
    const snap = snapshotOf([
      jiraEpic("J-1", "Alpha"),
      jiraEpic("J-2", "Beta"),
    ]);
    const map = autoEpicMap(project, snap, existing);
    expect(existing).toEqual({ "J-1": null });
    expect(map["J-2"]).toBe("e-beta");
  });
});

describe("autoTaskMap", () => {
  it("matches tasks across different Jira epic names", () => {
    const snap = snapshotOf([
      jiraEpic("E-1", "Completely reorganised", {}, "indeterminate", [
        jiraTask("J-1", "A1"),
        jiraTask("J-2", "[QA] Q1"),
      ]),
    ]);
    const map = autoTaskMap(fixtureProject(), snap);
    expect(map["J-1"]).toBe("a1");
    expect(map["J-2"]).toBe("q1");
  });

  it("tolerates changed punctuation and strong token overlap", () => {
    const project = fixtureProject();
    project.epics[0].tasks[0].name = "Checkout payment validation";
    const snap = snapshotOf([
      jiraEpic("E-1", "Different epic", {}, "indeterminate", [
        jiraTask("J-1", "Payment: checkout validation flow"),
      ]),
    ]);
    expect(autoTaskMap(project, snap)["J-1"]).toBe("a1");
  });

  it("does not guess an ambiguous or unrelated task", () => {
    const project = fixtureProject();
    project.epics[0].tasks[0].name = "Build checkout page";
    project.epics[0].tasks[1].name = "Test checkout page";
    const snap = snapshotOf([
      jiraEpic("E-1", "Different epic", {}, "indeterminate", [
        jiraTask("J-1", "Checkout page"),
        jiraTask("J-2", "Release analytics"),
      ]),
    ]);
    const map = autoTaskMap(project, snap);
    expect(map).not.toHaveProperty("J-1");
    expect(map).not.toHaveProperty("J-2");
  });

  it("preserves manual decisions and claims each Planner task once", () => {
    const snap = snapshotOf([
      jiraEpic("E-1", "Different epic", {}, "indeterminate", [
        jiraTask("J-1", "A1"),
        jiraTask("J-2", "A1"),
        jiraTask("J-3", "A2"),
      ]),
    ]);
    const map = autoTaskMap(fixtureProject(), snap, {
      "J-1": null,
      "J-3": "a3",
    });
    expect(map["J-1"]).toBe(null);
    expect(map["J-2"]).toBe("a1");
    expect(map["J-3"]).toBe("a3");
  });

  it("re-guesses matches that point into a different project", () => {
    const snap = snapshotOf([
      jiraEpic("E-1", "Different epic", {}, "indeterminate", [
        jiraTask("J-1", "A1"),
        jiraTask("J-2", "Nothing like it"),
      ]),
    ]);
    const map = autoTaskMap(fixtureProject(), snap, {
      "J-1": "task-in-old-baseline",
      "J-2": "also-gone",
    });
    expect(map["J-1"]).toBe("a1");
    expect(map).not.toHaveProperty("J-2");
  });
});

/* ------------------------------ team holidays ----------------------------- */

describe("team working days", () => {
  /** Weekdays from Mon 14 Dec 2026 to Fri 1 Jan 2027 — three weeks off. */
  function christmas(): string[] {
    const out: string[] = [];
    for (let day = 14; day <= 31; day++) out.push(`2026-12-${day}`);
    out.push("2027-01-01");
    return out.filter((d) => {
      const w = new Date(`${d}T00:00:00Z`).getUTCDay();
      return w !== 0 && w !== 6;
    });
  }

  function holidayTeams(offForSecond = true): Team[] {
    return [
      {
        id: "t",
        name: "T",
        members: [
          { id: "a", name: "A", specialization: "dev" },
          { id: "b", name: "B", specialization: "qa" },
        ],
        offDays: offForSecond
          ? { a: christmas(), b: christmas() }
          : { a: christmas() },
      },
    ];
  }

  /** Ten 5-day dev tasks from Mon 2 Nov; the plan pauses over Christmas. */
  function holidayProject(): Project {
    const project: Project = {
      id: "p",
      name: "P",
      startDate: "2026-11-02",
      planViewMode: "person",
      plan: null,
      buffer: 20,
      epics: [
        {
          id: "e",
          name: "E",
          tasks: Array.from({ length: 10 }, (_, i) => ({
            id: `k${i}`,
            name: `Task ${i}`,
            estimateDays: 5,
            specialization: "dev",
            excluded: false,
          })),
        },
      ],
    };
    return { ...project, plan: runPlan(project, holidayTeams(), "2000-01-01") };
  }

  function holidayTracker(done: number): Tracker {
    const children = Array.from({ length: 10 }, (_, i) =>
      jiraTask(`J-${i}`, `Task ${i}`, i < done ? "done" : "new"),
    );
    return {
      id: "tr",
      name: "",
      initiativeUrl: "",
      initiativeKey: "I-1",
      baseUrl: "",
      projectId: "p",
      snapshot: snapshotOf([
        jiraEpic("E-1", "E", {}, "indeterminate", children),
      ]),
      taskMap: Object.fromEntries(children.map((c, i) => [c.key, `k${i}`])),
    };
  }

  it("counts a day the whole team is off as nothing", () => {
    const cal = teamCalendar(holidayProject(), holidayTeams());
    expect(workdaysBetween("2026-12-11", "2027-01-08", cal)).toBe(5);
    expect(workdaysBetween("2026-12-11", "2027-01-08")).toBe(20);
    expect(addWorkdays("2026-12-11", 1, cal)).toBe("2027-01-04");
    expect(addWorkdays("2027-01-04", -1, cal)).toBe("2026-12-11");
  });

  it("counts a day half the team is off as half", () => {
    const cal = teamCalendar(holidayProject(), holidayTeams(false));
    expect(cal("2026-12-14")).toBe(0.5);
    expect(workdaysBetween("2026-12-11", "2027-01-08", cal)).toBe(12.5);
  });

  it("ignores people who are not on the project that day", () => {
    const project = {
      ...holidayProject(),
      helpers: [
        {
          id: "h",
          name: "Contractor",
          specialization: "dev",
          speed: 1,
          availableFrom: "2026-11-02",
          availableTo: "2026-11-30",
        },
      ],
    };
    const cal = teamCalendar(project, holidayTeams());
    // Everyone engaged in December is off; the contractor has already left.
    expect(cal("2026-12-14")).toBe(0);
    // And outside the holiday nobody being gone does not halve the day.
    expect(cal("2027-01-04")).toBe(1);
  });

  it("does not count the holiday as lead, or project a finish inside it", () => {
    const project = holidayProject();
    const teams = holidayTeams();
    // Six tasks finished is exactly on plan on Fri 11 Dec; the seventh was
    // planned for Fri 8 Jan, after the break.
    const onPlan = trackerStatus(
      holidayTracker(6),
      project,
      teams,
      "2026-12-11",
    );
    expect(onPlan.kind).toBe("on-plan");

    const ahead = trackerStatus(
      holidayTracker(7),
      project,
      teams,
      "2026-12-11",
    );
    expect(ahead.kind).toBe("ahead");
    // One task (5 working days), not the 20 weekdays between the dates.
    expect(ahead.varianceDays).toBe(5);
    expect(ahead.projectedFinish).toBe("2027-01-22");
    expect(ahead.marginDays).toBe(ahead.bufferDays + ahead.varianceDays);
  });

  it("changes nothing for a team with no days off", () => {
    expect(
      teamCalendar(
        holidayProject(),
        holidayTeams().map((t) => ({ ...t, offDays: {} })),
      )("2026-12-14"),
    ).toBe(1);
  });
});

/* --------------------------- by specialization ---------------------------- */

describe("status by specialization", () => {
  /** Jira issue J-<task id> for every plan task; `done` lists finished ones. */
  function taskTracker(done: string[], project: Project): Tracker {
    const ids = project.epics.flatMap((e) => e.tasks.map((t) => t.id));
    const children = ids.map((id) =>
      jiraTask(`J-${id}`, id.toUpperCase(), done.includes(id) ? "done" : "new"),
    );
    return fixtureTracker({
      epicMap: undefined,
      snapshot: snapshotOf([
        jiraEpic("E-1", "Everything", {}, "indeterminate", children),
      ]),
      taskMap: Object.fromEntries(ids.map((id) => [`J-${id}`, id])),
    });
  }

  it("says what closing the review queue today would buy", () => {
    const project = fixtureProject();
    const tracker = taskTracker(["a1", "a2", "a3"], project);
    const children = tracker.snapshot!.epics[0].children!;
    // a4 waits in review, b1 is ready; neither counts as earned yet.
    for (const [key, status] of [
      ["J-a4", "Code Review"],
      ["J-b1", "Ready"],
    ]) {
      const i = children.findIndex((c) => c.key === key);
      children[i] = { ...children[i], status, statusCategory: "indeterminate" };
    }
    const now = trackerStatus(tracker, project, TEAMS, TODAY);
    const w = awaitingCloseWhatIf(tracker, project, TEAMS, TODAY)!;

    expect(w.tasks).toBe(2);
    expect(w.statuses.map((e) => [e.status, e.tasks])).toEqual([
      ["Code Review", 1],
      ["Ready", 1],
    ]);
    expect(w.days).toBe(w.statuses[0].days + w.statuses[1].days);
    // Both are dev tasks: the queue sits with dev.
    // One developer (Dana), so the queue is as many working days as plan days.
    expect(w.bySpecialization).toEqual([
      {
        specialization: "dev",
        tasks: 2,
        days: w.days,
        people: 1,
        workingDays: w.days,
      },
    ]);
    expect(w.days).toBeGreaterThan(0);
    // Closed, they are earned, and the finish moves sooner.
    expect(w.closed.earnedDays).toBe(now.earnedDays + w.days);
    expect(w.closed.marginDays!).toBeGreaterThan(now.marginDays!);
    expect(w.closed.projectedFinish! < now.projectedFinish!).toBe(true);
  });

  it("shares a specialization's queue across its people", () => {
    const teams: Team[] = [
      {
        ...TEAMS[0],
        members: [
          ...TEAMS[0].members,
          { id: "m3", name: "Ari", specialization: "dev" },
          { id: "m4", name: "Sol", specialization: "dev" },
        ],
      },
    ];
    const project = fixtureProject();
    const tracker = taskTracker(["a1"], project);
    const children = tracker.snapshot!.epics[0].children!;
    const i = children.findIndex((c) => c.key === "J-a2");
    children[i] = { ...children[i], status: "In Review" };
    const w = awaitingCloseWhatIf(tracker, project, teams, TODAY)!;
    // a2 is 10 plan days; three developers get through it in 3.33 days.
    expect(w.bySpecialization).toEqual([
      {
        specialization: "dev",
        tasks: 1,
        days: 10,
        people: 3,
        workingDays: 3.33,
      },
    ]);
  });

  it("has nothing to say without a review queue", () => {
    const project = fixtureProject();
    expect(
      awaitingCloseWhatIf(taskTracker(["a1"], project), project, TEAMS, TODAY),
    ).toBeNull();
  });

  it("reads each specialization against its own part of the plan", () => {
    const project = fixtureProject();
    // Dev finished a1..a3 (30 days): the dev curve hit 30 on 10-16, a week
    // before TODAY. QA's only task was due 09-11 and is not done.
    const s = trackerStatus(
      taskTracker(["a1", "a2", "a3"], project),
      project,
      TEAMS,
      TODAY,
    );
    const dev = s.bySpecialization.find((r) => r.specialization === "dev")!;
    const qa = s.bySpecialization.find((r) => r.specialization === "qa")!;

    expect(dev.earnedDays).toBe(30);
    expect(dev.totalDays).toBe(100);
    expect(dev.varianceDays).toBe(-5);
    expect(dev.kind).toBe("behind");
    expect(dev.unbufferedEnd).toBe(U);
    expect(dev.projectedFinish).toBe("2027-01-29");
    expect(dev.marginDays).toBe(15);
    // Its own buffer: the slack from its finish without buffer to the deadline.
    expect(dev.bufferDays).toBe(20);
    expect(dev.marginDays).toBe(dev.bufferDays! + dev.varianceDays);

    expect(qa.earnedDays).toBe(0);
    expect(qa.plannedDays).toBe(5);
    // Behind by everything since its task was due, not since project start.
    expect(qa.varianceDays).toBe(-workdaysBetween("2026-09-10", TODAY));
    expect(qa.kind).toBe("behind");

    // Worst end-date margin first: dev finishes last.
    expect(s.bySpecialization[0].specialization).toBe("dev");
  });

  it("does not call a specialization behind before its work starts", () => {
    // Quinn (qa) only joins on 2 Nov, after TODAY.
    const project = fixtureProject({ memberStarts: { m2: "2026-11-02" } });
    const s = trackerStatus(taskTracker([], project), project, TEAMS, TODAY);
    const qa = s.bySpecialization.find((r) => r.specialization === "qa")!;
    expect(qa.kind).toBe("not-started");
    expect(qa.varianceDays).toBe(0);
    expect(qa.firstStart).toBe("2026-11-02");
  });

  it("flags a specialization nobody on the plan can do", () => {
    const project = fixtureProject();
    project.epics[0].tasks.push({
      id: "d1",
      name: "D1",
      estimateDays: 3,
      specialization: "design",
      excluded: false,
    });
    const s = trackerStatus(
      taskTracker(["a1"], project),
      project,
      TEAMS,
      TODAY,
    );
    expect(s.bySpecialization[0]).toMatchObject({
      specialization: "design",
      kind: "unscheduled",
      totalDays: 3,
    });
  });

  it("marks a specialization late once it would miss the end date", () => {
    const project = fixtureProject();
    // Nothing done by 2027-01-22: dev is ~95 days behind, far past B.
    const s = trackerStatus(taskTracker(["q1"], project), project, TEAMS, U);
    const dev = s.bySpecialization.find((r) => r.specialization === "dev")!;
    expect(dev.kind).toBe("late");
    expect(dev.marginDays!).toBeLessThan(0);
  });

  describe("with QA as the end phase", () => {
    const QA_END = { endPhase: ["qa"] };
    // The QA window used below: development must stop two weeks before B.
    const QA_WINDOW = { endPhase: ["qa"], devEndDate: "2027-02-05" };
    const row = (st: ReturnType<typeof trackerStatus>, spec: string) =>
      st.bySpecialization.find((r) => r.specialization === spec)!;

    it("suggests QA-like specializations but never applies them itself", () => {
      const project = fixtureProject();
      const base = baselinePlans(project, TEAMS);
      expect(suggestedEndPhase(project)).toEqual(["qa"]);
      expect(resolveDeadlines(undefined, project, base.buffered)).toEqual({
        startDate: START,
        startFromPlan: true,
        planStartDate: START,
        endDate: B,
        endDateFromPlan: true,
        planEndDate: B,
        devEndDate: null,
        devEndFromPlan: true,
        planDevEndDate: B,
        endPhase: [],
      });
    });

    it("takes the end of development from the development specializations' finish", () => {
      // QA runs long, so the plan ends with QA, after development.
      const project = fixtureProject();
      project.epics[2].tasks[3].estimateDays = 200;
      const base = baselinePlans(project, TEAMS);
      const d = resolveDeadlines(QA_END, project, base.buffered);
      expect(d.devEndDate).toBe(B);
      expect(d.devEndFromPlan).toBe(true);
      expect(d.endDate).toBe(base.bufferedEnd);
      expect(d.endDate! > B).toBe(true);
    });

    it("schedules QA back from the end date, with the buffer on its tasks", () => {
      // 5 days of QA stretched to 6 by the 20% buffer, one tester, end date
      // 02-19: it must start by 02-12, and 02-15 at the very latest.
      const project = fixtureProject();
      const s = trackerStatus(
        { ...taskTracker(["a1"], project), deadlines: QA_END },
        project,
        TEAMS,
        TODAY,
      );
      const qa = row(s, "qa");
      expect(qa.phase).toMatchObject({
        mustStartBy: "2027-02-12",
        latestStart: "2027-02-15",
        to: B,
        bufferDays: 1,
        capacityDays: 86,
        remainingDays: 5,
        // The plan's development runs to 02-19, so QA overlaps it.
        overlapsDevelopment: true,
      });
      expect(qa.phase?.schedule).toEqual([
        {
          taskId: "q1",
          name: "Q1",
          estimateDays: 5,
          days: 6,
          start: "2027-02-12",
          end: B,
          done: false,
        },
      ]);
      // Measured like development: nothing is due yet, so it is ahead by the
      // time left before it must start.
      expect(qa.plannedDays).toBe(0);
      expect(qa.varianceDays).toBe(79);
      expect(qa.marginDays).toBe(80);
      expect(qa.projectedFinish).toBe(B);
      expect(qa.kind).toBe("ahead");
    });

    it("judges development against the end of development, without QA", () => {
      const project = fixtureProject();
      const s = trackerStatus(
        { ...taskTracker(["a1", "a2", "a3"], project), deadlines: QA_WINDOW },
        project,
        TEAMS,
        TODAY,
      );
      expect(s.scope).toBe("development");
      expect(s.deadline).toBe("2027-02-05");
      expect(s.deadlineKind).toBe("dev-end");
      // A custom end of development re-times development to 09-07 → 02-05:
      // 110 working days with buffer, so 110 ÷ 1.2 ≈ 92 days without it.
      expect(s.window).toEqual({
        from: START,
        to: "2027-02-05",
        bufferPct: 20,
      });
      expect(s.unbufferedEnd).toBe("2027-01-12");
      expect(s.bufferDays).toBe(18);
      // 30 earned is 27.5 days' worth of the even pace (35 of 91.7 days in,
      // 38.18 expected): 7.5 behind it, which would finish 01-22. But the pace
      // asks 1.09 plan days a day of one developer: at the scheduler's 1 a day
      // the 70 left take until 01-29, 13 working days past the finish without
      // buffer. So what had to be done by today is what one developer needs
      // finished to do the rest by 01-12 — 40, in whole tasks — not 38.18.
      expect(s.capacityBound).toBe(true);
      expect(s.plannedDays).toBe(40);
      expect(s.varianceDays).toBe(-13);
      expect(s.projectedFinish).toBe("2027-01-29");
      expect(s.marginDays).toBe(5);
      expect(s.kind).toBe("using-buffer");
    });

    it("does not call QA behind just because the scheduler put it early", () => {
      const project = fixtureProject();
      const before = trackerStatus(
        taskTracker(["a1", "a2", "a3"], project),
        project,
        TEAMS,
        TODAY,
      );
      expect(row(before, "qa").kind).toBe("behind");

      const s = trackerStatus(
        { ...taskTracker(["a1", "a2", "a3"], project), deadlines: QA_WINDOW },
        project,
        TEAMS,
        TODAY,
      );
      const qa = row(s, "qa");
      expect(qa.kind).toBe("ahead");
      expect(qa.firstStart).toBe("2027-02-12");
      // Its start is after development ends on 02-05, so no overlap.
      expect(qa.phase?.overlapsDevelopment).toBe(false);
    });

    it("spends QA's buffer before it is late", () => {
      const project = fixtureProject();
      const at = (today: string) =>
        row(
          trackerStatus(
            { ...taskTracker(["a1"], project), deadlines: QA_END },
            project,
            TEAMS,
            today,
          ),
          "qa",
        );
      // On 02-12 it should have started: a day behind, inside its buffer.
      const using = at("2027-02-12");
      expect(using.varianceDays).toBe(-1);
      expect(using.marginDays).toBe(0);
      expect(using.kind).toBe("behind");
      // On 02-17, past even the latest start: late for the end date.
      const late = at("2027-02-17");
      expect(late.varianceDays).toBe(-4);
      expect(late.marginDays).toBe(-3);
      expect(late.projectedFinish).toBe("2027-02-24");
      expect(late.kind).toBe("late");
      expect(late.bufferDays).toBe(late.phase!.bufferDays);
    });

    it("flags QA that has to start before development ends", () => {
      // 15 days, 18 with buffer, must start by 01-27: before 02-05.
      const project = fixtureProject();
      project.epics[2].tasks[3].estimateDays = 15;
      const s = trackerStatus(
        { ...taskTracker([], project), deadlines: QA_WINDOW },
        project,
        TEAMS,
        TODAY,
      );
      const qa = row(s, "qa");
      expect(qa.phase?.mustStartBy).toBe("2027-01-27");
      expect(qa.phase?.latestStart).toBe("2027-02-01");
      expect(qa.phase?.overlapsDevelopment).toBe(true);
    });

    it("measures finished QA tasks against their dates", () => {
      // Q1 (5 days) then Q2 (10): with buffer Q1 runs 01-27 → 02-03 and Q2
      // 02-04 → 02-19; without it Q1 would be due 02-05.
      const project = fixtureProject();
      project.epics[2].tasks.push({
        id: "q2",
        name: "Q2",
        estimateDays: 10,
        specialization: "qa",
        excluded: false,
      });
      const s = trackerStatus(
        { ...taskTracker(["q1"], project), deadlines: QA_END },
        project,
        TEAMS,
        "2027-01-29",
      );
      const qa = row(s, "qa");
      expect(
        qa.phase?.schedule.map((i) => [i.taskId, i.start, i.end, i.done]),
      ).toEqual([
        ["q1", "2027-01-27", "2027-02-03", true],
        ["q2", "2027-02-04", B, false],
      ]);
      expect(qa.phase?.latestStart).toBe("2027-02-01");
      // Q1 done on 01-29 though due 02-03: 3 days ahead, 5 to spare.
      expect(qa.varianceDays).toBe(3);
      expect(qa.marginDays).toBe(5);
      expect(qa.kind).toBe("ahead");
    });

    it("uses dates you set, and flags development running past its end", () => {
      const project = fixtureProject();
      const s = trackerStatus(
        {
          ...taskTracker(["a1", "a2", "a3"], project),
          deadlines: {
            endDate: "2027-01-29",
            devEndDate: "2026-12-04",
            endPhase: ["qa"],
          },
        },
        project,
        TEAMS,
        TODAY,
      );
      // 09-07 → 12-04 is 65 working days; 65 ÷ 1.2 ≈ 55 without buffer.
      expect(s.deadline).toBe("2026-12-04");
      expect(s.unbufferedEnd).toBe("2026-11-20");
      expect(s.bufferDays).toBe(10);
      // The even pace alone would say 64.62 expected, 18.75 behind and a 12-17
      // finish, but one developer with 70 days left cannot finish before
      // 01-29. To be done by 11-20 they needed 80 finished by today.
      expect(s.plannedDays).toBe(80);
      expect(s.varianceDays).toBe(-50);
      expect(s.projectedFinish).toBe("2027-01-29");
      expect(s.marginDays).toBe(-40);
      expect(s.overrunDays).toBe(40);
      expect(s.kind).toBe("over-buffer");
      expect(row(s, "dev").kind).toBe("late");
      expect(row(s, "dev").unbufferedEnd).toBe("2026-11-20");
      // Counted back from the end date (01-29): 6 buffered days start 01-22.
      expect(row(s, "qa").phase?.mustStartBy).toBe("2027-01-22");
    });

    it("counts tasks still waiting for an estimate", () => {
      const project = fixtureProject();
      project.epics[2].tasks.push({
        id: "q2",
        name: "Q2",
        estimateDays: 0,
        specialization: "qa",
        excluded: true,
      });
      const s = trackerStatus(
        { ...taskTracker([], project), deadlines: QA_WINDOW },
        project,
        TEAMS,
        TODAY,
      );
      expect(row(s, "qa").unestimatedTasks).toBe(1);
    });
  });

  it("re-times from a start date set on the tracker", () => {
    const project = fixtureProject();
    const tracker = taskTracker(["a1", "a2", "a3"], project);
    // From the plan: 30 dev days done by TODAY is 5 days behind the scheduler.
    const plain = trackerStatus(tracker, project, TEAMS, TODAY);
    expect(plain.varianceDays).toBe(-5);
    expect(plain.window).toBeNull();

    // The work really began a week later. The project is re-planned from
    // then (its end date moves a week to 02-26) and progress is measured
    // against an even pace through 09-14 → 02-26: 120 days with buffer, 100
    // without, so 105 plan days at 1.05 a day.
    const s = trackerStatus(
      { ...tracker, deadlines: { startDate: "2026-09-14" } },
      project,
      TEAMS,
      TODAY,
    );
    expect(s.deadlines).toMatchObject({
      startDate: "2026-09-14",
      startFromPlan: false,
      planStartDate: START,
      endDate: "2027-02-26",
    });
    expect(s.window).toEqual({
      from: "2026-09-14",
      to: "2027-02-26",
      bufferPct: 20,
    });
    expect(s.unbufferedEnd).toBe("2027-01-29");
    expect(s.bufferDays).toBe(20);
    expect(s.plannedDays).toBe(31.5);
    // Dev keeps the even pace. QA, with none of its 1.5 days done, reads 30
    // days behind on its curve — but counted by people its 5 days of work are
    // done long before its finish without buffer, so it has lost nothing: it
    // reads on plan with its whole buffer left, not as having spent it all
    // (the people count never makes it read *ahead*, though).
    const spec = (name: string) =>
      s.bySpecialization.find((r) => r.specialization === name)!;
    expect(spec("dev")).toMatchObject({ kind: "on-plan", varianceDays: 0 });
    const qa = spec("qa");
    expect(qa).toMatchObject({
      kind: "on-plan",
      varianceDays: 0,
      marginDays: 20,
      bufferDays: 20,
      projectedFinish: qa.unbufferedEnd,
      peopleLate: { overflowDays: 0, days: 0, people: 1, perDay: 1 },
    });
    expect(qa.peopleLate!.finish! < qa.unbufferedEnd!).toBe(true);
    expect(s.marginDays).toBe(20);
    expect(s.kind).toBe("on-plan");
  });

  it("counts how late it lands by its people: 3 days over, 3 devs, 1 day", () => {
    const teams: Team[] = [
      {
        ...TEAMS[0],
        members: [
          ...TEAMS[0].members,
          { id: "m3", name: "Ari", specialization: "dev" },
          { id: "m4", name: "Sol", specialization: "dev" },
        ],
      },
    ];
    const project = fixtureProject();
    // 90 dev days left (a1 done). From 10-26 to 12-03 is 29 working days, so
    // three devs can do 87 of them: 3 days of work over, 1 day for all three.
    const s = trackerStatus(
      {
        ...taskTracker(["a1"], project),
        deadlines: { devEndDate: "2026-12-03" },
      },
      project,
      teams,
      TODAY,
    );
    const dev = s.bySpecialization.find((r) => r.specialization === "dev")!;
    expect(dev.kind).toBe("late");
    expect(dev.peopleLate).toEqual({
      overflowDays: 3,
      days: 1,
      people: 3,
      perDay: 3,
      finish: "2026-12-04",
    });
    expect(dev.marginDays).toBe(-1);
    expect(dev.projectedFinish).toBe("2026-12-04");
    expect(dev.marginDays).toBe(dev.bufferDays! + dev.varianceDays);
  });

  it("finishes on the same day by its people wherever the deadline is", () => {
    const teams: Team[] = [
      {
        ...TEAMS[0],
        members: [
          ...TEAMS[0].members,
          { id: "m3", name: "Ari", specialization: "dev" },
          { id: "m4", name: "Sol", specialization: "dev" },
        ],
      },
    ];
    const project = fixtureProject();
    // 90 dev days left for three devs is 30 working days from tomorrow: they
    // are done on 12-04, whichever end of development is set. Moving it later
    // adds days to spare; it never drags the finish along with it, and the
    // work fitting is never read as "finishes on the deadline, buffer gone".
    const read = (devEndDate: string) =>
      trackerStatus(
        { ...taskTracker(["a1"], project), deadlines: { devEndDate } },
        project,
        teams,
        TODAY,
      ).bySpecialization.find((r) => r.specialization === "dev")!;
    for (const [devEnd, margin] of [
      ["2026-12-03", -1],
      ["2026-12-08", 2],
      ["2026-12-11", 5],
    ] as const) {
      const dev = read(devEnd);
      expect(dev.projectedFinish).toBe("2026-12-04");
      expect(dev.peopleLate?.finish).toBe("2026-12-04");
      expect(dev.marginDays).toBe(margin);
      expect(dev.marginDays).toBe(dev.bufferDays! + dev.varianceDays);
      expect(dev.kind).toBe(margin < 0 ? "late" : "behind");
    }
  });

  it("takes the headline from the specialization that finishes last", () => {
    const project = fixtureProject();
    const s = trackerStatus(
      taskTracker(["a1", "a2", "a3"], project),
      project,
      TEAMS,
      TODAY,
    );
    const worst = s.bySpecialization.reduce((a, b) =>
      b.marginDays !== null && b.marginDays < (a.marginDays ?? Infinity)
        ? b
        : a,
    );
    expect(s.critical).toBe(worst.specialization);
    expect(s.projectedFinish).toBe(worst.projectedFinish);
    expect(s.marginDays).toBe(worst.marginDays);
    expect(s.overrunDays).toBe(Math.max(0, -worst.marginDays!));
  });

  it("with only an end date set, re-times everything to it", () => {
    const project = fixtureProject();
    const s = trackerStatus(
      {
        ...taskTracker(["a1", "a2", "a3"], project),
        deadlines: { endDate: "2027-02-05" },
      },
      project,
      TEAMS,
      TODAY,
    );
    expect(s.scope).toBe("all");
    expect(s.deadlineKind).toBe("end");
    expect(s.deadline).toBe("2027-02-05");
    expect(s.window).toEqual({ from: START, to: "2027-02-05", bufferPct: 20 });
    expect(s.unbufferedEnd).toBe("2027-01-12");
    expect(s.bufferDays).toBe(18);
    // The finish without buffer always comes before the finish with it.
    expect(s.unbufferedEnd! < s.deadline!).toBe(true);
  });

  it("measures against the scheduler when no date is custom", () => {
    const project = fixtureProject();
    const s = trackerStatus(
      {
        ...taskTracker(["a1", "a2", "a3"], project),
        deadlines: { endPhase: ["qa"] },
      },
      project,
      TEAMS,
      TODAY,
    );
    expect(s.window).toBeNull();
    expect(s.unbufferedEnd).toBe(U);
  });

  it("holds custom dates to what the team can do", () => {
    // A second developer halves development: 100 days over two people is 50
    // working days, 09-07 → 11-13, or 11-27 with buffer. Fix that as the end
    // of development, then take the second team away with the dates unmoved.
    const teams: Team[] = [
      ...TEAMS,
      {
        id: "team2",
        name: "Extra",
        members: [{ id: "m3", name: "Sam", specialization: "dev" }],
        offDays: {},
      },
    ];
    const deadlines = {
      endPhase: ["qa"],
      devEndDate: "2026-11-27",
      endDate: "2026-12-11",
    };
    const done = ["a1", "a2", "a3", "a4", "b1", "b2", "b3"];
    const both = fixtureProject();
    const one = fixtureProject({ teamInclusions: [{ teamId: "team1" }] });
    const read = (project: Project) =>
      trackerStatus(
        { ...taskTracker(done, project), deadlines },
        project,
        teams,
        TODAY,
      );

    // Both teams: 70 of 100 done 35 days into a 50-day pace is ahead of it.
    const withBoth = read(both);
    expect(withBoth.varianceDays).toBe(0);
    expect(withBoth.kind).toBe("on-plan");

    // One developer is still ahead of the even pace (the work was really done
    // by two), but the 30 days left take them until 12-04, a week past the end
    // of development. The even pace alone would have called that 11-13.
    const withOne = read(one);
    expect(withOne.projectedFinish).toBe("2026-12-04");
    expect(withOne.varianceDays).toBe(-15);
    expect(withOne.marginDays).toBe(-5);
    expect(withOne.kind).toBe("over-buffer");
    const dev = withOne.bySpecialization.find(
      (r) => r.specialization === "dev",
    );
    expect(dev?.kind).toBe("late");
    // Behind, so "expected by today" must not read as less than was done:
    // the even pace's figure would, beside a verdict that says the opposite.
    expect(dev?.capacityBound).toBe(true);
    expect(dev!.plannedDays).toBeGreaterThan(dev!.earnedDays);
    expect(withOne.plannedDays).toBeGreaterThan(withOne.earnedDays);
    expect(withBoth.capacityBound).toBeUndefined();
  });

  it("does not count finished work nobody on the plan can do", () => {
    // Nobody has "backend", so X1 is never scheduled and is not in the plan
    // total. Finishing it must not read as progress on the dev work left.
    const project = fixtureProject();
    project.epics[0].tasks.push({
      id: "x1",
      name: "X1",
      estimateDays: 10,
      specialization: "backend",
      excluded: false,
    });
    const without = trackerStatus(
      taskTracker(["a1", "a2", "a3"], project),
      project,
      TEAMS,
      TODAY,
    );
    const s = trackerStatus(
      taskTracker(["a1", "a2", "a3", "x1"], project),
      project,
      TEAMS,
      TODAY,
    );
    expect(s.earnedDays).toBe(30);
    expect(s.varianceDays).toBe(without.varianceDays);
    expect(
      s.bySpecialization.find((r) => r.specialization === "backend")?.kind,
    ).toBe("unscheduled");
  });

  it("is empty for epic-level comparisons", () => {
    const s = trackerStatus(fixtureTracker(), fixtureProject(), TEAMS, TODAY);
    expect(s.bySpecialization).toEqual([]);
  });
});

/* --------------------------------- purity --------------------------------- */

describe("added scope", () => {
  // The fixture's plan, all ten dev tasks mapped, plus one Jira task nobody
  // planned: J-X, 10 days in Jira. U 2027-01-22, B 2027-02-19.
  function scopeTracker(
    done: string[],
    addedScope: Tracker["addedScope"],
  ): Tracker {
    const project = fixtureProject();
    const ids = project.epics.flatMap((e) => e.tasks.map((t) => t.id));
    const children = [
      ...ids.map((id) =>
        jiraTask(
          `J-${id}`,
          id.toUpperCase(),
          done.includes(id) ? "done" : "new",
        ),
      ),
      jiraTask(
        "J-X",
        "Hotfix nobody planned",
        done.includes("x") ? "done" : "new",
        10 * 8 * H,
      ),
    ];
    return fixtureTracker({
      epicMap: undefined,
      snapshot: snapshotOf([
        jiraEpic("E-1", "Everything", {}, "indeterminate", children),
      ]),
      taskMap: {
        ...Object.fromEntries(ids.map((id) => [`J-${id}`, id])),
        "J-X": null,
      },
      addedScope,
    });
  }

  it("changes nothing when no issue is marked", () => {
    const project = fixtureProject();
    const out = withAddedScope(project, undefined, { a: "b" }, undefined);
    expect(out.project).toBe(project);
    expect(out.taskMap).toEqual({ a: "b" });
  });

  it("uses up buffer instead of moving the promised date", () => {
    const done = ["a1", "a2", "a3"];
    const without = trackerStatus(
      scopeTracker(done, undefined),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(without.unbufferedEnd).toBe(U);
    expect(without.marginDays).toBe(15);
    expect(without.jiraSetDays).toBe(0);

    const s = trackerStatus(
      scopeTracker(done, { "J-X": "dev" }),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    // Ten more dev days after the plan: done without buffer two weeks later,
    // but the promise is still the plan's own B.
    expect(s.unbufferedEnd).toBe("2027-02-05");
    expect(s.bufferedEnd).toBe(B);
    expect(s.deadline).toBe(B);
    expect(s.bufferDays).toBe(10);
    expect(s.varianceDays).toBe(-5);
    expect(s.marginDays).toBe(5);
    expect(s.kind).toBe("using-buffer");
    // It is this team's work, so Jira's totals count it too.
    expect(s.jiraSetDays).toBe(10);
    const dev = s.bySpecialization.find((r) => r.specialization === "dev")!;
    expect(dev.totalDays).toBe(110);
  });

  it("counts finished added scope as earned", () => {
    const s = trackerStatus(
      scopeTracker(["a1", "a2", "a3", "x"], { "J-X": "dev" }),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(s.earnedDays).toBe(40);
  });

  it("skips an added task Jira has no estimate for, and flags it", () => {
    const tracker = scopeTracker(["a1", "a2", "a3"], { "J-X": "qa" });
    const children = tracker.snapshot!.epics[0].children!;
    children[children.length - 1] = {
      ...children[children.length - 1],
      originalEstimateSec: 0,
    };
    const s = trackerStatus(tracker, fixtureProject(), TEAMS, TODAY);
    expect(s.unbufferedEnd).toBe(U);
    const qa = s.bySpecialization.find((r) => r.specialization === "qa")!;
    expect(qa.unestimatedTasks).toBe(1);
  });

  it("does not count a task with no estimate once it is done", () => {
    // As above, but the added task is finished: nothing left to estimate.
    const tracker = scopeTracker(["a1", "a2", "a3", "x"], { "J-X": "qa" });
    const children = tracker.snapshot!.epics[0].children!;
    children[children.length - 1] = {
      ...children[children.length - 1],
      originalEstimateSec: 0,
    };
    const s = trackerStatus(tracker, fixtureProject(), TEAMS, TODAY);
    const qa = s.bySpecialization.find((r) => r.specialization === "qa")!;
    expect(qa.unestimatedTasks).toBe(0);
  });
});

describe("teams sharing an initiative", () => {
  // Planner teams: Stars has Dana (dev) and Quinn (qa); Bulls has Ari (dev).
  const teams: Team[] = [
    { ...TEAMS[0], id: "stars", name: "Stars" },
    {
      id: "bulls",
      name: "Bulls",
      members: [{ id: "m3", name: "Ari", specialization: "dev" }],
      offDays: {},
    },
  ];
  const person = (displayName: string) => ({
    accountId: displayName.toLowerCase(),
    displayName,
  });

  // a* carry Jira's Team "Stars", b* are assigned to Ari (Bulls), g* and q1
  // have neither.
  function sharedTracker(project: Project, over: Partial<Tracker> = {}) {
    const ids = project.epics.flatMap((e) => e.tasks.map((t) => t.id));
    const children = ids.map((id) => ({
      ...jiraTask(`J-${id}`, id.toUpperCase(), id === "a1" ? "done" : "new"),
      ...(id.startsWith("a") ? { team: "Stars" } : {}),
      ...(id.startsWith("b") ? { assignee: person("ari") } : {}),
    }));
    return fixtureTracker({
      epicMap: undefined,
      snapshot: snapshotOf([
        jiraEpic("E-1", "Everything", {}, "indeterminate", children),
      ]),
      taskMap: Object.fromEntries(ids.map((id) => [`J-${id}`, id])),
      ...over,
    });
  }

  it("works out each task's team: set, Jira's Team, assignee, then epic", () => {
    const project = fixtureProject();
    const tracker = sharedTracker(project, { taskTeams: { "J-g1": "bulls" } });
    const owners = jiraTaskTeams(
      tracker.snapshot!,
      project,
      teams,
      tracker.taskTeams,
    );
    expect(owners.get("J-a2")).toEqual({ team: "Stars", source: "jira" });
    // Matched on name, whatever the case.
    expect(owners.get("J-b1")).toEqual({ team: "Bulls", source: "assignee" });
    expect(owners.get("J-g1")).toEqual({ team: "Bulls", source: "set" });
    // Neither: the epic is mostly Stars' (4 vs 3 + 1 set, a tie to the first).
    expect(owners.get("J-g2")).toEqual({ team: "Stars", source: "epic" });
  });

  it("lists the tracker's teams, most tasks first", () => {
    const project = fixtureProject();
    expect(trackerTeams(sharedTracker(project), project, teams)).toEqual([
      { name: "Stars", tasks: 8, plannerTeamId: "stars" },
      { name: "Bulls", tasks: 3, plannerTeamId: "bulls" },
    ]);
  });

  it("lists a Jira team the project has no Planner team for", () => {
    const project = fixtureProject();
    const tracker = sharedTracker(project);
    tracker.snapshot!.epics[0].children![0].team = "Lions";
    expect(
      trackerTeams(tracker, project, teams).map((t) => [
        t.name,
        t.plannerTeamId,
      ]),
    ).toEqual([
      ["Stars", "stars"],
      ["Bulls", "bulls"],
      ["Lions", null],
    ]);
  });

  it("reads one team alone: its tasks, its plan part, its people", () => {
    const project = fixtureProject();
    const all = trackerStatus(sharedTracker(project), project, teams, TODAY);
    const stars = trackerStatus(
      sharedTracker(project, { viewTeams: ["stars"] }),
      project,
      teams,
      TODAY,
    );
    expect(all.teamScope).toBeUndefined();
    expect(stars.teamScope).toEqual({
      teamNames: ["Stars"],
      peopleFrom: ["Stars"],
      otherTeamTasks: 3,
      noTeamTasks: 0,
      planTasksLeftOut: 3,
    });
    const dev = (s: typeof all) =>
      s.bySpecialization.find((r) => r.specialization === "dev")!;
    // All of dev is 100 days; Stars' share is a1-a4 and g1-g3.
    expect(dev(all).totalDays).toBe(100);
    expect(dev(stars).totalDays).toBe(70);
    expect(dev(stars).earnedDays).toBe(10);
  });

  it("keeps everyone's people for a Jira team with no Planner team", () => {
    const project = fixtureProject();
    const tracker = sharedTracker(project, { viewTeams: ["Lions"] });
    for (const c of tracker.snapshot!.epics[0].children!) {
      if (c.key.startsWith("J-a")) c.team = "Lions";
    }
    const s = trackerStatus(tracker, project, teams, TODAY);
    expect(s.teamScope).toMatchObject({ teamNames: ["Lions"], peopleFrom: [] });
    expect(s.kind).not.toBe("no-baseline");
  });

  it("reads every team when all of them are selected", () => {
    const project = fixtureProject();
    const s = trackerStatus(
      sharedTracker(project, { viewTeams: ["Stars", "Bulls"] }),
      project,
      teams,
      TODAY,
    );
    expect(s.teamScope).toBeUndefined();
  });

  it("shares a team's review queue across that team's people only", () => {
    const project = fixtureProject();
    const tracker = sharedTracker(project, { viewTeams: ["Stars"] });
    const children = tracker.snapshot!.epics[0].children!;
    for (const key of ["J-a2", "J-b2"]) {
      const i = children.findIndex((c) => c.key === key);
      children[i] = {
        ...children[i],
        status: "In Review",
        statusCategory: "indeterminate",
      };
    }
    const w = awaitingCloseWhatIf(tracker, project, teams, TODAY)!;
    // Only Stars' a2 (b2 is Bulls'), and only Dana to close it.
    expect(w.tasks).toBe(1);
    expect(w.bySpecialization).toEqual([
      { specialization: "dev", tasks: 1, days: 10, people: 1, workingDays: 10 },
    ]);
  });
});

describe("isAwaitingClose", () => {
  const at = (status: string, category: JiraStatusCategory = "indeterminate") =>
    isAwaitingClose({ ...jiraTask("K-1", "x", category), status });

  it("matches review and ready states that are not done", () => {
    expect(at("Review")).toBe(true);
    expect(at("Code Review")).toBe(true);
    expect(at("Ready for Review")).toBe(true);
    expect(at("Ready")).toBe(true);
    expect(at("Ready for QA")).toBe(true);
  });

  it("leaves out work not started, in progress, or done", () => {
    expect(at("Ready for Development", "new")).toBe(false);
    expect(at("Ready to start", "new")).toBe(false);
    expect(at("In Progress")).toBe(false);
    expect(at("Reviewed", "done")).toBe(false);
    expect(at("Ready", "done")).toBe(false);
  });
});

describe("untracked epics", () => {
  // The plan's own epic, and "Other team" with a 20-day task marked as added
  // scope and a task that happens to share a plan task's name.
  function twoEpicTracker(untrackedEpics?: string[]): Tracker {
    const project = fixtureProject();
    const ids = project.epics.flatMap((e) => e.tasks.map((t) => t.id));
    const ours = ids.map((id) =>
      jiraTask(
        `J-${id}`,
        id.toUpperCase(),
        ["a1", "a2", "a3"].includes(id) ? "done" : "new",
      ),
    );
    const theirs = [
      jiraTask("O-1", "Their migration", "done", 20 * 8 * H),
      jiraTask("O-2", "A4", "new", 8 * H),
    ];
    return fixtureTracker({
      epicMap: undefined,
      snapshot: snapshotOf([
        // Theirs first, so its "A4" is reached before ours.
        jiraEpic("E-2", "Other team", {}, "indeterminate", theirs),
        jiraEpic("E-1", "Ours", {}, "indeterminate", ours),
      ]),
      taskMap: {
        ...Object.fromEntries(ids.map((id) => [`J-${id}`, id])),
        "O-1": null,
      },
      addedScope: { "O-1": "dev" },
      untrackedEpics,
    });
  }

  it("leaves everything under an untracked epic out, added scope included", () => {
    const tracked = trackerStatus(
      twoEpicTracker(),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(tracked.unbufferedEnd).not.toBe(U); // O-1 adds 20 dev days
    expect(tracked.earnedDays).toBe(50);

    const s = trackerStatus(
      twoEpicTracker(["E-2"]),
      fixtureProject(),
      TEAMS,
      TODAY,
    );
    expect(s.unbufferedEnd).toBe(U);
    expect(s.earnedDays).toBe(30);
    expect(s.jiraSetDays).toBe(0);
  });

  it("keeps the settings under it, so tracking it again restores them", () => {
    const tracker = twoEpicTracker(["E-2"]);
    const out = trackedMapping(tracker);
    expect(out.taskMap?.["O-1"]).toBeNull();
    expect(out.taskMap?.["O-2"]).toBeNull();
    expect(out.addedScope).toEqual({});
    // The tracker itself still has them.
    expect(tracker.addedScope).toEqual({ "O-1": "dev" });
    expect(trackedMapping(twoEpicTracker()).addedScope).toEqual({
      "O-1": "dev",
    });
  });

  it("never name-matches an issue under an untracked epic", () => {
    const tracker = twoEpicTracker(["E-2"]);
    const project = fixtureProject();
    const existing = { ...tracker.taskMap };
    delete existing["J-a4"];
    const skip = untrackedIssueKeys(tracker.snapshot, ["E-2"]);
    const map = autoTaskMap(project, tracker.snapshot!, existing, skip);
    // O-2 is called "A4" too, but only our J-a4 may claim plan task a4.
    expect(map["O-2"]).toBeUndefined();
    expect(map["J-a4"]).toBe("a4");
  });
});

describe("tracking module purity", () => {
  it("does not import React or reference the DOM", () => {
    const src = readFileSync("src/tracking.ts", "utf8");
    expect(src).not.toMatch(/from\s+['"]react/);
    // DOM globals as property access (window.x / document.x), not the English
    // words that appear in comments.
    expect(src).not.toMatch(/\bdocument\.\w/);
    expect(src).not.toMatch(/\bwindow\.\w/);
  });

  it("never reads the clock", () => {
    const src = readFileSync("src/tracking.ts", "utf8");
    expect(src).not.toMatch(/Date\.now\(/);
    expect(src).not.toMatch(/new Date\(\)/);
  });
});
