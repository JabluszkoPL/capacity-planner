import { describe, it, expect } from "vitest";
import { Clock } from "@planner/contracts";
import { diffStates } from "@planner/db";
import type {
  AppState,
  EpicTracking,
  JiraIssue,
  JiraSnapshot,
  Plan,
  SprintDraft,
  TrackerSample,
} from "@planner/core";
import { reducer } from "./store";

function base(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P1",
        startDate: "2026-01-01",
        plan: null,
        planViewMode: "person",
        epics: [
          {
            id: "e1",
            name: "E1",
            tasks: [
              {
                id: "t1",
                name: "T1",
                estimateDays: 2,
                specialization: "Frontend",
                excluded: false,
              },
              {
                id: "t2",
                name: "T2",
                estimateDays: 1,
                specialization: "Backend",
                excluded: false,
              },
            ],
          },
          { id: "e2", name: "E2", tasks: [] },
        ],
      },
    ],
    teams: [
      {
        id: "t1",
        name: "Team 1",
        members: [{ id: "m1", name: "Alice", specialization: "Frontend" }],
        offDays: { m1: ["2026-01-05"] },
      },
    ],
  };
}

const project = (s: AppState) => s.projects[0];
const epic1 = (s: AppState) => project(s).epics[0];

describe("reducer — whole-state replacements", () => {
  const empty: AppState = {
    projects: [],
    teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
  };
  it("hydrate replaces state", () => {
    expect(reducer(empty, { type: "hydrate", state: base() })).toEqual(base());
  });
  it("resetSample replaces state", () => {
    expect(reducer(base(), { type: "resetSample", state: empty })).toEqual(
      empty,
    );
  });
  it("importState replaces state", () => {
    expect(reducer(empty, { type: "importState", state: base() })).toEqual(
      base(),
    );
  });
});

