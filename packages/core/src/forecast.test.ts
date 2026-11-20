import { describe, it, expect } from "vitest";
import type {
  JiraIssue,
  JiraStatusCategory,
  Project,
  Team,
  Tracker,
} from "./types";
import { priorityRank, remainingWork } from "./forecast";

const H = 3600;
const TODAY = "2026-11-19"; // Thursday

const TEAMS: Team[] = [
  {
    id: "team1",
    name: "Core",
    members: [
      { id: "m1", name: "Ana", specialization: "dev" },
      { id: "m2", name: "Bo Lind", specialization: "dev" },
      { id: "m3", name: "Cy", specialization: "qa" },
    ],
    offDays: {},
  },
];

function task(
  id: string,
  estimateDays: number,
  specialization = "dev",
  dependsOn?: string[],
) {
  return {
    id,
    name: id.toUpperCase(),
    estimateDays,
    specialization,
    excluded: false,
    ...(dependsOn ? { dependsOn } : {}),
  };
}

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
        task("t1", 3), // done
        task("t2", 4), // in progress, Bo, 2 days left in Jira
        task("t3", 5), // to do
        task("t4", 0), // no estimate
        task("t5", 2), // in review
        task("t6", 3, "qa", ["t3"]), // QA after t3
      ],
    },
  ],
};

function issue(
  key: string,
  statusCategory: JiraStatusCategory,
  status: string,
  over: Partial<JiraIssue> = {},
): JiraIssue {
  return {
    key,
    summary: key,
    issueType: "Task",
    status,
    statusCategory,
    updated: "2026-11-19T09:00:00.000Z",
    ...over,
  };
}

function tracker(children: JiraIssue[]): Tracker {
  return {
    id: "tr1",
    name: "Atlas tracking",
    initiativeUrl: "https://acme.atlassian.net/browse/ATL-1",
    initiativeKey: "ATL-1",
    baseUrl: "https://acme.atlassian.net",
    projectId: "p1",
    epicMap: { "J-E": "e1" },
    taskMap: {
      "J-1": "t1",
      "J-2": "t2",
      "J-3": "t3",
      "J-4": "t4",
      "J-5": "t5",
      "J-6": "t6",
    },
    snapshot: {
      fetchedAt: "2026-11-19T09:00:00.000Z",
      initiative: issue("ATL-1", "indeterminate", "In Progress"),
      epics: [
        {
          ...issue("J-E", "indeterminate", "In Progress"),
          issueType: "Epic",
          children,
          totals: {
            originalSec: 0,
            spentSec: 0,
            remainingSec: 0,
            done: 0,
            all: children.length,
          },
        },
      ],
      fieldIds: {},
    },
  };
}

const CHILDREN = [
  issue("J-1", "done", "Done"),
  issue("J-2", "indeterminate", "In Progress", {
    assignee: { accountId: "acc-bo", displayName: "Bo  Lind" },
    remainingEstimateSec: 16 * H,
  }),
  issue("J-3", "new", "To Do"),
  issue("J-4", "new", "To Do"),
  issue("J-5", "indeterminate", "In Review"),
  issue("J-6", "new", "To Do"),
];

