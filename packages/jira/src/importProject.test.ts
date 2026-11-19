import { describe, it, expect } from "vitest";
import {
  runPlan,
  type JiraEpic,
  type JiraIssue,
  type JiraSnapshot,
  type Project,
  type Team,
} from "@planner/core";
import { projectFromSnapshot } from "./importProject";

const h = (n: number) => n * 3600;

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

function epic(
  key: string,
  summary: string,
  children: JiraIssue[],
  extra: Partial<JiraIssue> = {},
): JiraEpic {
  return {
    ...issue(key, summary, { issueType: "Epic", ...extra }),
    children,
    totals: { originalSec: 0, spentSec: 0, remainingSec: 0, done: 0, all: 0 },
  };
}

function snapshotOf(epics: JiraEpic[]): JiraSnapshot {
  return {
    fetchedAt: "2026-09-20T10:00:00.000Z",
    initiative: issue("INI-1", "Checkout revamp", { issueType: "Initiative" }),
    epics,
    fieldIds: {},
  };
}

const teams: Team[] = [
  {
    id: "t1",
    name: "Core",
    members: [
      { id: "m-fe", name: "Alice Kim", specialization: "Frontend" },
      { id: "m-be", name: "Zoë Brandt", specialization: "Backend" },
    ],
    offDays: {},
  },
];

function counter() {
  let n = 0;
  return () => `id-${++n}`;
}

function build(
  snapshot: JiraSnapshot,
  extra: Partial<Parameters<typeof projectFromSnapshot>[0]> = {},
) {
  return projectFromSnapshot({
    snapshot,
    projectId: "p-new",
    name: "Fresh",
    startDate: "2026-09-07",
    newId: counter(),
    teams,
    defaultSpecialization: "Backend",
    ...extra,
  });
}