describe("reducer — projects", () => {
  it("createProject appends a project", () => {
    const s = reducer(base(), {
      type: "createProject",
      id: "p2",
      name: "New",
      startDate: "2026-02-02",
    });
    expect(s.projects).toHaveLength(2);
    expect(s.projects[1]).toMatchObject({
      id: "p2",
      name: "New",
      startDate: "2026-02-02",
      epics: [],
      plan: null,
      planViewMode: "person",
    });
  });

  it("addProject appends a whole project and ignores a duplicate id", () => {
    const incoming = {
      ...base().projects[0],
      id: "p2",
      name: "From Jira",
      teamInclusions: undefined,
    };
    const s = reducer(base(), { type: "addProject", project: incoming });
    expect(s.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(s.projects[1]).toBe(incoming);
    expect(reducer(s, { type: "addProject", project: incoming })).toBe(s);
  });

  it("createProject starts with no teams selected (empty inclusions)", () => {
    const s = reducer(base(), {
      type: "createProject",
      id: "p2",
      name: "New",
      startDate: "2026-02-02",
    });
    expect(s.projects[1].teamInclusions).toEqual([]);
  });

  it("copyProject inserts a '(Copy)' with fresh ids right after the source", () => {
    const s = reducer(base(), {
      type: "copyProject",
      sourceId: "p1",
      newId: "p2",
    });
    expect(s.projects).toHaveLength(2);
    const copy = s.projects[1];
    expect(copy.id).toBe("p2");
    expect(copy.name).toBe("P1 (Copy)");
    expect(copy.epics[0].id).not.toBe("e1");
    expect(copy.epics[0].tasks[0].id).not.toBe("t1");
    // Content preserved even though ids are fresh.
    expect(copy.epics.map((e) => e.name)).toEqual(["E1", "E2"]);
    expect(copy.epics[0].tasks.map((t) => t.name)).toEqual(["T1", "T2"]);
  });

  it("copyProject is a fully independent deep clone", () => {
    const s = reducer(base(), {
      type: "copyProject",
      sourceId: "p1",
      newId: "p2",
    });
    const original = s.projects[0];
    const copy = s.projects[1];
    // Mutating the copy must never touch the original.
    copy.name = "changed";
    copy.epics[0].name = "changed epic";
    copy.epics[0].tasks[0].name = "changed task";
    copy.epics.push({ id: "x", name: "extra", tasks: [] });
    expect(original.name).toBe("P1");
    expect(original.epics[0].name).toBe("E1");
    expect(original.epics[0].tasks[0].name).toBe("T1");
    expect(original.epics).toHaveLength(2);
  });

  it("copyProject on a missing source is a no-op", () => {
    const s = reducer(base(), {
      type: "copyProject",
      sourceId: "nope",
      newId: "p2",
    });
    expect(s.projects).toHaveLength(1);
  });

  it("deleteProject removes it", () => {
    const s = reducer(base(), { type: "deleteProject", id: "p1" });
    expect(s.projects).toHaveLength(0);
  });

  it("renameProject changes the name", () => {
    const s = reducer(base(), { type: "renameProject", id: "p1", name: "R" });
    expect(project(s).name).toBe("R");
  });

  it("setProjectStartDate changes the start date", () => {
    const s = reducer(base(), {
      type: "setProjectStartDate",
      id: "p1",
      startDate: "2026-09-09",
    });
    expect(project(s).startDate).toBe("2026-09-09");
  });
});

describe("reducer — epics", () => {
  it("addEpic appends an empty epic", () => {
    const s = reducer(base(), {
      type: "addEpic",
      projectId: "p1",
      epicId: "e3",
      name: "E3",
    });
    expect(project(s).epics).toHaveLength(3);
    expect(project(s).epics[2]).toEqual({ id: "e3", name: "E3", tasks: [] });
  });

  it("renameEpic changes the name", () => {
    const s = reducer(base(), {
      type: "renameEpic",
      projectId: "p1",
      epicId: "e1",
      name: "E1x",
    });
    expect(epic1(s).name).toBe("E1x");
  });

  it("deleteEpic removes it", () => {
    const s = reducer(base(), {
      type: "deleteEpic",
      projectId: "p1",
      epicId: "e1",
    });
    expect(project(s).epics.map((e) => e.id)).toEqual(["e2"]);
  });

  it("reorderEpic moves down and clamps at the ends", () => {
    const down = reducer(base(), {
      type: "reorderEpic",
      projectId: "p1",
      epicId: "e1",
      direction: 1,
    });
    expect(project(down).epics.map((e) => e.id)).toEqual(["e2", "e1"]);
    // e1 is already first; moving up is a no-op (clamped).
    const up = reducer(base(), {
      type: "reorderEpic",
      projectId: "p1",
      epicId: "e1",
      direction: -1,
    });
    expect(project(up).epics.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("reducer — tasks", () => {
  it("addTask appends a task", () => {
    const s = reducer(base(), {
      type: "addTask",
      projectId: "p1",
      epicId: "e1",
      taskId: "t3",
      task: {
        name: "T3",
        estimateDays: 0.5,
        specialization: "QA",
        excluded: false,
      },
    });
    expect(epic1(s).tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("editTask patches fields", () => {
    const s = reducer(base(), {
      type: "editTask",
      projectId: "p1",
      epicId: "e1",
      taskId: "t1",
      patch: { name: "T1x", estimateDays: 4 },
    });
    expect(epic1(s).tasks[0]).toMatchObject({ name: "T1x", estimateDays: 4 });
  });

  it("toggleTaskExcluded flips the flag", () => {
    const s = reducer(base(), {
      type: "toggleTaskExcluded",
      projectId: "p1",
      epicId: "e1",
      taskId: "t1",
    });
    expect(epic1(s).tasks[0].excluded).toBe(true);
  });

  it("deleteTask removes it", () => {
    const s = reducer(base(), {
      type: "deleteTask",
      projectId: "p1",
      epicId: "e1",
      taskId: "t1",
    });
    expect(epic1(s).tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("reorderTask moves within the epic", () => {
    const s = reducer(base(), {
      type: "reorderTask",
      projectId: "p1",
      epicId: "e1",
      taskId: "t1",
      direction: 1,
    });
    expect(epic1(s).tasks.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("moveTask relocates a task to an absolute index", () => {
    const withThird = reducer(base(), {
      type: "addTask",
      projectId: "p1",
      epicId: "e1",
      taskId: "t3",
      task: {
        name: "T3",
        estimateDays: 1,
        specialization: "",
        excluded: false,
      },
    });
    // [t1, t2, t3] -> move t1 to the end
    const s = reducer(withThird, {
      type: "moveTask",
      projectId: "p1",
      epicId: "e1",
      taskId: "t1",
      toIndex: 2,
    });
    expect(epic1(s).tasks.map((t) => t.id)).toEqual(["t2", "t3", "t1"]);
  });

  it("moveTask clamps an out-of-range index", () => {
    const s = reducer(base(), {
      type: "moveTask",
      projectId: "p1",
      epicId: "e1",
      taskId: "t2",
      toIndex: 99,
    });
    expect(epic1(s).tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

describe("reducer — team", () => {
  const team0 = (s: AppState) => s.teams[0];

  it("addTeamMember appends a member to the named team", () => {
    const s = reducer(base(), {
      type: "addTeamMember",
      teamId: "t1",
      id: "m2",
      name: "Ben",
      specialization: "Backend",
    });
    expect(team0(s).members).toHaveLength(2);
    expect(team0(s).members[1]).toEqual({
      id: "m2",
      name: "Ben",
      specialization: "Backend",
    });
  });

  it("editTeamMember patches fields (locating the team by member id)", () => {
    const s = reducer(base(), {
      type: "editTeamMember",
      id: "m1",
      patch: { specialization: "Design" },
    });
    expect(team0(s).members[0]).toEqual({
      id: "m1",
      name: "Alice",
      specialization: "Design",
    });
  });

  it("deleteTeamMember also removes their off-days", () => {
    const s = reducer(base(), { type: "deleteTeamMember", id: "m1" });
    expect(team0(s).members).toHaveLength(0);
    expect(team0(s).offDays.m1).toBeUndefined();
  });

  it("toggleOffDay adds a new off-day (sorted) and removes an existing one", () => {
    const added = reducer(base(), {
      type: "toggleOffDay",
      memberId: "m1",
      dateISO: "2026-01-03",
    });
    expect(team0(added).offDays.m1).toEqual(["2026-01-03", "2026-01-05"]);

    const removed = reducer(base(), {
      type: "toggleOffDay",
      memberId: "m1",
      dateISO: "2026-01-05",
    });
    expect(team0(removed).offDays.m1).toEqual([]);
  });

  it("toggleOffDay works for a member with no prior off-days", () => {
    const s = reducer(base(), {
      type: "addTeamMember",
      teamId: "t1",
      id: "m2",
      name: "Ben",
      specialization: "Backend",
    });
    const off = reducer(s, {
      type: "toggleOffDay",
      memberId: "m2",
      dateISO: "2026-02-02",
    });
    expect(team0(off).offDays.m2).toEqual(["2026-02-02"]);
  });
});

describe("reducer — teams (multi-team CRUD)", () => {
  it("addTeam appends an empty team", () => {
    const s = reducer(base(), { type: "addTeam", id: "t2", name: "Platform" });
    expect(s.teams).toHaveLength(2);
    expect(s.teams[1]).toEqual({
      id: "t2",
      name: "Platform",
      members: [],
      offDays: {},
    });
  });

  const JIRA = {
    baseUrl: "https://acme.atlassian.net",
    teamId: "team-uuid",
    teamName: "Stars",
    syncedAt: "2026-11-10T09:00:00.000Z",
  };

  it("importJiraTeam creates a team carrying its Jira origin", () => {
    const s = reducer(base(), {
      type: "importJiraTeam",
      teamId: "jt",
      name: "Stars",
      jira: JIRA,
      members: [
        {
          id: "j1",
          name: "Ada",
          specialization: "Backend",
          jiraAccountId: "a",
        },
      ],
    });
    expect(s.teams[1]).toEqual({
      id: "jt",
      name: "Stars",
      jira: JIRA,
      offDays: {},
      members: [
        {
          id: "j1",
          name: "Ada",
          specialization: "Backend",
          jiraAccountId: "a",
        },
      ],
    });
  });

  it("importJiraTeam on an existing team appends people and keeps edits", () => {
    let s = reducer(base(), {
      type: "importJiraTeam",
      teamId: "jt",
      name: "Stars",
      jira: JIRA,
      members: [
        {
          id: "j1",
          name: "Ada",
          specialization: "Backend",
          jiraAccountId: "a",
        },
      ],
    });
    s = reducer(s, { type: "renameTeam", id: "jt", name: "Stars (EU)" });
    s = reducer(s, {
      type: "toggleOffDay",
      memberId: "j1",
      dateISO: "2026-12-24",
    });
    const later = { ...JIRA, syncedAt: "2026-11-20T09:00:00.000Z" };
    s = reducer(s, {
      type: "importJiraTeam",
      teamId: "jt",
      name: "ignored on update",
      jira: later,
      members: [
        // Already here under another id: must not be added twice.
        { id: "dup", name: "Ada", specialization: "QA", jiraAccountId: "a" },
        { id: "j2", name: "Bo", specialization: "QA", jiraAccountId: "b" },
      ],
    });
    const team = s.teams.find((t) => t.id === "jt")!;
    expect(team.name).toBe("Stars (EU)");
    expect(team.jira).toEqual(later);
    expect(team.members.map((m) => m.id)).toEqual(["j1", "j2"]);
    expect(team.offDays).toEqual({ j1: ["2026-12-24"] });
  });

  it("renameTeam changes the name", () => {
    const s = reducer(base(), { type: "renameTeam", id: "t1", name: "Core" });
    expect(s.teams[0].name).toBe("Core");
  });

  it("deleteTeam drops the team and scrubs its members' project assignments", () => {
    let s = reducer(base(), { type: "addTeam", id: "t2", name: "Second" });
    s = reducer(s, {
      type: "addTeamMember",
      teamId: "t2",
      id: "m9",
      name: "Zed",
      specialization: "Backend",
    });
    // Assign m9 to an epic on the project.
    s = reducer(s, {
      type: "toggleEpicAssignment",
      projectId: "p1",
      epicId: "e1",
      memberId: "m9",
    });
    expect(s.projects[0].epicAssignments?.e1).toContain("m9");

    s = reducer(s, { type: "deleteTeam", id: "t2" });
    expect(s.teams.map((t) => t.id)).toEqual(["t1"]);
    expect(s.projects[0].epicAssignments?.e1 ?? []).not.toContain("m9");
  });
});

describe("reducer — team inclusions", () => {
  it("toggleTeamIncluded materializes the full list then drops the toggled team", () => {
    let s = reducer(base(), { type: "addTeam", id: "t2", name: "Second" });
    // No prior inclusions → default is all teams. Toggling t2 off leaves only t1.
    s = reducer(s, {
      type: "toggleTeamIncluded",
      projectId: "p1",
      teamId: "t2",
    });
    expect(s.projects[0].teamInclusions?.map((i) => i.teamId)).toEqual(["t1"]);
    // Toggling it back on re-adds it.
    s = reducer(s, {
      type: "toggleTeamIncluded",
      projectId: "p1",
      teamId: "t2",
    });
    expect(s.projects[0].teamInclusions?.map((i) => i.teamId).sort()).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("updateTeamInclusion sets a window/exclusive patch, inserting if needed", () => {
    const s = reducer(base(), {
      type: "updateTeamInclusion",
      projectId: "p1",
      teamId: "t1",
      patch: { availableFrom: "2026-02-01", exclusive: true },
    });
    const inc = s.projects[0].teamInclusions?.find((i) => i.teamId === "t1");
    expect(inc).toMatchObject({
      teamId: "t1",
      availableFrom: "2026-02-01",
      exclusive: true,
    });
  });

  it("toggleTeamInclusionEpic adds and removes an epic from the scope", () => {
    let s = reducer(base(), {
      type: "toggleTeamInclusionEpic",
      projectId: "p1",
      teamId: "t1",
      epicId: "e1",
    });
    let inc = s.projects[0].teamInclusions?.find((i) => i.teamId === "t1");
    expect(inc?.epicIds).toEqual(["e1"]);

    s = reducer(s, {
      type: "toggleTeamInclusionEpic",
      projectId: "p1",
      teamId: "t1",
      epicId: "e1",
    });
    inc = s.projects[0].teamInclusions?.find((i) => i.teamId === "t1");
    expect(inc?.epicIds).toEqual([]);
  });

  it("deleteEpic scrubs the epic from team inclusion scopes", () => {
    let s = reducer(base(), {
      type: "toggleTeamInclusionEpic",
      projectId: "p1",
      teamId: "t1",
      epicId: "e1",
    });
    s = reducer(s, { type: "deleteEpic", projectId: "p1", epicId: "e1" });
    const inc = s.projects[0].teamInclusions?.find((i) => i.teamId === "t1");
    expect(inc?.epicIds ?? []).not.toContain("e1");
  });
});

describe("reducer — helpers", () => {
  const helper = {
    id: "h1",
    name: "Ext",
    specialization: "Backend",
    speed: 0.6,
    availableFrom: "2026-02-01",
    availableTo: "2026-03-01",
  };

  it("addHelper appends a helper to the project", () => {
    const s = reducer(base(), {
      type: "addHelper",
      projectId: "p1",
      helperId: "h1",
      helper: {
        name: "Ext",
        specialization: "Backend",
        speed: 0.6,
        availableFrom: "2026-02-01",
        availableTo: "2026-03-01",
      },
    });
    expect(project(s).helpers).toEqual([helper]);
  });

  it("editHelper patches fields", () => {
    const withHelper = reducer(base(), {
      type: "addHelper",
      projectId: "p1",
      helperId: "h1",
      helper: {
        name: "Ext",
        specialization: "Backend",
        speed: 0.6,
        availableFrom: "2026-02-01",
        availableTo: "2026-03-01",
      },
    });
    const s = reducer(withHelper, {
      type: "editHelper",
      projectId: "p1",
      helperId: "h1",
      patch: { speed: 0.8 },
    });
    expect(project(s).helpers?.[0].speed).toBe(0.8);
  });

  it("deleteHelper removes it", () => {
    const withHelper = reducer(base(), {
      type: "addHelper",
      projectId: "p1",
      helperId: "h1",
      helper: {
        name: "Ext",
        specialization: "Backend",
        speed: 0.6,
        availableFrom: "2026-02-01",
        availableTo: "2026-03-01",
      },
    });
    const s = reducer(withHelper, {
      type: "deleteHelper",
      projectId: "p1",
      helperId: "h1",
    });
    expect(project(s).helpers).toEqual([]);
  });

  it("copyProject deep-clones helpers with fresh ids, fully independent", () => {
    const withHelper = reducer(base(), {
      type: "addHelper",
      projectId: "p1",
      helperId: "h1",
      helper: {
        name: "Ext",
        specialization: "Backend",
        speed: 0.6,
        availableFrom: "2026-02-01",
        availableTo: "2026-03-01",
      },
    });
    const s = reducer(withHelper, {
      type: "copyProject",
      sourceId: "p1",
      newId: "p2",
    });
    const copy = s.projects[1];
    expect(copy.helpers?.[0].name).toBe("Ext");
    expect(copy.helpers?.[0].id).not.toBe("h1");
    // Mutating the copy's helper must not touch the original.
    copy.helpers![0].name = "changed";
    expect(s.projects[0].helpers?.[0].name).toBe("Ext");
  });
});

describe("reducer — member start overrides", () => {
  it("setMemberStart sets an override date", () => {
    const s = reducer(base(), {
      type: "setMemberStart",
      projectId: "p1",
      memberId: "m1",
      date: "2026-08-10",
    });
    expect(project(s).memberStarts).toEqual({ m1: "2026-08-10" });
  });

  it("setMemberStart with null clears the override", () => {
    const withStart = reducer(base(), {
      type: "setMemberStart",
      projectId: "p1",
      memberId: "m1",
      date: "2026-08-10",
    });
    const cleared = reducer(withStart, {
      type: "setMemberStart",
      projectId: "p1",
      memberId: "m1",
      date: null,
    });
    expect(cleared.projects[0].memberStarts).toEqual({});
  });

  it("copyProject clones member-start overrides independently", () => {
    const withStart = reducer(base(), {
      type: "setMemberStart",
      projectId: "p1",
      memberId: "m1",
      date: "2026-08-10",
    });
    const s = reducer(withStart, {
      type: "copyProject",
      sourceId: "p1",
      newId: "p2",
    });
    expect(s.projects[1].memberStarts).toEqual({ m1: "2026-08-10" });
    // Mutating the copy's map must not touch the original.
    s.projects[1].memberStarts!.m1 = "2099-01-01";
    expect(s.projects[0].memberStarts!.m1).toBe("2026-08-10");
  });
});

describe("reducer — epic assignments", () => {
  it("toggleEpicAssignment assigns then unassigns a member", () => {
    const on = reducer(base(), {
      type: "toggleEpicAssignment",
      projectId: "p1",
      epicId: "e1",
      memberId: "m1",
    });
    expect(project(on).epicAssignments).toEqual({ e1: ["m1"] });
    const off = reducer(on, {
      type: "toggleEpicAssignment",
      projectId: "p1",
      epicId: "e1",
      memberId: "m1",
    });
    // The empty list is dropped rather than left as an empty array.
    expect(project(off).epicAssignments).toEqual({});
  });

  it("deleteEpic drops that epic's assignment record", () => {
    const assigned = reducer(base(), {
      type: "toggleEpicAssignment",
      projectId: "p1",
      epicId: "e1",
      memberId: "m1",
    });
    const s = reducer(assigned, {
      type: "deleteEpic",
      projectId: "p1",
      epicId: "e1",
    });
    expect(project(s).epicAssignments).toEqual({});
  });

  it("deleteTeamMember removes them from every epic assignment", () => {
    const assigned = reducer(base(), {
      type: "toggleEpicAssignment",
      projectId: "p1",
      epicId: "e1",
      memberId: "m1",
    });
    const s = reducer(assigned, { type: "deleteTeamMember", id: "m1" });
    expect(project(s).epicAssignments).toEqual({});
  });

  it("copyProject remaps epic assignments onto the cloned epic ids, independently", () => {
    const assigned = reducer(base(), {
      type: "toggleEpicAssignment",
      projectId: "p1",
      epicId: "e1",
      memberId: "m1",
    });
    const s = reducer(assigned, {
      type: "copyProject",
      sourceId: "p1",
      newId: "p2",
    });
    const copy = s.projects[1];
    const newE1 = copy.epics[0].id;
    expect(newE1).not.toBe("e1");
    // Assignment follows the epic to its fresh id, still pointing at m1.
    expect(copy.epicAssignments).toEqual({ [newE1]: ["m1"] });
    // Mutating the copy must not touch the original.
    copy.epicAssignments![newE1].push("mX");
    expect(s.projects[0].epicAssignments).toEqual({ e1: ["m1"] });
  });
});

describe("reducer — dependencies", () => {
  it("toggleEpicDependency adds then removes, and ignores self", () => {
    const on = reducer(base(), {
      type: "toggleEpicDependency",
      projectId: "p1",
      epicId: "e2",
      dependsOnEpicId: "e1",
    });
    expect(on.projects[0].epics[1].dependsOn).toEqual(["e1"]);
    const off = reducer(on, {
      type: "toggleEpicDependency",
      projectId: "p1",
      epicId: "e2",
      dependsOnEpicId: "e1",
    });
    expect(off.projects[0].epics[1].dependsOn).toEqual([]);
    // Self-dependency is a no-op.
    const self = reducer(base(), {
      type: "toggleEpicDependency",
      projectId: "p1",
      epicId: "e1",
      dependsOnEpicId: "e1",
    });
    expect(epic1(self).dependsOn).toBeUndefined();
  });

  it("toggleTaskDependency adds then removes, and ignores self", () => {
    const on = reducer(base(), {
      type: "toggleTaskDependency",
      projectId: "p1",
      epicId: "e1",
      taskId: "t2",
      dependsOnTaskId: "t1",
    });
    expect(epic1(on).tasks[1].dependsOn).toEqual(["t1"]);
    const self = reducer(base(), {
      type: "toggleTaskDependency",
      projectId: "p1",
      epicId: "e1",
      taskId: "t1",
      dependsOnTaskId: "t1",
    });
    expect(epic1(self).tasks[0].dependsOn).toBeUndefined();
  });

  it("setTaskDependencies replaces the list, deduped and without self", () => {
    const s = reducer(base(), {
      type: "setTaskDependencies",
      projectId: "p1",
      epicId: "e1",
      taskId: "t2",
      dependsOnTaskIds: ["t1", "t2", "t1"],
    });
    expect(epic1(s).tasks[1].dependsOn).toEqual(["t1"]);
    const cleared = reducer(s, {
      type: "setTaskDependencies",
      projectId: "p1",
      epicId: "e1",
      taskId: "t2",
      dependsOnTaskIds: [],
    });
    expect(epic1(cleared).tasks[1].dependsOn).toEqual([]);
  });

  it("deleteTask scrubs the task from other tasks' dependency lists", () => {
    const withDep = reducer(base(), {
      type: "toggleTaskDependency",
      projectId: "p1",
      epicId: "e1",
      taskId: "t2",
      dependsOnTaskId: "t1",
    });
    const s = reducer(withDep, {
      type: "deleteTask",
      projectId: "p1",
      epicId: "e1",
      taskId: "t1",
    });
    expect(epic1(s).tasks.map((t) => t.id)).toEqual(["t2"]);
    expect(epic1(s).tasks[0].dependsOn).toEqual([]);
  });

  function withDeps(): AppState {
    return {
      projects: [
        {
          id: "p1",
          name: "P",
          startDate: "2026-01-01",
          plan: null,
          planViewMode: "person",
          epics: [
            {
              id: "e1",
              name: "E1",
              tasks: [
                {
                  id: "t1",
                  name: "T1",
                  estimateDays: 1,
                  specialization: "BE",
                  excluded: false,
                },
              ],
            },
            {
              id: "e2",
              name: "E2",
              dependsOn: ["e1"],
              tasks: [
                {
                  id: "t2",
                  name: "T2",
                  estimateDays: 1,
                  specialization: "BE",
                  excluded: false,
                  dependsOn: ["t1"],
                },
              ],
            },
          ],
        },
      ],
      teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
    };
  }

  it("deleteEpic scrubs references to the epic and its tasks", () => {
    const s = reducer(withDeps(), {
      type: "deleteEpic",
      projectId: "p1",
      epicId: "e1",
    });
    expect(s.projects[0].epics).toHaveLength(1);
    // e1 removed from e2.dependsOn, and t1 removed from t2.dependsOn.
    expect(s.projects[0].epics[0].dependsOn).toEqual([]);
    expect(s.projects[0].epics[0].tasks[0].dependsOn).toEqual([]);
  });

  it("copyProject remaps epic and task dependencies onto the cloned ids", () => {
    const s = reducer(withDeps(), {
      type: "copyProject",
      sourceId: "p1",
      newId: "p2",
    });
    const copy = s.projects[1];
    const [ce1, ce2] = copy.epics;
    expect(ce1.id).not.toBe("e1");
    expect(ce2.dependsOn).toEqual([ce1.id]);
    expect(ce2.tasks[0].dependsOn).toEqual([ce1.tasks[0].id]);
    // Independent from the source.
    ce2.dependsOn!.push("x");
    expect(s.projects[0].epics[1].dependsOn).toEqual(["e1"]);
  });
});

describe("reducer — team member speed", () => {
  it("editTeamMember can set a member's speed", () => {
    const s = reducer(base(), {
      type: "editTeamMember",
      id: "m1",
      patch: { speed: 0.5 },
    });
    expect(s.teams[0].members[0].speed).toBe(0.5);
  });
});

describe("reducer — plan", () => {
  const plan: Plan = {
    generatedAt: "2026-01-01T00:00:00Z",
    assignments: [],
    unassigned: [],
  };

  it("setPlan stores the plan", () => {
    const s = reducer(base(), { type: "setPlan", projectId: "p1", plan });
    expect(project(s).plan).toEqual(plan);
  });

  it("setPlan can clear the plan", () => {
    const withPlan = reducer(base(), {
      type: "setPlan",
      projectId: "p1",
      plan,
    });
    const cleared = reducer(withPlan, {
      type: "setPlan",
      projectId: "p1",
      plan: null,
    });
    expect(project(cleared).plan).toBeNull();
  });

  it("setPlanViewMode switches the view", () => {
    const s = reducer(base(), {
      type: "setPlanViewMode",
      projectId: "p1",
      mode: "task",
    });
    expect(project(s).planViewMode).toBe("task");
  });
});

describe("reducer — immutability", () => {
  it("does not mutate the input state", () => {
    const input = base();
    const snapshot = JSON.stringify(input);
    reducer(input, { type: "renameProject", id: "p1", name: "X" });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("reducer — trackers", () => {
  const issue = (key: string): JiraIssue => ({
    key,
    summary: key,
    issueType: "Epic",
    status: "In Progress",
    statusCategory: "indeterminate",
    updated: "2026-01-02T00:00:00Z",
  });

  const snapshot = (fetchedAt: string): JiraSnapshot => ({
    fetchedAt,
    initiative: { ...issue("ACME-1"), issueType: "Initiative" },
    epics: [],
    fieldIds: {},
  });

  const sample = (date: string, earnedDays = 3): TrackerSample => ({
    date,
    plannedDays: 5,
    earnedDays,
    varianceDays: earnedDays - 5,
    bufferUsedDays: 2,
    bufferDays: 20,
    jiraSpentDays: 4,
    jiraRemainingDays: 6,
  });

  const draft = (): SprintDraft => ({
    start: "2026-03-02",
    end: "2026-03-13",
    items: [
      { issueKey: "ACME-10", estimateDays: 2, start: "2026-03-02" },
      { issueKey: "ACME-11", estimateDays: 1, start: "2026-03-04" },
    ],
  });

  /** base() plus one tracker, which is what every case below starts from. */
  function withTracker(): AppState {
    return reducer(base(), {
      type: "createTracker",
      id: "tr1",
      name: "Q1 Initiative",
      initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
      initiativeKey: "ACME-1",
      baseUrl: "https://acme.atlassian.net",
    });
  }

  const tracker = (s: AppState) => s.trackers![0];

  it("createTracker appends to an absent trackers list", () => {
    const s = withTracker();
    expect(s.trackers).toHaveLength(1);
    expect(tracker(s)).toEqual({
      id: "tr1",
      name: "Q1 Initiative",
      initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
      initiativeKey: "ACME-1",
      baseUrl: "https://acme.atlassian.net",
    });
  });

  it("addTracker appends a whole tracker, snapshot and all, once", () => {
    const whole = {
      id: "tr9",
      name: "Rebuilt",
      initiativeUrl: "ACME-1",
      initiativeKey: "ACME-1",
      baseUrl: "https://acme.atlassian.net",
      projectId: "p1",
      taskMap: { "ACME-10": "t1" },
      snapshot: snapshot("2026-03-01T00:00:00Z"),
      samples: [sample("2026-03-01")],
    };
    const s = reducer(base(), { type: "addTracker", tracker: whole });
    expect(s.trackers).toEqual([whole]);
    expect(reducer(s, { type: "addTracker", tracker: whole })).toBe(s);
  });

  it("setTrackerDeadlines keeps only what is set, and clears to absent", () => {
    let s = reducer(withTracker(), {
      type: "setTrackerDeadlines",
      id: "tr1",
      deadlines: { devEndDate: "2026-03-13", endPhase: ["QA"], endDate: "" },
    });
    expect(tracker(s).deadlines).toEqual({
      devEndDate: "2026-03-13",
      endPhase: ["QA"],
    });
    s = reducer(s, {
      type: "setTrackerDeadlines",
      id: "tr1",
      deadlines: { endPhase: [] },
    });
    expect(tracker(s)).not.toHaveProperty("deadlines");
  });

  it("createTracker appends to an existing list", () => {
    const s = reducer(withTracker(), {
      type: "createTracker",
      id: "tr2",
      name: "Second",
      initiativeUrl: "https://acme.atlassian.net/browse/ACME-2",
      initiativeKey: "ACME-2",
      baseUrl: "https://acme.atlassian.net",
    });
    expect(s.trackers!.map((t) => t.id)).toEqual(["tr1", "tr2"]);
  });

  it("deleteTracker removes it", () => {
    const s = reducer(withTracker(), { type: "deleteTracker", id: "tr1" });
    expect(s.trackers).toEqual([]);
  });

  it("renameTracker changes the name", () => {
    const s = reducer(withTracker(), {
      type: "renameTracker",
      id: "tr1",
      name: "Renamed",
    });
    expect(tracker(s).name).toBe("Renamed");
  });

  it("setTrackerProject sets, then removes, the baseline", () => {
    const set = reducer(withTracker(), {
      type: "setTrackerProject",
      id: "tr1",
      projectId: "p1",
    });
    expect(tracker(set).projectId).toBe("p1");

    const cleared = reducer(set, {
      type: "setTrackerProject",
      id: "tr1",
      projectId: null,
    });
    // Absent, not null — an absent field is the documented default.
    expect("projectId" in tracker(cleared)).toBe(false);
  });

  it("setTrackerHoursPerDay sets, then removes, the override", () => {
    const set = reducer(withTracker(), {
      type: "setTrackerHoursPerDay",
      id: "tr1",
      hoursPerDay: 6,
    });
    expect(tracker(set).hoursPerDay).toBe(6);

    const cleared = reducer(set, {
      type: "setTrackerHoursPerDay",
      id: "tr1",
      hoursPerDay: null,
    });
    expect("hoursPerDay" in tracker(cleared)).toBe(false);
  });

  it("setTrackerEpicMap stores the map, null entries included", () => {
    const s = reducer(withTracker(), {
      type: "setTrackerEpicMap",
      id: "tr1",
      // null = deliberately out of plan; it must survive as an explicit null.
      epicMap: { "ACME-10": "e1", "ACME-11": null },
    });
    expect(tracker(s).epicMap).toEqual({ "ACME-10": "e1", "ACME-11": null });
  });

  it("setTrackerTaskMap stores task matches and explicit exclusions", () => {
    const s = reducer(withTracker(), {
      type: "setTrackerTaskMap",
      id: "tr1",
      taskMap: { "ACME-101": "task-1", "ACME-102": null },
    });
    expect(tracker(s).taskMap).toEqual({
      "ACME-101": "task-1",
      "ACME-102": null,
    });
  });

  it("setTrackerSnapshot stores the snapshot and appends the sample", () => {
    const s = reducer(withTracker(), {
      type: "setTrackerSnapshot",
      id: "tr1",
      snapshot: snapshot("2026-02-01T09:00:00Z"),
      sample: sample("2026-02-01"),
    });
    expect(tracker(s).snapshot!.fetchedAt).toBe("2026-02-01T09:00:00Z");
    expect(tracker(s).samples).toEqual([sample("2026-02-01")]);
  });

  it("setTrackerSnapshot with no sample leaves the history alone", () => {
    const first = reducer(withTracker(), {
      type: "setTrackerSnapshot",
      id: "tr1",
      snapshot: snapshot("2026-02-01T09:00:00Z"),
      sample: sample("2026-02-01"),
    });
    const second = reducer(first, {
      type: "setTrackerSnapshot",
      id: "tr1",
      snapshot: snapshot("2026-02-02T09:00:00Z"),
      sample: null,
    });
    expect(tracker(second).snapshot!.fetchedAt).toBe("2026-02-02T09:00:00Z");
    expect(tracker(second).samples).toHaveLength(1);
  });

  it("two refreshes on one day leave a single, latest sample", () => {
    const morning = reducer(withTracker(), {
      type: "setTrackerSnapshot",
      id: "tr1",
      snapshot: snapshot("2026-02-01T09:00:00Z"),
      sample: sample("2026-02-01", 3),
    });
    const afternoon = reducer(morning, {
      type: "setTrackerSnapshot",
      id: "tr1",
      snapshot: snapshot("2026-02-01T17:00:00Z"),
      sample: sample("2026-02-01", 4),
    });
    expect(tracker(afternoon).samples).toEqual([sample("2026-02-01", 4)]);
  });

  it("samples stay oldest-first even when they arrive out of order", () => {
    let s = withTracker();
    for (const date of ["2026-02-03", "2026-02-01", "2026-02-02"]) {
      s = reducer(s, {
        type: "setTrackerSnapshot",
        id: "tr1",
        snapshot: snapshot(`${date}T09:00:00Z`),
        sample: sample(date),
      });
    }
    expect(tracker(s).samples!.map((x) => x.date)).toEqual([
      "2026-02-01",
      "2026-02-02",
      "2026-02-03",
    ]);
  });

  it("samples are capped at the most recent 200", () => {
    let s = withTracker();
    // 210 consecutive days; the first 10 must fall off the front.
    for (let i = 0; i < 210; i++) {
      const date = new Date(Date.UTC(2026, 0, 1) + i * 86400000)
        .toISOString()
        .slice(0, 10);
      s = reducer(s, {
        type: "setTrackerSnapshot",
        id: "tr1",
        snapshot: snapshot(`${date}T09:00:00Z`),
        sample: sample(date),
      });
    }
    const samples = tracker(s).samples!;
    expect(samples).toHaveLength(200);
    expect(samples[0].date).toBe("2026-01-11");
    expect(samples[199].date).toBe("2026-07-29");
  });

  it("setTrackerEpicTracking keeps each epic in one list at most", () => {
    const set = (state: AppState, epicKey: string, tracking: EpicTracking) =>
      reducer(state, {
        type: "setTrackerEpicTracking",
        id: "tr1",
        epicKey,
        tracking,
      });
    const nice = set(withTracker(), "E-1", "niceToHave");
    expect(tracker(nice).niceToHaveEpics).toEqual(["E-1"]);
    expect("untrackedEpics" in tracker(nice)).toBe(false);

    const off = set(nice, "E-1", "untracked");
    expect(tracker(off).untrackedEpics).toEqual(["E-1"]);
    expect("niceToHaveEpics" in tracker(off)).toBe(false);

    const back = set(off, "E-1", "tracked");
    expect("untrackedEpics" in tracker(back)).toBe(false);
    expect("niceToHaveEpics" in tracker(back)).toBe(false);
  });

  it("setTrackerSprintDraft stores, then clears, the draft", () => {
    const set = reducer(withTracker(), {
      type: "setTrackerSprintDraft",
      id: "tr1",
      draft: draft(),
    });
    expect(tracker(set).sprintDraft).toEqual(draft());

    const cleared = reducer(set, {
      type: "setTrackerSprintDraft",
      id: "tr1",
      draft: null,
    });
    expect("sprintDraft" in tracker(cleared)).toBe(false);
  });

  it("markSprintItemsApplied stamps matching rows and ignores the rest", () => {
    const set = reducer(withTracker(), {
      type: "setTrackerSprintDraft",
      id: "tr1",
      draft: draft(),
    });
    const s = reducer(set, {
      type: "markSprintItemsApplied",
      id: "tr1",
      applied: [
        {
          issueKey: "ACME-10",
          at: "2026-03-02T10:00:00Z",
          startDate: "2026-03-02",
          dueDate: "2026-03-03",
        },
        // Not in the draft any more — must be ignored, not appended.
        {
          issueKey: "ACME-99",
          at: "2026-03-02T10:00:00Z",
          startDate: "2026-03-02",
          dueDate: "2026-03-03",
        },
      ],
    });
    const items = tracker(s).sprintDraft!.items;
    expect(items).toHaveLength(2);
    expect(items[0].applied).toEqual({
      at: "2026-03-02T10:00:00Z",
      startDate: "2026-03-02",
      dueDate: "2026-03-03",
    });
    expect(items[1].applied).toBeUndefined();
  });

  it("markSprintItemsApplied with no draft is a no-op", () => {
    const s = reducer(withTracker(), {
      type: "markSprintItemsApplied",
      id: "tr1",
      applied: [
        {
          issueKey: "ACME-10",
          at: "2026-03-02T10:00:00Z",
          startDate: "2026-03-02",
          dueDate: "2026-03-03",
        },
      ],
    });
    expect(tracker(s).sprintDraft).toBeUndefined();
  });

  it("deleteProject clears the baseline but keeps the tracker", () => {
    const linked = reducer(withTracker(), {
      type: "setTrackerProject",
      id: "tr1",
      projectId: "p1",
    });
    const s = reducer(linked, { type: "deleteProject", id: "p1" });
    expect(s.projects).toHaveLength(0);
    expect(s.trackers).toHaveLength(1);
    expect("projectId" in tracker(s)).toBe(false);
  });

  it("deleteProject leaves a tracker pointed elsewhere untouched", () => {
    let s = reducer(withTracker(), {
      type: "createProject",
      id: "p2",
      name: "Other",
      startDate: "2026-01-01",
    });
    s = reducer(s, {
      type: "setTrackerProject",
      id: "tr1",
      projectId: "p2",
    });
    s = reducer(s, { type: "deleteProject", id: "p1" });
    expect(tracker(s).projectId).toBe("p2");
  });

  it("actions on an unknown tracker are no-ops", () => {
    const before = withTracker();
    const after = reducer(before, {
      type: "renameTracker",
      id: "nope",
      name: "X",
    });
    expect(after.trackers).toEqual(before.trackers);
  });

  it("does not mutate the tracker it updates", () => {
    const before = withTracker();
    const json = JSON.stringify(before);
    reducer(before, {
      type: "setTrackerSnapshot",
      id: "tr1",
      snapshot: snapshot("2026-02-01T09:00:00Z"),
      sample: sample("2026-02-01"),
    });
    expect(JSON.stringify(before)).toBe(json);
  });
});

describe("tracker persistence", () => {
  it("a tracker edit produces exactly one tracker op", () => {
    const before = reducer(base(), {
      type: "createTracker",
      id: "tr1",
      name: "Q1 Initiative",
      initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
      initiativeKey: "ACME-1",
      baseUrl: "https://acme.atlassian.net",
    });
    const after = reducer(before, {
      type: "renameTracker",
      id: "tr1",
      name: "Renamed",
    });
    const ops = diffStates(before, after, new Clock("dev-test"));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      entity: "tracker",
      id: "tr1",
      deleted: false,
    });
  });
});