describe("remainingWork", () => {
  // As if everything waiting to be closed were closed today; the default,
  // which counts it as work left, is covered below.
  const work = remainingWork(tracker(CHILDREN), PROJECT, TEAMS, TODAY, {
    countWaiting: false,
  })!;
  const item = (id: string) => work.items.find((a) => a.taskId === id);
  const person = (name: string) => work.people.find((p) => p.name === name)!;

  it("plans only estimated work that is still open", () => {
    expect(work.items.map((a) => a.taskId).sort()).toEqual(["t2", "t3", "t6"]);
    expect(work.waitingToClose).toEqual({
      tasks: 1,
      days: 2,
      bySpecialization: [{ specialization: "dev", tasks: 1, days: 2 }],
    });
    expect(work.unestimated).toBe(1);
    expect(work.unassigned).toEqual([]);
  });

  it("keeps started work with its Jira assignee, for what is left of it", () => {
    expect(item("t2")).toMatchObject({
      memberName: "Bo Lind",
      inProgress: true,
      estimateDays: 2,
      start: "2026-11-19",
      end: "2026-11-20",
      jiraKeys: ["J-2"],
      assignedBy: "jira",
      inPlan: true,
    });
    expect(person("Bo Lind")).toMatchObject({
      current: [item("t2")],
      next: null,
      finish: "2026-11-20",
    });
  });

  it("hands out the rest from today, without buffer", () => {
    // Ana is free today; Bo only after his task. 5 days: Thu → next Wed.
    expect(item("t3")).toMatchObject({
      memberName: "Ana",
      inProgress: false,
      estimateDays: 5,
      start: "2026-11-19",
      end: "2026-11-25",
      assignedBy: "planner",
    });
    expect(person("Ana").next).toBe(item("t3"));
  });

  it("still waits for open prerequisites, and says who finishes last", () => {
    expect(item("t6")).toMatchObject({
      memberName: "Cy",
      start: "2026-11-26",
      end: "2026-11-30",
    });
    expect(work.finish).toBe("2026-11-30");
    expect(work.people.map((p) => [p.name, p.finish])).toEqual([
      ["Cy", "2026-11-30"],
      ["Ana", "2026-11-25"],
      ["Bo Lind", "2026-11-20"],
    ]);
  });

  it("takes the whole estimate when Jira has nothing left to say", () => {
    const children = CHILDREN.map((i) =>
      i.key === "J-2" ? { ...i, remainingEstimateSec: undefined } : i,
    );
    const w = remainingWork(tracker(children), PROJECT, TEAMS, TODAY)!;
    expect(w.items.find((a) => a.taskId === "t2")).toMatchObject({
      estimateDays: 4,
      end: "2026-11-24",
    });
  });

  it("drops prerequisites that are already done", () => {
    const children = CHILDREN.map((i) =>
      i.key === "J-3" ? { ...i, statusCategory: "done" as const } : i,
    );
    const w = remainingWork(tracker(children), PROJECT, TEAMS, TODAY)!;
    expect(w.items.find((a) => a.taskId === "t6")).toMatchObject({
      memberName: "Cy",
      start: "2026-11-19",
    });
  });

  it("lists someone with nothing they can do as idle, last", () => {
    const teams: Team[] = [
      {
        ...TEAMS[0],
        members: [
          ...TEAMS[0].members,
          { id: "m4", name: "Di", specialization: "design" },
        ],
      },
    ];
    const w = remainingWork(tracker(CHILDREN), PROJECT, teams, TODAY)!;
    expect(w.people.at(-1)).toMatchObject({
      name: "Di",
      tasks: 0,
      next: null,
      finish: null,
    });
  });

  it("gives a task assigned in Jira but not started to its assignee", () => {
    // Unheld, t3 would go to Ana (free today). Jira has it on Bo, so he takes
    // it once his task in progress is done, and Ana has nothing.
    const children = CHILDREN.map((i) =>
      i.key === "J-3"
        ? { ...i, assignee: { accountId: "acc-bo", displayName: "Bo Lind" } }
        : i,
    );
    const w = remainingWork(tracker(children), PROJECT, TEAMS, TODAY, {
      countWaiting: false,
    })!;
    expect(w.items.find((a) => a.taskId === "t3")).toMatchObject({
      memberName: "Bo Lind",
      assignedBy: "jira",
      inProgress: false,
      start: "2026-11-23",
      end: "2026-11-27",
    });
    expect(w.people.find((p) => p.name === "Bo Lind")!.next?.taskId).toBe("t3");
    expect(w.people.find((p) => p.name === "Ana")!.tasks).toBe(0);
  });

  describe("the order of the work not started yet", () => {
    const SOLO: Team[] = [
      {
        id: "team1",
        name: "Core",
        members: [{ id: "m1", name: "Ana", specialization: "dev" }],
        offDays: {},
      },
    ];
    const project: Project = {
      ...PROJECT,
      epics: [
        {
          id: "e1",
          name: "Alpha",
          tasks: [task("t1", 1), task("t2", 1), task("t3", 1)],
        },
      ],
    };
    const order = (children: JiraIssue[]) =>
      remainingWork(tracker(children), project, SOLO, TODAY)!.items.map(
        (a) => a.taskId,
      );
    const todo = (key: string, over: Partial<JiraIssue> = {}) =>
      issue(key, "new", "To Do", over);
    const ana = { accountId: "acc-ana", displayName: "Ana" };

    it("follows the plan when nothing sets them apart", () => {
      expect(order([todo("J-1"), todo("J-2"), todo("J-3")])).toEqual([
        "t1",
        "t2",
        "t3",
      ]);
    });

    it("takes what Jira already has on someone first", () => {
      expect(
        order([todo("J-1"), todo("J-2"), todo("J-3", { assignee: ana })]),
      ).toEqual(["t3", "t1", "t2"]);
    });

    it("does low priority later and high priority sooner", () => {
      expect(
        order([
          todo("J-1", { priority: "Low" }),
          todo("J-2"),
          todo("J-3", { priority: "Highest" }),
        ]),
      ).toEqual(["t3", "t2", "t1"]);
    });

    it("puts assigned work before priority", () => {
      expect(
        order([
          todo("J-1", { priority: "Highest" }),
          todo("J-2", { priority: "Lowest", assignee: ana }),
          todo("J-3"),
        ]),
      ).toEqual(["t2", "t1", "t3"]);
    });

    it("ranks both of Jira's priority schemes, anything else as Medium", () => {
      expect(
        [
          "Blocker",
          "High",
          "Major",
          "Medium",
          "Minor",
          "Lowest",
          "P9",
          undefined,
        ].map(priorityRank),
      ).toEqual([0, 1, 1, 2, 3, 4, 2, 2]);
    });
  });

  it("marks bugs and carries the priority", () => {
    const children = CHILDREN.map((i) =>
      i.key === "J-3" ? { ...i, issueType: "Bug", priority: "High" } : i,
    );
    const w = remainingWork(tracker(children), PROJECT, TEAMS, TODAY)!;
    expect(w.items.find((a) => a.taskId === "t3")).toMatchObject({
      bug: true,
      priority: "High",
    });
    expect(w.items.find((a) => a.taskId === "t2")).toMatchObject({
      bug: false,
    });
  });

  it("spreads the work over more days at less than full capacity", () => {
    const full = remainingWork(tracker(CHILDREN), PROJECT, TEAMS, TODAY)!;
    const half = remainingWork(tracker(CHILDREN), PROJECT, TEAMS, TODAY, {
      capacity: 0.5,
    })!;
    const days = (w: typeof full, id: string) =>
      w.items.find((a) => a.taskId === id)!.workDays;
    // t3 (5 days, scheduled) and t2 (2 days left, in progress with Bo).
    expect([days(full, "t3"), days(full, "t2")]).toEqual([5, 2]);
    expect([days(half, "t3"), days(half, "t2")]).toEqual([10, 4]);
    expect(half.finish! > full.finish!).toBe(true);
    // Out of range reads as full capacity.
    expect(
      remainingWork(tracker(CHILDREN), PROJECT, TEAMS, TODAY, { capacity: 3 }),
    ).toEqual(full);
  });

  it("counts a task skipped for having no estimate while Jira has it open", () => {
    // How a plan built from Jira brings in an issue nobody estimated.
    const project: Project = {
      ...PROJECT,
      epics: PROJECT.epics.map((e) => ({
        ...e,
        tasks: e.tasks.map((t) =>
          t.id === "t4" ? { ...t, excluded: true } : t,
        ),
      })),
    };
    const w = remainingWork(tracker(CHILDREN), project, TEAMS, TODAY)!;
    expect(w.unestimatedTasks.map((u) => u.key)).toEqual(["J-4"]);
    const planned = remainingWork(tracker(CHILDREN), project, TEAMS, TODAY, {
      unestimatedDays: 2,
    })!;
    expect(planned.items.find((a) => a.taskId === "t4")).toMatchObject({
      estimateDays: 2,
      estimateFrom: "assumed",
    });
    // Skipped with an estimate is left out on purpose, and stays out.
    const onPurpose: Project = {
      ...PROJECT,
      epics: PROJECT.epics.map((e) => ({
        ...e,
        tasks: e.tasks.map((t) =>
          t.id === "t3" ? { ...t, excluded: true } : t,
        ),
      })),
    };
    const out = remainingWork(tracker(CHILDREN), onPurpose, TEAMS, TODAY, {
      unestimatedDays: 2,
    })!;
    expect(out.items.find((a) => a.taskId === "t3")).toBeUndefined();
  });

  it("plans tasks with no estimate at the days asked for", () => {
    const w = remainingWork(tracker(CHILDREN), PROJECT, TEAMS, TODAY, {
      unestimatedDays: 1.5,
    })!;
    expect(w.unestimated).toBe(0);
    expect(w.unestimatedTasks).toEqual([]);
    expect(w.assumed).toBe(1);
    expect(w.items.find((a) => a.taskId === "t4")).toMatchObject({
      estimateDays: 1.5,
      plannedDays: 1.5,
      estimateFrom: "assumed",
    });
    const without = remainingWork(tracker(CHILDREN), PROJECT, TEAMS, TODAY)!;
    expect(without.assumed).toBe(0);
    expect(without.unestimated).toBe(1);
  });

  it("uses Jira's estimate when the plan has none", () => {
    const children = CHILDREN.map((i) =>
      i.key === "J-4" ? { ...i, originalEstimateSec: 24 * H } : i,
    );
    const w = remainingWork(tracker(children), PROJECT, TEAMS, TODAY)!;
    expect(w.unestimated).toBe(0);
    expect(w.items.find((a) => a.taskId === "t4")).toMatchObject({
      estimateDays: 3,
      inPlan: true,
    });
  });

  describe("Jira tasks with no plan task", () => {
    const extra = (key: string, over: Partial<JiraIssue> = {}) =>
      issue(key, "new", "To Do", {
        summary: `Extra ${key}`,
        originalEstimateSec: 16 * H,
        ...over,
      });

    it("plans them on Jira's estimate, as the most common specialization in their epic", () => {
      const w = remainingWork(
        tracker([...CHILDREN, extra("J-9")]),
        PROJECT,
        TEAMS,
        TODAY,
      )!;
      // Alpha's planned tasks are mostly dev, so it is dev work: 2 days.
      expect(w.items.find((a) => a.taskName === "Extra J-9")).toMatchObject({
        specialization: "dev",
        estimateDays: 2,
        inPlan: false,
        assignedBy: "planner",
        jiraKeys: ["J-9"],
        epicId: "e1",
      });
    });

    it("takes its specialization from a label, or its assignee", () => {
      const w = remainingWork(
        tracker([
          ...CHILDREN,
          extra("J-10", { assignee: { accountId: "x", displayName: "Cy" } }),
          extra("J-11", { labels: ["QA"] }),
        ]),
        PROJECT,
        TEAMS,
        TODAY,
      )!;
      const byKey = (k: string) => w.items.find((a) => a.jiraKeys[0] === k);
      expect(byKey("J-10")).toMatchObject({
        specialization: "qa",
        memberName: "Cy",
        assignedBy: "jira",
      });
      expect(byKey("J-11")).toMatchObject({
        specialization: "qa",
        memberName: "Cy",
        assignedBy: "planner",
      });
    });

    it("lists one it can't place, and skips untracked epics", () => {
      const t = tracker(CHILDREN);
      const snapshot = t.snapshot!;
      const w = remainingWork(
        {
          ...t,
          untrackedEpics: ["J-OFF"],
          snapshot: {
            ...snapshot,
            epics: [
              ...snapshot.epics,
              {
                ...snapshot.epics[0],
                key: "J-NEW",
                summary: "New epic",
                children: [extra("J-20")],
              },
              {
                ...snapshot.epics[0],
                key: "J-OFF",
                summary: "Untracked",
                children: [extra("J-30", { labels: ["dev"] })],
              },
            ],
          },
        },
        PROJECT,
        TEAMS,
        TODAY,
      )!;
      expect(w.noSpecialization).toEqual([
        { key: "J-20", summary: "Extra J-20" },
      ]);
      expect(w.items.some((a) => a.jiraKeys.includes("J-30"))).toBe(false);
    });

    it("plans nice-to-have epics only when asked, and marks them", () => {
      const t = tracker(CHILDREN);
      const snapshot = t.snapshot!;
      const nice: Tracker = {
        ...t,
        niceToHaveEpics: ["J-NICE"],
        snapshot: {
          ...snapshot,
          epics: [
            ...snapshot.epics,
            {
              ...snapshot.epics[0],
              key: "J-NICE",
              summary: "Nice",
              children: [extra("J-40", { labels: ["dev"] })],
            },
          ],
        },
      };
      const without = remainingWork(nice, PROJECT, TEAMS, TODAY)!;
      expect(without.items.some((a) => a.jiraKeys.includes("J-40"))).toBe(
        false,
      );
      const withNice = remainingWork(nice, PROJECT, TEAMS, TODAY, {
        includeNiceToHave: true,
      })!;
      const item = withNice.items.find((a) => a.jiraKeys.includes("J-40"));
      expect(item).toMatchObject({ niceToHave: true, specialization: "dev" });
      expect(withNice.items.filter((a) => a.niceToHave)).toHaveLength(1);
    });
  });

  describe("tasks waiting to be closed", () => {
    it("plans only To Do and In Progress by default", () => {
      const w = remainingWork(tracker(CHILDREN), PROJECT, TEAMS, TODAY)!;
      expect(w.countWaiting).toBe(false);
      expect(w.items.some((a) => a.taskId === "t5")).toBe(false);
      expect(w.waitingToClose.bySpecialization).toEqual([
        { specialization: "dev", tasks: 1, days: 2 },
      ]);
    });

    it("can plan them too, as the status counts them", () => {
      const w = remainingWork(tracker(CHILDREN), PROJECT, TEAMS, TODAY, {
        countWaiting: true,
      })!;
      expect(w.countWaiting).toBe(true);
      expect(w.waitingToClose).toMatchObject({ tasks: 1, days: 2 });
      // Its whole estimate, not Jira's remaining: nothing earns until Done.
      expect(w.items.find((a) => a.taskId === "t5")).toMatchObject({
        waiting: true,
        inProgress: false,
        estimateDays: 2,
        plannedDays: 2,
        assignedBy: "planner",
      });
    });

    it("keeps one with its Jira assignee when planned", () => {
      const children = CHILDREN.map((i) =>
        i.key === "J-5"
          ? { ...i, assignee: { accountId: "a", displayName: "Ana" } }
          : i,
      );
      const w = remainingWork(tracker(children), PROJECT, TEAMS, TODAY, {
        countWaiting: true,
      })!;
      expect(w.items.find((a) => a.taskId === "t5")).toMatchObject({
        memberName: "Ana",
        assignedBy: "jira",
      });
    });
  });

  describe("matching Jira assignees to people", () => {
    const team = (names: string[]): Team[] => [
      {
        id: "team1",
        name: "Core",
        members: names.map((name, i) => ({
          id: `p${i}`,
          name,
          specialization: "dev",
        })),
        offDays: {},
      },
    ];
    const holder = (teams: Team[], displayName: string) => {
      const children = CHILDREN.map((i) =>
        i.key === "J-3"
          ? { ...i, assignee: { accountId: "x", displayName } }
          : i,
      );
      const w = remainingWork(tracker(children), PROJECT, teams, TODAY)!;
      const t3 = w.items.find((a) => a.taskId === "t3")!;
      return t3.assignedBy === "jira" ? t3.memberName : null;
    };

    it("matches a short name to the full Jira name", () => {
      expect(holder(team(["Michał K", "Michał W"]), "Michal Kowalski")).toBe(
        "Michał K",
      );
      expect(holder(team(["Ana", "Bo"]), "Ana Kowalska")).toBe("Ana");
    });

    it("never guesses between two people who both fit", () => {
      expect(holder(team(["Michał K", "Michał Kr"]), "Michał Kowalski")).toBe(
        "Michał K",
      );
      expect(holder(team(["Michał K", "Michał K."]), "Michał Kowalski")).toBe(
        null,
      );
      expect(holder(team(["Michał", "Michał W"]), "Michał Kowalski")).toBe(
        null,
      );
    });
  });

  describe("nothing open drops out of sight", () => {
    it("keeps work in progress Jira has nothing left on, at its whole estimate", () => {
      const children = CHILDREN.map((i) =>
        i.key === "J-2" ? { ...i, remainingEstimateSec: 0 } : i,
      );
      const w = remainingWork(tracker(children), PROJECT, TEAMS, TODAY)!;
      expect(w.items.find((a) => a.taskId === "t2")).toMatchObject({
        memberName: "Bo Lind",
        inProgress: true,
        estimateDays: 4,
      });
    });

    it("reads a specialization tag in the summary before the epic's", () => {
      // Alpha's planned work is mostly dev; the tag says this one is QA.
      const w = remainingWork(
        tracker([
          ...CHILDREN,
          issue("J-12", "new", "To Do", {
            summary: "[QA][Polishing] Smoke test",
            originalEstimateSec: 8 * H,
          }),
        ]),
        PROJECT,
        TEAMS,
        TODAY,
      )!;
      expect(w.items.find((a) => a.jiraKeys[0] === "J-12")).toMatchObject({
        specialization: "qa",
        memberName: "Cy",
      });
    });

    it("names tasks with no estimate, and who is on them", () => {
      const children = CHILDREN.map((i) =>
        i.key === "J-4"
          ? {
              ...i,
              statusCategory: "indeterminate" as const,
              status: "In Progress",
              assignee: { accountId: "acc-bo", displayName: "Bo Lind" },
            }
          : i,
      );
      const w = remainingWork(tracker(children), PROJECT, TEAMS, TODAY)!;
      expect(w.unestimated).toBe(1);
      expect(w.unestimatedTasks).toEqual([
        {
          key: "J-4",
          name: "T4",
          specialization: "dev",
          inProgress: true,
          memberId: "m2",
          jiraAssignee: "Bo Lind",
        },
      ]);
      expect(w.people.find((p) => p.name === "Bo Lind")!.unestimated).toEqual(
        w.unestimatedTasks,
      );
    });
  });

  it("keeps each specialization together, the one finishing last on top", () => {
    // By finish alone it would read Ana (dev), Cy (qa), Bo (dev).
    const project: Project = {
      ...PROJECT,
      epics: [
        {
          id: "e1",
          name: "Alpha",
          tasks: [task("d1", 8), task("q1", 4, "qa"), task("d2", 2)],
        },
      ],
    };
    const w = remainingWork(tracker([]), project, TEAMS, TODAY)!;
    expect(w.people.map((p) => [p.name, p.finish])).toEqual([
      ["Ana", "2026-11-30"],
      ["Bo Lind", "2026-11-20"],
      ["Cy", "2026-11-24"],
    ]);
  });
});