describe("projectFromSnapshot", () => {
  it("turns epics and children into epics and tasks with an exact task map", () => {
    const snap = snapshotOf([
      epic("E-1", "Milestone 1", [
        issue("A-1", "Card form", { originalEstimateSec: h(16) }),
        issue("A-2", "Card API", { originalEstimateSec: h(4) }),
      ]),
    ]);
    const { project, taskMap, tasks } = build(snap);

    expect(project.epics).toHaveLength(1);
    expect(project.epics[0].name).toBe("Milestone 1");
    expect(project.epics[0].tasks.map((t) => [t.name, t.estimateDays])).toEqual(
      [
        ["Card form", 2],
        ["Card API", 0.5],
      ],
    );
    expect(taskMap).toEqual({
      "A-1": project.epics[0].tasks[0].id,
      "A-2": project.epics[0].tasks[1].id,
    });
    expect(tasks.map((t) => t.estimateSource)).toEqual([
      "original",
      "original",
    ]);
  });

  it("ignores status: done issues are planned like open ones", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "Shipped", {
          statusCategory: "done",
          originalEstimateSec: h(8),
          remainingEstimateSec: 0,
        }),
      ]),
    ]);
    const task = build(snap).project.epics[0].tasks[0];
    expect(task.estimateDays).toBe(1);
    expect(task.excluded).toBe(false);
  });

  it("falls back to logged time, and skips issues with no estimate at all", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "Logged only", {
          timeSpentSec: h(4),
          remainingEstimateSec: h(8),
        }),
        issue("A-2", "Nothing"),
      ]),
    ]);
    const { project, tasks } = build(snap);
    const [logged, nothing] = project.epics[0].tasks;
    expect(logged.estimateDays).toBe(1.5);
    expect(logged.excluded).toBe(false);
    expect(nothing.estimateDays).toBe(0);
    expect(nothing.excluded).toBe(true);
    expect(tasks.map((t) => t.estimateSource)).toEqual(["logged", "none"]);
  });

  it("honours hoursPerDay", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [issue("A-1", "x", { originalEstimateSec: h(6) })]),
    ]);
    const task = build(snap, { hoursPerDay: 6 }).project.epics[0].tasks[0];
    expect(task.estimateDays).toBe(1);
  });

  it("infers specialization: plan match, then assignee, then epic, then default", () => {
    const template: Project = {
      id: "p-old",
      name: "Old",
      startDate: "2026-09-07",
      planViewMode: "person",
      plan: null,
      epics: [
        {
          id: "oe",
          name: "Old epic",
          tasks: [
            {
              id: "ot",
              name: "Old name for QA pass",
              estimateDays: 1,
              specialization: "QA",
              excluded: false,
            },
          ],
        },
      ],
    };
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "QA pass (renamed in Jira)"),
        issue("A-2", "Build form", {
          assignee: { accountId: "x", displayName: "alice  kim" },
        }),
        issue("A-3", "Unassigned polish"),
      ]),
      epic("E-2", "M2", [issue("B-1", "Nobody knows")]),
    ]);
    const { project, tasks } = build(snap, {
      template,
      // The tracker's manual correction wins over name guessing.
      templateTaskMap: { "A-1": "ot" },
    });
    expect(project.epics[0].tasks.map((t) => t.specialization)).toEqual([
      "QA",
      "Frontend",
      "QA",
    ]);
    expect(project.epics[1].tasks[0].specialization).toBe("Backend");
    expect(tasks.map((t) => t.specializationSource)).toEqual([
      "plan",
      "assignee",
      "epic",
      "default",
    ]);
  });

  it("reads a specialization named in the summary, unless two are", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "Wallet token backend", {
          assignee: { accountId: "x", displayName: "Alice Kim" },
        }),
        issue("A-2", "[frontend] wallet button"),
        issue("A-3", "Backend + frontend handover", {
          assignee: { accountId: "x", displayName: "Alice Kim" },
        }),
        issue("A-4", "Backendless mode"),
      ]),
    ]);
    const { project, tasks } = build(snap, { defaultSpecialization: "QA" });
    // "Backendless" is not the word "backend"; the epic's majority decides.
    expect(project.epics[0].tasks.map((t) => t.specialization)).toEqual([
      "Backend",
      "Frontend",
      "Frontend",
      "Frontend",
    ]);
    expect(tasks.map((t) => t.specializationSource)).toEqual([
      "name",
      "name",
      "assignee",
      "epic",
    ]);
  });

  it("reads a specialization from Jira labels before the summary", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "Frontend polish", { labels: ["backend"] }),
        issue("A-2", "Wallet button", { labels: ["Frontend", "sprint-4"] }),
        issue("A-3", "Frontend handover", { labels: ["backend", "frontend"] }),
      ]),
    ]);
    const { project, tasks } = build(snap, { defaultSpecialization: "QA" });
    expect(project.epics[0].tasks.map((t) => t.specialization)).toEqual([
      "Backend",
      "Frontend",
      "Frontend",
    ]);
    // Two labels naming two specializations say nothing; the summary decides.
    expect(tasks.map((t) => t.specializationSource)).toEqual([
      "tag",
      "tag",
      "name",
    ]);
  });

  it("reads java as Backend, unless someone's specialization is Java", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "Payments service", { labels: ["java"] }),
        issue("A-2", "[Java] backend retries"),
      ]),
    ]);
    const plain = build(snap, { defaultSpecialization: "QA" });
    expect(plain.project.epics[0].tasks.map((t) => t.specialization)).toEqual([
      "Backend",
      "Backend",
    ]);
    expect(plain.tasks.map((t) => t.specializationSource)).toEqual([
      "tag",
      "name",
    ]);

    const withJava: Team[] = [
      {
        ...teams[0],
        members: [
          ...teams[0].members,
          { id: "m-java", name: "Ola Nowak", specialization: "Java" },
        ],
      },
    ];
    const split = build(snap, { teams: withJava, defaultSpecialization: "QA" });
    // "[Java] backend" now names two specializations, so the epic decides.
    expect(split.project.epics[0].tasks.map((t) => t.specialization)).toEqual([
      "Java",
      "Java",
    ]);
    expect(split.tasks.map((t) => t.specializationSource)).toEqual([
      "tag",
      "epic",
    ]);
  });

  it("does not invent Backend for java when nobody does Backend", () => {
    const frontOnly: Team[] = [{ ...teams[0], members: [teams[0].members[0]] }];
    const snap = snapshotOf([
      epic("E-1", "M1", [issue("A-1", "Service", { labels: ["java"] })]),
    ]);
    const { tasks } = build(snap, {
      teams: frontOnly,
      defaultSpecialization: "QA",
    });
    expect(tasks[0].specializationSource).toBe("default");
  });

  it("honours the caller's tag aliases over everything built in", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "Level editor", { labels: ["tools"] }),
        issue("A-2", "Import pipeline", { labels: ["java"] }),
        issue("A-3", "Build scripts", { labels: ["dev-ops"] }),
      ]),
    ]);
    const { project } = build(snap, {
      defaultSpecialization: "QA",
      tagAliases: [
        { tag: "Tools", specialization: "Tools" },
        { tag: "java", specialization: "frontend" },
        { tag: "dev ops", specialization: "Tools" },
        { tag: " ", specialization: "Backend" },
      ],
    });
    // Aliases keep the team's own spelling of a specialization they name.
    expect(project.epics[0].tasks.map((t) => t.specialization)).toEqual([
      "Tools",
      "Frontend",
      "Tools",
    ]);
  });

  it("reports labels and bracketed tags that name no specialization", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "[Tooling] level editor", { labels: ["tooling", "java"] }),
        issue("A-2", "[Frontend] menu", { labels: ["Tooling", "sprint-4"] }),
      ]),
      epic("E-2", "M2", [issue("B-1", "[Tools][ ] export")]),
    ]);
    const first = build(snap);
    // One entry per tag however it is spelled, counted once per issue; known
    // specializations and built-in aliases ("java") are not unknown.
    expect(first.unknownTags).toEqual([
      { tag: "tooling", issueKeys: ["A-1", "A-2"] },
      { tag: "sprint-4", issueKeys: ["A-2"] },
      { tag: "Tools", issueKeys: ["B-1"] },
    ]);

    const mapped = build(snap, {
      tagAliases: [{ tag: "Tooling", specialization: "Frontend" }],
    });
    expect(mapped.unknownTags.map((t) => t.tag)).toEqual(["sprint-4", "Tools"]);
  });

  it("matches assignees regardless of accents", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "x", {
          assignee: { accountId: "z", displayName: "Zoe Brandt" },
        }),
      ]),
    ]);
    const { tasks, project } = build(snap, { defaultSpecialization: "QA" });
    expect(project.epics[0].tasks[0].specialization).toBe("Backend");
    expect(tasks[0].specializationSource).toBe("assignee");
  });

  it("orders by Jira start date, then due date, then creation order", () => {
    const snap = snapshotOf([
      epic("E-9", "Later milestone", [issue("A-1", "a")], {
        dueDate: "2026-12-01",
      }),
      epic("E-2", "Earlier milestone", [issue("A-3", "c"), issue("A-2", "b")], {
        dueDate: "2026-10-01",
      }),
    ]);
    const { project } = build(snap);
    expect(project.epics.map((e) => e.name)).toEqual([
      "Earlier milestone",
      "Later milestone",
    ]);
    expect(project.epics[0].tasks.map((t) => t.name)).toEqual(["b", "c"]);
  });

  it("imports an issue once even if Jira lists it under two epics", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [issue("A-1", "dup", { originalEstimateSec: h(8) })]),
      epic("E-2", "M2", [
        issue("A-1", "dup", { originalEstimateSec: h(8) }),
        issue("A-2", "other"),
      ]),
    ]);
    const { project, taskMap, emptyEpics } = build(snap);
    const all = project.epics.flatMap((e) => e.tasks);
    expect(all.map((t) => t.name)).toEqual(["dup", "other"]);
    expect(Object.keys(taskMap)).toEqual(["A-1", "A-2"]);
    expect(emptyEpics).toEqual([]);
  });

  it("skips epics with no children and reports them", () => {
    const snap = snapshotOf([
      epic("E-1", "Empty", []),
      epic("E-2", "M2", [issue("A-1", "x")]),
    ]);
    const { project, emptyEpics } = build(snap);
    expect(project.epics.map((e) => e.name)).toEqual(["M2"]);
    expect(emptyEpics).toEqual(["E-1"]);
  });

  it("copies staffing from the template but not its epic-scoped settings", () => {
    const template: Project = {
      id: "p-old",
      name: "Old",
      startDate: "2026-08-03",
      planViewMode: "task",
      plan: null,
      epics: [],
      buffer: 20,
      planMode: "smart",
      planLookahead: 3,
      memberStarts: { "m-fe": "2026-09-14" },
      helpers: [
        {
          id: "h-old",
          name: "Contractor",
          specialization: "Frontend",
          speed: 0.7,
          availableFrom: "2026-09-01",
          availableTo: "2026-12-31",
        },
      ],
      epicAssignments: { oe: ["m-fe"] },
      teamInclusions: [
        { teamId: "t1", epicIds: ["oe"], exclusive: true, velocity: 0.9 },
      ],
    };
    const { project } = build(snapshotOf([]), { template });
    expect(project.buffer).toBe(20);
    expect(project.planMode).toBe("smart");
    expect(project.planLookahead).toBe(3);
    expect(project.memberStarts).toEqual({ "m-fe": "2026-09-14" });
    expect(project.helpers).toHaveLength(1);
    expect(project.helpers?.[0].id).not.toBe("h-old");
    expect(project.epicAssignments).toEqual({});
    expect(project.teamInclusions).toEqual([{ teamId: "t1", velocity: 0.9 }]);
    expect(project.note).toContain("INI-1");
    expect(project.note).toContain("2026-09-20");
  });

  it("leaves teamInclusions absent without a template, so every team plans", () => {
    const snap = snapshotOf([
      epic("E-1", "M1", [issue("A-1", "x", { originalEstimateSec: h(8) })]),
    ]);
    const { project } = build(snap, { buffer: 10 });
    expect(project.teamInclusions).toBeUndefined();
    expect(project.buffer).toBe(10);
    const plan = runPlan(project, teams, "2026-09-20T00:00:00.000Z");
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].memberId).toBe("m-be");
  });

  it("carries task dependencies across when both ends were matched", () => {
    const template: Project = {
      id: "p-old",
      name: "Old",
      startDate: "2026-09-07",
      planViewMode: "person",
      plan: null,
      epics: [
        {
          id: "oe",
          name: "Old",
          tasks: [
            {
              id: "o1",
              name: "Design schema",
              estimateDays: 1,
              specialization: "Backend",
              excluded: false,
            },
            {
              id: "o2",
              name: "Build endpoints",
              estimateDays: 1,
              specialization: "Backend",
              excluded: false,
              dependsOn: ["o1", "o-missing"],
            },
          ],
        },
      ],
    };
    const snap = snapshotOf([
      epic("E-1", "M1", [
        issue("A-1", "Design schema"),
        issue("A-2", "Build endpoints"),
      ]),
    ]);
    const { project } = build(snap, { template });
    const [first, second] = project.epics[0].tasks;
    expect(second.dependsOn).toEqual([first.id]);
    expect(first.dependsOn).toBeUndefined();
  });
});
