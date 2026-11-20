import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { Plan, Project, Team, TeamMember } from "./types";
import { fromISO } from "./dates";
import { simulateSpan, runPlan as runPlanTeams } from "./scheduling";

/** The pre-multi-team roster shape used by the original test suite. */
type LegacyTeam = { members: TeamMember[]; offDays: Record<string, string[]> };

function asTeam(t: LegacyTeam, id = "team1", name = "Team 1"): Team {
  return { id, name, members: t.members, offDays: t.offDays };
}

/**
 * Back-compat wrapper matching the old single-team `runPlan(project, team)`
 * signature by wrapping the roster into one team. The existing tests below use
 * it unchanged; the multi-team tests call `runPlanTeams` directly.
 */
function runPlan(project: Project, team: LegacyTeam, now?: string) {
  return runPlanTeams(project, [asTeam(team)], now);
}

/* Calendar reference (2026):
   Fri 07-24 · Sat 07-25 · Sun 07-26 · Mon 07-27 · Tue 07-28 · Wed 07-29 ·
   Thu 07-30 · Fri 07-31 */

const FIXED_NOW = "2026-07-23T00:00:00.000Z";

function member(id: string, specialization: string): TeamMember {
  return { id, name: id.toUpperCase(), specialization };
}

interface TaskSpec {
  id: string;
  name?: string;
  estimateDays: number;
  specialization: string;
  excluded?: boolean;
}

function project(startDate: string, tasks: TaskSpec[]): Project {
  return {
    id: "p1",
    name: "P",
    startDate,
    plan: null,
    planViewMode: "person",
    epics: [
      {
        id: "e1",
        name: "Epic 1",
        tasks: tasks.map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          estimateDays: t.estimateDays,
          specialization: t.specialization,
          excluded: t.excluded ?? false,
        })),
      },
    ],
  };
}

describe("simulateSpan", () => {
  it("skips weekends when counting working days", () => {
    // Start Friday 07-24, 3 workdays: Fri 24, Mon 27, Tue 28.
    const span = simulateSpan(fromISO("2026-07-24"), 3, new Set());
    expect(span.start).toEqual(fromISO("2026-07-24"));
    expect(span.end).toEqual(fromISO("2026-07-28"));
  });

  it("advances the start off a weekend", () => {
    // Start Saturday 07-25, 1 workday -> Monday 07-27.
    const span = simulateSpan(fromISO("2026-07-25"), 1, new Set());
    expect(span.start).toEqual(fromISO("2026-07-27"));
    expect(span.end).toEqual(fromISO("2026-07-27"));
  });

  it("skips the assignee's off-days", () => {
    // Start Mon 07-27, 2 workdays, with Tue 07-28 off: Mon 27, Wed 29.
    const span = simulateSpan(
      fromISO("2026-07-27"),
      2,
      new Set(["2026-07-28"]),
    );
    expect(span.start).toEqual(fromISO("2026-07-27"));
    expect(span.end).toEqual(fromISO("2026-07-29"));
  });
});

describe("runPlan — assignment basics", () => {
  it("computes start/end that skip weekends and off-days", () => {
    const team = {
      members: [member("a", "FE")],
      offDays: { a: ["2026-07-28"] },
    };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 2, specialization: "FE" },
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]).toMatchObject({
      taskId: "t1",
      memberId: "a",
      start: "2026-07-27",
      end: "2026-07-29", // 28th is off
    });
  });

  it("keeps the original decimal estimate but schedules whole workdays", () => {
    const team = { members: [member("a", "FE")], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 0.5, specialization: "FE" },
        { id: "t2", estimateDays: 1, specialization: "FE" },
      ]),
      team,
      FIXED_NOW,
    );
    // 0.5 rounds up to 1 workday: t1 = Mon 27, t2 = Tue 28.
    expect(plan.assignments[0].estimateDays).toBe(0.5);
    expect(plan.assignments[0]).toMatchObject({
      start: "2026-07-27",
      end: "2026-07-27",
    });
    expect(plan.assignments[1]).toMatchObject({
      start: "2026-07-28",
      end: "2026-07-28",
    });
  });

  it("reports workDays and the rounding buffer gained from whole-day rounding", () => {
    const team = { members: [member("a", "FE")], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 0.5, specialization: "FE" }, // -> 1 day, +0.5
        { id: "t2", estimateDays: 1.3, specialization: "FE" }, // -> 2 days, +0.7
        { id: "t3", estimateDays: 2, specialization: "FE" }, // -> 2 days, +0
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.assignments.map((a) => a.workDays)).toEqual([1, 2, 2]);
    // 0.5 + 0.7 + 0 = 1.2 working days of slack, rounded to 2 decimals.
    expect(plan.roundingBufferDays).toBeCloseTo(1.2, 5);
  });

  it("scales the rounding buffer by a member's speed", () => {
    // speed 2 -> effective 1.5 workdays, rounded up to 2: +0.5 buffer.
    const team = { members: [{ ...member("a", "FE"), speed: 2 }], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 3, specialization: "FE" },
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.assignments[0].workDays).toBe(2);
    expect(plan.roundingBufferDays).toBeCloseTo(0.5, 5);
  });
});

describe("runPlan — candidate selection", () => {
  it("assigns to whoever is free soonest", () => {
    // A is off on the start day, so B finishes sooner and wins.
    const team = {
      members: [member("a", "FE"), member("b", "FE")],
      offDays: { a: ["2026-07-27"] },
    };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 1, specialization: "FE" },
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.assignments[0].memberId).toBe("b");
    expect(plan.assignments[0]).toMatchObject({
      start: "2026-07-27",
      end: "2026-07-27",
    });
  });

  it("breaks a finish-time tie in favor of the less-loaded member", () => {
    // B is off Mon+Tue, so B's cursor lands on Wed 29 — the same day A's cursor
    // reaches after taking t1. t2 ties on end date; A is more loaded, so B wins.
    const team = {
      members: [member("a", "FE"), member("b", "FE")],
      offDays: { b: ["2026-07-27", "2026-07-28"] },
    };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 2, specialization: "FE" },
        { id: "t2", estimateDays: 1, specialization: "FE" },
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.assignments[0].memberId).toBe("a"); // sooner finisher takes t1
    expect(plan.assignments[1]).toMatchObject({
      taskId: "t2",
      memberId: "b", // tie on end date -> lighter load wins
      end: "2026-07-29",
    });
  });
});

describe("runPlan — tasks someone already holds", () => {
  const team = asTeam({
    members: [member("a", "FE"), member("b", "FE"), member("c", "BE")],
    offDays: {},
  });
  const proj = project("2026-07-27", [
    { id: "t1", estimateDays: 2, specialization: "FE" },
    { id: "t2", estimateDays: 2, specialization: "FE" },
    { id: "t3", estimateDays: 1, specialization: "FE" },
  ]);
  const who = (plan: Plan) =>
    Object.fromEntries(plan.assignments.map((a) => [a.taskId, a.memberId]));

  for (const mode of ["balanced", "smart"] as const) {
    it(`gives an assigned task to its assignee alone (${mode})`, () => {
      // Unassigned, t1 and t2 would go to a and b side by side; holding both,
      // a does them one after the other while b only gets the unheld t3.
      const plan = runPlanTeams(proj, [team], FIXED_NOW, {
        mode,
        assignees: { t1: "a", t2: "a" },
      });
      expect(who(plan)).toEqual({ t1: "a", t2: "a", t3: "b" });
      expect(plan.assignments.find((x) => x.taskId === "t2")).toMatchObject({
        start: "2026-07-29",
        end: "2026-07-30",
      });
    });

    it(`honours an assignee outside the task's specialization (${mode})`, () => {
      const plan = runPlanTeams(proj, [team], FIXED_NOW, {
        mode,
        assignees: { t3: "c" },
      });
      expect(who(plan).t3).toBe("c");
    });

    it(`ignores an assignee nobody in the pool is (${mode})`, () => {
      const plain = runPlanTeams(proj, [team], FIXED_NOW, { mode });
      const plan = runPlanTeams(proj, [team], FIXED_NOW, {
        mode,
        assignees: { t1: "someone-else" },
      });
      expect(plan.assignments).toEqual(plain.assignments);
    });
  }
});

describe("runPlan — an explicit order", () => {
  const team = asTeam({ members: [member("a", "FE")], offDays: {} });
  const proj = project("2026-07-27", [
    { id: "t1", estimateDays: 1, specialization: "FE" },
    { id: "t2", estimateDays: 1, specialization: "FE" },
    { id: "t3", estimateDays: 1, specialization: "FE" },
  ]);
  const order = (plan: Plan) =>
    [...plan.assignments]
      .sort((x, y) => x.start.localeCompare(y.start))
      .map((x) => x.taskId);

  for (const mode of ["balanced", "smart"] as const) {
    it(`takes tasks by rank, list order within one (${mode})`, () => {
      const plan = runPlanTeams(proj, [team], FIXED_NOW, {
        mode,
        rank: { t3: -1, t1: 2 },
      });
      expect(order(plan)).toEqual(["t3", "t2", "t1"]);
    });

    it(`still puts a prerequisite first (${mode})`, () => {
      const withDep: Project = {
        ...proj,
        epics: proj.epics.map((e) => ({
          ...e,
          tasks: e.tasks.map((t) =>
            t.id === "t3" ? { ...t, dependsOn: ["t1"] } : t,
          ),
        })),
      };
      const plan = runPlanTeams(withDep, [team], FIXED_NOW, {
        mode,
        rank: { t3: -1, t1: 2 },
      });
      expect(order(plan)).toEqual(["t2", "t1", "t3"]);
    });
  }

  it("keeps list order without one", () => {
    const plan = runPlanTeams(proj, [team], FIXED_NOW);
    expect(order(plan)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("runPlan — excluded and unassigned", () => {
  it("never schedules excluded tasks (not in assignments nor unassigned)", () => {
    const team = { members: [member("a", "FE")], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 1, specialization: "FE" },
        { id: "skip", estimateDays: 3, specialization: "FE", excluded: true },
      ]),
      team,
      FIXED_NOW,
    );
    const ids = [
      ...plan.assignments.map((a) => a.taskId),
      ...plan.unassigned.map((u) => u.id),
    ];
    expect(ids).toEqual(["t1"]);
  });

  it("puts a task with no matching specialist in unassigned with a clear reason", () => {
    const team = { members: [member("a", "FE")], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 1, specialization: "DevOps" },
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassigned).toHaveLength(1);
    expect(plan.unassigned[0].id).toBe("t1");
    expect(plan.unassigned[0].reason).toBe(
      'No team member with specialization "DevOps"',
    );
  });

  it("uses a distinct reason for a task with no specialization set", () => {
    const team = { members: [member("a", "FE")], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 1, specialization: "  " },
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.unassigned[0].reason).toBe("Task has no specialization set");
  });

  it("matches specialization case-insensitively and trimmed", () => {
    const team = { members: [member("a", "Front End")], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 1, specialization: " front end " },
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].memberId).toBe("a");
  });
});

describe("runPlan — invariants", () => {
  it("never overlaps sequential tasks for the same person", () => {
    const team = { members: [member("a", "FE")], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 2, specialization: "FE" },
        { id: "t2", estimateDays: 2, specialization: "FE" },
      ]),
      team,
      FIXED_NOW,
    );
    const [first, second] = plan.assignments;
    expect(first.memberId).toBe(second.memberId);
    // Second task starts strictly after the first one ends.
    expect(fromISO(second.start).getTime()).toBeGreaterThan(
      fromISO(first.end).getTime(),
    );
  });

  it("is deterministic — identical input yields identical output", () => {
    const team = {
      members: [member("a", "FE"), member("b", "BE"), member("c", "FE")],
      offDays: { a: ["2026-07-28"] },
    };
    const p = project("2026-07-27", [
      { id: "t1", estimateDays: 2, specialization: "FE" },
      { id: "t2", estimateDays: 1, specialization: "BE" },
      { id: "t3", estimateDays: 3, specialization: "FE" },
      { id: "t4", estimateDays: 1, specialization: "QA" },
    ]);
    const a = runPlan(p, team, FIXED_NOW);
    const b = runPlan(p, team, FIXED_NOW);
    expect(a).toEqual(b);
  });
});

describe("runPlan — per-project helpers", () => {
  it("a helper's duration scales with speed: ceil(estimate / speed)", () => {
    const team = { members: [], offDays: {} };
    const proj = {
      ...project("2026-07-27", [
        { id: "t1", estimateDays: 5, specialization: "FE" },
      ]),
      helpers: [
        {
          id: "h1",
          name: "Ext Helper",
          specialization: "FE",
          speed: 0.6,
          availableFrom: "2026-07-27",
          availableTo: "2026-12-31",
        },
      ],
    };
    const plan = runPlan(proj, team, FIXED_NOW);
    expect(plan.assignments).toHaveLength(1);
    // ceil(5 / 0.6) = 9 workdays from Mon 07-27: 27,28,29,30,31, Aug 3,4,5,6.
    expect(plan.assignments[0]).toMatchObject({
      memberId: "h1",
      estimateDays: 5, // original decimal preserved for display
      start: "2026-07-27",
      end: "2026-08-06",
    });
  });

  it("does not start a helper before their availableFrom date", () => {
    const team = { members: [], offDays: {} };
    const proj = {
      ...project("2026-07-27", [
        { id: "t1", estimateDays: 2, specialization: "FE" },
      ]),
      helpers: [
        {
          id: "h1",
          name: "Ext",
          specialization: "FE",
          speed: 1,
          availableFrom: "2026-08-03", // a Monday
          availableTo: "2026-12-31",
        },
      ],
    };
    const plan = runPlan(proj, team, FIXED_NOW);
    expect(plan.assignments[0]).toMatchObject({
      start: "2026-08-03",
      end: "2026-08-04",
    });
  });

  it("never schedules a helper past their availableTo (hard window)", () => {
    const team = { members: [], offDays: {} };
    const proj = {
      ...project("2026-07-27", [
        { id: "t1", estimateDays: 5, specialization: "FE" },
      ]),
      helpers: [
        {
          id: "h1",
          name: "Ext",
          specialization: "FE",
          speed: 1,
          availableFrom: "2026-07-27",
          availableTo: "2026-07-30", // 5 workdays would end 07-31, past this
        },
      ],
    };
    const plan = runPlan(proj, team, FIXED_NOW);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassigned).toHaveLength(1);
    expect(plan.unassigned[0].reason).toMatch(/help window/i);
  });

  it("skips a helper's own off-days (e.g. Christmas holidays)", () => {
    const team = { members: [], offDays: {} };
    const proj = {
      ...project("2026-12-21", [
        { id: "t1", estimateDays: 5, specialization: "FE" },
      ]),
      helpers: [
        {
          id: "h1",
          name: "Ext",
          specialization: "FE",
          speed: 1,
          availableFrom: "2026-12-21",
          availableTo: "2027-01-31",
          // Christmas break: Thu 24th and Fri 25th are off.
          offDays: ["2026-12-24", "2026-12-25"],
        },
      ],
    };
    const plan = runPlan(proj, team, FIXED_NOW);
    // 5 workdays from Mon 12-21, skipping weekends + 24/25:
    // 21,22,23, (24,25 off, 26/27 weekend), 28,29 -> ends Tue 12-29.
    expect(plan.assignments[0]).toMatchObject({
      memberId: "h1",
      start: "2026-12-21",
      end: "2026-12-29",
    });
  });

  it("prefers whoever finishes soonest between a slow helper and the team", () => {
    // Fast team member vs a slow helper — the member finishes sooner and wins.
    const team = {
      members: [{ id: "m1", name: "Alice", specialization: "FE" }],
      offDays: {},
    };
    const proj = {
      ...project("2026-07-27", [
        { id: "t1", estimateDays: 3, specialization: "FE" },
      ]),
      helpers: [
        {
          id: "h1",
          name: "Slow Ext",
          specialization: "FE",
          speed: 0.5,
          availableFrom: "2026-07-27",
          availableTo: "2026-12-31",
        },
      ],
    };
    const plan = runPlan(proj, team, FIXED_NOW);
    expect(plan.assignments[0].memberId).toBe("m1");
  });
});

describe("runPlan — per-project member start dates", () => {
  it("holds a member's work until their per-project start override", () => {
    const team = {
      members: [member("a", "FE")],
      offDays: {},
    };
    const proj = {
      ...project("2026-07-27", [
        { id: "t1", estimateDays: 2, specialization: "FE" },
      ]),
      memberStarts: { a: "2026-08-10" }, // a Monday, ~2 weeks in
    };
    const plan = runPlan(proj, team, FIXED_NOW);
    expect(plan.assignments[0]).toMatchObject({
      memberId: "a",
      start: "2026-08-10",
      end: "2026-08-11",
    });
  });

  it("ignores an override earlier than the project start", () => {
    const team = { members: [member("a", "FE")], offDays: {} };
    const proj = {
      ...project("2026-07-27", [
        { id: "t1", estimateDays: 1, specialization: "FE" },
      ]),
      memberStarts: { a: "2026-07-01" }, // before project start → no effect
    };
    const plan = runPlan(proj, team, FIXED_NOW);
    expect(plan.assignments[0].start).toBe("2026-07-27");
  });

  it("schedules from the project start when no override is set", () => {
    const team = { members: [member("a", "FE")], offDays: {} };
    const plan = runPlan(
      project("2026-07-27", [
        { id: "t1", estimateDays: 1, specialization: "FE" },
      ]),
      team,
      FIXED_NOW,
    );
    expect(plan.assignments[0].start).toBe("2026-07-27");
  });
});

describe("runPlan — epic assignments (ownership)", () => {
  // Build a project with several epics and optional per-epic ownership.
  function projectWithEpics(
    startDate: string,
    epics: { id: string; tasks: TaskSpec[] }[],
    epicAssignments?: { [epicId: string]: string[] },
  ): Project {
    return {
      id: "p1",
      name: "P",
      startDate,
      plan: null,
      planViewMode: "person",
      epics: epics.map((e) => ({
        id: e.id,
        name: e.id,
        tasks: e.tasks.map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          estimateDays: t.estimateDays,
          specialization: t.specialization,
          excluded: t.excluded ?? false,
        })),
      })),
      epicAssignments,
    };
  }

  const twoBackendDevs = {
    members: [member("a", "BE"), member("b", "BE")],
    offDays: {},
  };

  it("prefers the epic's owner to start it, even when another dev is equally free", () => {
    // Both devs idle at the start, so t1 ties on finish date. Without ownership
    // the first candidate (A) would win; B owns epic 1, so the tie goes to B.
    const proj = projectWithEpics(
      "2026-07-27",
      [
        {
          id: "e1",
          tasks: [{ id: "t1", estimateDays: 3, specialization: "BE" }],
        },
      ],
      { e1: ["b"] },
    );
    const plan = runPlan(proj, twoBackendDevs, FIXED_NOW);
    expect(plan.assignments[0].memberId).toBe("b");
  });

  it("has each owner start their own epic when everyone begins free", () => {
    // B owns e1, A owns e2. Both start idle, so each owner wins the opening tie
    // on their epic and starts it.
    const proj = projectWithEpics(
      "2026-07-27",
      [
        {
          id: "e1",
          tasks: [{ id: "t1", estimateDays: 3, specialization: "BE" }],
        },
        {
          id: "e2",
          tasks: [{ id: "t2", estimateDays: 1, specialization: "BE" }],
        },
      ],
      { e1: ["b"], e2: ["a"] },
    );
    const plan = runPlan(proj, twoBackendDevs, FIXED_NOW);
    const byTask = Object.fromEntries(
      plan.assignments.map((a) => [a.taskId, a.memberId]),
    );
    expect(byTask).toEqual({ t1: "b", t2: "a" });
  });

  it("keeps assignment non-exclusive — a non-owner helps on an owned epic", () => {
    // A owns e1; assignment shouldn't make e1 A-only. A starts it, then the
    // idle C helps with the second task instead of A carrying both alone.
    const team = {
      members: [member("a", "BE"), member("c", "BE")],
      offDays: {},
    };
    const proj = projectWithEpics(
      "2026-07-27",
      [
        {
          id: "e1",
          tasks: [
            { id: "t1", estimateDays: 2, specialization: "BE" },
            { id: "t2", estimateDays: 2, specialization: "BE" },
          ],
        },
      ],
      { e1: ["a"] },
    );
    const plan = runPlan(proj, team, FIXED_NOW);
    const byTask = Object.fromEntries(
      plan.assignments.map((a) => [a.taskId, a.memberId]),
    );
    expect(byTask.t1).toBe("a"); // owner starts it
    expect(byTask.t2).toBe("c"); // non-owner helps rather than the epic being A-only
  });

  it("never leaves an owner idle: a dev assigned to a later epic still picks up earlier work", () => {
    // This is the bug fix: B owns only the later e2, but must NOT sit idle
    // waiting for it while there is earlier, unowned e1 work they could do.
    const proj = projectWithEpics(
      "2026-07-27",
      [
        {
          id: "e1",
          tasks: [
            { id: "t1", estimateDays: 2, specialization: "BE" },
            { id: "t2", estimateDays: 2, specialization: "BE" },
          ],
        },
        {
          id: "e2",
          tasks: [{ id: "t3", estimateDays: 2, specialization: "BE" }],
        },
      ],
      { e2: ["b"] },
    );
    const plan = runPlan(proj, twoBackendDevs, FIXED_NOW);
    const byTask = Object.fromEntries(
      plan.assignments.map((a) => [a.taskId, a.memberId]),
    );
    // B helps on e1 rather than idling, and everything gets scheduled.
    expect(byTask.t2).toBe("b");
    expect(plan.unassigned).toHaveLength(0);
  });

  it("plans identically to no-ownership when assignments are empty", () => {
    const epics = [
      {
        id: "e1",
        tasks: [
          { id: "t1", estimateDays: 2, specialization: "BE" },
          { id: "t2", estimateDays: 1, specialization: "BE" },
        ],
      },
    ];
    const withEmpty = runPlan(
      projectWithEpics("2026-07-27", epics, {}),
      twoBackendDevs,
      FIXED_NOW,
    );
    const without = runPlan(
      projectWithEpics("2026-07-27", epics),
      twoBackendDevs,
      FIXED_NOW,
    );
    expect(withEmpty.assignments).toEqual(without.assignments);
    expect(withEmpty.unassigned).toEqual(without.unassigned);
  });
});

describe("runPlan — dependencies", () => {
  interface DepTaskSpec {
    id: string;
    name?: string;
    estimateDays: number;
    specialization: string;
    excluded?: boolean;
    dependsOn?: string[];
  }
  function proj(
    startDate: string,
    epics: { id: string; dependsOn?: string[]; tasks: DepTaskSpec[] }[],
  ): Project {
    return {
      id: "p1",
      name: "P",
      startDate,
      plan: null,
      planViewMode: "person",
      epics: epics.map((e) => ({
        id: e.id,
        name: e.id,
        dependsOn: e.dependsOn,
        tasks: e.tasks.map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          estimateDays: t.estimateDays,
          specialization: t.specialization,
          excluded: t.excluded ?? false,
          dependsOn: t.dependsOn,
        })),
      })),
    };
  }
  const twoFE = {
    members: [member("a", "FE"), member("b", "FE")],
    offDays: {},
  };

  it("holds a task until its prerequisite task finishes", () => {
    // Two free devs would normally run t1 and t2 in parallel; t2 depends on t1
    // so it must start only after t1 ends.
    const plan = runPlan(
      proj("2026-07-27", [
        {
          id: "e1",
          tasks: [
            { id: "t1", estimateDays: 2, specialization: "FE" },
            {
              id: "t2",
              estimateDays: 2,
              specialization: "FE",
              dependsOn: ["t1"],
            },
          ],
        },
      ]),
      twoFE,
      FIXED_NOW,
    );
    const t1 = plan.assignments.find((a) => a.taskId === "t1")!;
    const t2 = plan.assignments.find((a) => a.taskId === "t2")!;
    expect(fromISO(t2.start).getTime()).toBeGreaterThan(
      fromISO(t1.end).getTime(),
    );
  });

  it("makes an epic dependency wait for the whole prerequisite epic", () => {
    // e2 depends on e1. Without the dependency, idle B would start t2 on day 1;
    // with it, t2 waits until e1's t1 (done by A) finishes.
    const plan = runPlan(
      proj("2026-07-27", [
        {
          id: "e1",
          tasks: [{ id: "t1", estimateDays: 2, specialization: "FE" }],
        },
        {
          id: "e2",
          dependsOn: ["e1"],
          tasks: [{ id: "t2", estimateDays: 1, specialization: "FE" }],
        },
      ]),
      twoFE,
      FIXED_NOW,
    );
    // t1: Mon 07-27 -> Tue 07-28; t2 can't start before Wed 07-29.
    expect(plan.assignments.find((a) => a.taskId === "t2")!.start).toBe(
      "2026-07-29",
    );
  });

  it("reports tasks in a circular dependency as unassigned", () => {
    const plan = runPlan(
      proj("2026-07-27", [
        {
          id: "e1",
          tasks: [
            {
              id: "t1",
              estimateDays: 1,
              specialization: "FE",
              dependsOn: ["t2"],
            },
            {
              id: "t2",
              estimateDays: 1,
              specialization: "FE",
              dependsOn: ["t1"],
            },
          ],
        },
      ]),
      twoFE,
      FIXED_NOW,
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassigned.map((u) => u.id).sort()).toEqual(["t1", "t2"]);
    expect(plan.unassigned[0].reason).toMatch(/circular/i);
  });

  it("blocks a task whose prerequisite couldn't be scheduled", () => {
    const plan = runPlan(
      proj("2026-07-27", [
        {
          id: "e1",
          tasks: [
            { id: "t1", estimateDays: 1, specialization: "DevOps" }, // no specialist
            {
              id: "t2",
              estimateDays: 1,
              specialization: "FE",
              dependsOn: ["t1"],
            },
          ],
        },
      ]),
      twoFE,
      FIXED_NOW,
    );
    const t2 = plan.unassigned.find((u) => u.id === "t2")!;
    expect(t2.reason).toMatch(/prerequisite/i);
  });

  it("ignores a dependency on an excluded task", () => {
    const plan = runPlan(
      proj("2026-07-27", [
        {
          id: "e1",
          tasks: [
            { id: "t1", estimateDays: 2, specialization: "FE", excluded: true },
            {
              id: "t2",
              estimateDays: 1,
              specialization: "FE",
              dependsOn: ["t1"],
            },
          ],
        },
      ]),
      twoFE,
      FIXED_NOW,
    );
    expect(plan.assignments.map((a) => a.taskId)).toEqual(["t2"]);
    expect(plan.assignments[0].start).toBe("2026-07-27"); // not blocked
  });

  it("puts QA in the first gap its own epic allows, not behind later QA", () => {
    // e1's QA is listed above the work it depends on, so the pass reaches it
    // only after e2 and e3's QA are booked. The QA person is idle 09-21 →
    // 09-25 and qa1 is ready on 09-21: it must go there, not after qa3.
    const plan = runPlan(
      proj("2026-09-07", [
        {
          id: "e1",
          tasks: [
            {
              id: "qa1",
              estimateDays: 2,
              specialization: "QA",
              dependsOn: ["a1", "a2"],
            },
            { id: "a1", estimateDays: 5, specialization: "FE" },
            { id: "a2", estimateDays: 5, specialization: "FE" },
          ],
        },
        {
          id: "e2",
          tasks: [
            { id: "b1", estimateDays: 5, specialization: "FE" },
            {
              id: "qa2",
              estimateDays: 2,
              specialization: "QA",
              dependsOn: ["b1"],
            },
          ],
        },
        {
          id: "e3",
          tasks: [
            { id: "c1", estimateDays: 10, specialization: "FE" },
            {
              id: "qa3",
              estimateDays: 2,
              specialization: "QA",
              dependsOn: ["c1"],
            },
          ],
        },
      ]),
      { members: [member("dev", "FE"), member("qa", "QA")], offDays: {} },
      FIXED_NOW,
    );
    const at = (id: string) => {
      const a = plan.assignments.find((x) => x.taskId === id)!;
      return [a.start, a.end];
    };
    expect(at("qa1")).toEqual(["2026-09-21", "2026-09-22"]);
    expect(at("qa2")).toEqual(["2026-09-28", "2026-09-29"]);
    expect(at("qa3")).toEqual(["2026-10-12", "2026-10-13"]);
  });

  it("only fills a gap the whole task fits in", () => {
    // qa-short is booked first, 09-16 → 09-17. qa-long (4 days) is ready on
    // 09-14, but only two days are free before that booking, so it goes after.
    const plan = runPlan(
      proj("2026-09-07", [
        {
          id: "e1",
          tasks: [
            {
              id: "qa-long",
              estimateDays: 4,
              specialization: "QA",
              dependsOn: ["d1"],
            },
            { id: "d1", estimateDays: 5, specialization: "FE" },
            { id: "d2", estimateDays: 2, specialization: "FE" },
            {
              id: "qa-short",
              estimateDays: 2,
              specialization: "QA",
              dependsOn: ["d2"],
            },
          ],
        },
      ]),
      { members: [member("dev", "FE"), member("qa", "QA")], offDays: {} },
      FIXED_NOW,
    );
    const at = (id: string) => {
      const a = plan.assignments.find((x) => x.taskId === id)!;
      return [a.start, a.end];
    };
    expect(at("qa-short")).toEqual(["2026-09-16", "2026-09-17"]);
    expect(at("qa-long")).toEqual(["2026-09-18", "2026-09-23"]);
  });
});

describe("runPlan — multiple teams & inclusions", () => {
  // A project with named epics, each holding one-day BE tasks.
  function multiEpicProject(
    startDate: string,
    epics: { id: string; tasks: TaskSpec[] }[],
    teamInclusions?: Project["teamInclusions"],
  ): Project {
    return {
      id: "p1",
      name: "P",
      startDate,
      plan: null,
      planViewMode: "person",
      teamInclusions,
      epics: epics.map((e) => ({
        id: e.id,
        name: e.id,
        tasks: e.tasks.map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          estimateDays: t.estimateDays,
          specialization: t.specialization,
          excluded: t.excluded ?? false,
        })),
      })),
    };
  }

  const teamA: Team = {
    id: "A",
    name: "Team A",
    members: [member("a", "BE")],
    offDays: {},
  };
  const teamB: Team = {
    id: "B",
    name: "Team B",
    members: [member("b", "BE")],
    offDays: {},
  };

  const twoEpics = [
    { id: "e1", tasks: [{ id: "t1", estimateDays: 1, specialization: "BE" }] },
    { id: "e2", tasks: [{ id: "t2", estimateDays: 1, specialization: "BE" }] },
  ];

  it("with no inclusions, every team participates", () => {
    // Both teams eligible; both tasks get scheduled across the two teams.
    const plan = runPlanTeams(
      multiEpicProject("2026-07-27", twoEpics),
      [teamA, teamB],
      FIXED_NOW,
    );
    expect(plan.unassigned).toHaveLength(0);
    const who = new Set(plan.assignments.map((a) => a.memberId));
    expect(who.has("a") && who.has("b")).toBe(true);
  });

  it("scopes a team to its epics (each team only works its own)", () => {
    const plan = runPlanTeams(
      multiEpicProject("2026-07-27", twoEpics, [
        { teamId: "A", epicIds: ["e1"] },
        { teamId: "B", epicIds: ["e2"] },
      ]),
      [teamA, teamB],
      FIXED_NOW,
    );
    const byTask = Object.fromEntries(
      plan.assignments.map((a) => [a.taskId, a.memberId]),
    );
    expect(byTask).toEqual({ t1: "a", t2: "b" });
  });

  it("excludes a team not present in the inclusions list", () => {
    const plan = runPlanTeams(
      multiEpicProject("2026-07-27", [twoEpics[0]], [{ teamId: "B" }]),
      [teamA, teamB],
      FIXED_NOW,
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].memberId).toBe("b"); // team A doesn't participate
  });

  it("exclusive scope reserves the epic — other teams are locked out", () => {
    // A owns e1 exclusively but is OFF on Mon; without the reservation the free
    // B would win. Exclusivity forces the task onto A, starting the next day.
    const reservedA: Team = { ...teamA, offDays: { a: ["2026-07-27"] } };
    const plan = runPlanTeams(
      multiEpicProject(
        "2026-07-27",
        [twoEpics[0]],
        [{ teamId: "A", epicIds: ["e1"], exclusive: true }, { teamId: "B" }],
      ),
      [reservedA, teamB],
      FIXED_NOW,
    );
    expect(plan.assignments[0]).toMatchObject({
      memberId: "a",
      start: "2026-07-28",
    });
  });

  it("non-exclusive scope still lets another team help on the epic", () => {
    // e1 has two tasks. A is scoped to e1 (not exclusive); B is unscoped. Both
    // idle, so A takes t1 and the still-idle B picks up t2 rather than waiting.
    const plan = runPlanTeams(
      multiEpicProject(
        "2026-07-27",
        [
          {
            id: "e1",
            tasks: [
              { id: "t1", estimateDays: 2, specialization: "BE" },
              { id: "t2", estimateDays: 2, specialization: "BE" },
            ],
          },
        ],
        [{ teamId: "A", epicIds: ["e1"] }, { teamId: "B" }],
      ),
      [teamA, teamB],
      FIXED_NOW,
    );
    const byTask = Object.fromEntries(
      plan.assignments.map((a) => [a.taskId, a.memberId]),
    );
    expect(byTask.t1).toBe("a");
    expect(byTask.t2).toBe("b"); // the other team helps on the scoped epic
  });

  it("honors a team's time window (availableFrom delays the start)", () => {
    const plan = runPlanTeams(
      multiEpicProject(
        "2026-07-27",
        [twoEpics[0]],
        [
          { teamId: "A", availableFrom: "2026-08-03" }, // a Monday
        ],
      ),
      [teamA],
      FIXED_NOW,
    );
    expect(plan.assignments[0].start).toBe("2026-08-03");
  });

  it("honors a team's time window (availableTo is a hard end)", () => {
    const plan = runPlanTeams(
      multiEpicProject(
        "2026-07-27",
        [
          {
            id: "e1",
            tasks: [{ id: "t1", estimateDays: 5, specialization: "BE" }],
          },
        ],
        [
          { teamId: "A", availableTo: "2026-07-30" }, // 5 workdays end 07-31
        ],
      ),
      [teamA],
      FIXED_NOW,
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassigned).toHaveLength(1);
  });

  it("combines epic scope and a time window on the same team", () => {
    // A exclusively owns e1 AND only works from 08-03; e2 is left to B. The
    // reservation stops the free B from grabbing e1 before A's window opens.
    const plan = runPlanTeams(
      multiEpicProject("2026-07-27", twoEpics, [
        {
          teamId: "A",
          epicIds: ["e1"],
          exclusive: true,
          availableFrom: "2026-08-03",
        },
        { teamId: "B" },
      ]),
      [teamA, teamB],
      FIXED_NOW,
    );
    const t1 = plan.assignments.find((a) => a.taskId === "t1")!;
    const t2 = plan.assignments.find((a) => a.taskId === "t2")!;
    expect(t1).toMatchObject({ memberId: "a", start: "2026-08-03" });
    expect(t2.memberId).toBe("b"); // B (unscoped) handles e2 from day one
    expect(t2.start).toBe("2026-07-27");
  });

  it("velocity multiplier stretches a slow team's task span", () => {
    // A single 2-day BE task. At velocity 0.5 the effective speed halves, so
    // workDays = ceil(2 / 0.5) = 4: Mon 07-27 → Thu 07-30 (vs 07-28 at 1×).
    const plan = runPlanTeams(
      multiEpicProject(
        "2026-07-27",
        [
          {
            id: "e1",
            tasks: [{ id: "t1", estimateDays: 2, specialization: "BE" }],
          },
        ],
        [{ teamId: "A", velocity: 0.5 }],
      ),
      [teamA],
      FIXED_NOW,
    );
    expect(plan.assignments[0]).toMatchObject({
      memberId: "a",
      start: "2026-07-27",
      end: "2026-07-30",
    });
  });

  it("velocity stacks on top of the member's own speed", () => {
    // Member speed 2 (twice as fast) × velocity 0.5 = effective 1×, so a 2-day
    // task takes 2 workdays: Mon 07-27 → Tue 07-28.
    const fastTeam: Team = {
      id: "A",
      name: "Team A",
      members: [{ id: "a", name: "A", specialization: "BE", speed: 2 }],
      offDays: {},
    };
    const plan = runPlanTeams(
      multiEpicProject(
        "2026-07-27",
        [
          {
            id: "e1",
            tasks: [{ id: "t1", estimateDays: 2, specialization: "BE" }],
          },
        ],
        [{ teamId: "A", velocity: 0.5 }],
      ),
      [fastTeam],
      FIXED_NOW,
    );
    expect(plan.assignments[0]).toMatchObject({
      start: "2026-07-27",
      end: "2026-07-28",
    });
  });

  it("velocity absent or 1 leaves the schedule unchanged", () => {
    const base = runPlanTeams(
      multiEpicProject("2026-07-27", [twoEpics[0]]),
      [teamA],
      FIXED_NOW,
    );
    const withOne = runPlanTeams(
      multiEpicProject(
        "2026-07-27",
        [twoEpics[0]],
        [{ teamId: "A", velocity: 1 }],
      ),
      [teamA],
      FIXED_NOW,
    );
    expect(withOne.assignments).toEqual(base.assignments);
  });
});

describe("runPlan — smart (days-off-aware) mode", () => {
  const START = "2026-07-27"; // Monday
  // A's break: Wed 07-29 through Fri 08-07 (weekdays only). So A is free only
  // Mon 07-27 + Tue 07-28 before disappearing for a week and a half.
  const A_BREAK = [
    "2026-07-29",
    "2026-07-30",
    "2026-07-31",
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
  ];
  const A = member("a", "FE"); // about to take a long break
  const B = member("b", "FE"); // present throughout

  function feTeam(order: TeamMember[]): Team {
    return { id: "t", name: "T", members: order, offDays: { a: A_BREAK } };
  }
  function twoTaskProject(t1: TaskSpec, t2: TaskSpec): Project {
    return {
      id: "p",
      name: "P",
      startDate: START,
      plan: null,
      planViewMode: "person",
      epics: [
        {
          id: "e",
          name: "E",
          tasks: [t1, t2].map((t) => ({
            id: t.id,
            name: t.name ?? t.id,
            estimateDays: t.estimateDays,
            specialization: t.specialization,
            excluded: false,
          })),
        },
      ],
    };
  }
  const byTask = (p: Plan): Record<string, string> =>
    Object.fromEntries(p.assignments.map((a) => [a.taskId, a.memberId]));
  const lastEnd = (p: Plan): string | undefined =>
    p.assignments
      .map((a) => a.end)
      .sort()
      .at(-1);

  const SHORT: TaskSpec = {
    id: "short",
    estimateDays: 2,
    specialization: "FE",
  };
  const LONG: TaskSpec = { id: "long", estimateDays: 4, specialization: "FE" };

  it("gives the about-to-break member the fitting task and frees the colleague for the long one — regardless of member order", () => {
    const proj = twoTaskProject(SHORT, LONG); // priority: short, then long
    for (const order of [
      [A, B],
      [B, A],
    ]) {
      const smart = runPlanTeams(proj, [feTeam(order)], FIXED_NOW, {
        mode: "smart",
      });
      // A takes the short task (fits Mon+Tue before the break); B takes the long
      // one and runs it Mon–Thu without splitting it across anyone's days off.
      expect(byTask(smart)).toEqual({ short: "a", long: "b" });
      expect(lastEnd(smart)).toBe("2026-07-30");
    }
  });

  it("fixes the member-order sensitivity of balanced mode", () => {
    const proj = twoTaskProject(SHORT, LONG);
    // Balanced is order-dependent: list A first and it happens to route well…
    const balancedGood = runPlanTeams(proj, [feTeam([A, B])], FIXED_NOW);
    expect(byTask(balancedGood)).toEqual({ short: "a", long: "b" });
    // …but list B first and balanced hands B the short task too, so B does both
    // and A sits idle across the entire break.
    const balancedBad = runPlanTeams(proj, [feTeam([B, A])], FIXED_NOW);
    expect(byTask(balancedBad)).toEqual({ short: "b", long: "b" });
    expect(lastEnd(balancedBad)).toBe("2026-08-03");
    // Smart mode gets the good outcome either way (asserted in the test above).
  });

  it("does not strand a task with dependents on a soon-to-be-away worker", () => {
    // A is free only Mon+Tue, then away through 08-14. A chain t1 -> t3 -> t5
    // plus leaves t2, t4, t6. Because A's holiday pushes t3's start to *after*
    // the break, A's span for t3 doesn't straddle — it just starts late — so the
    // old handoff kept t3 on A (finishing 08-19) and stalled its dependent t5
    // until after the holiday. The chain must stay with present B (who finishes
    // it early and unblocks t5), while A fills its pre-break gap with a leaf.
    const START2 = "2026-07-27";
    const HOLIDAY = [
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ];
    const mkTask = (id: string, dependsOn?: string[]) => ({
      id,
      name: id,
      estimateDays: 3,
      specialization: "FE",
      excluded: false,
      ...(dependsOn ? { dependsOn } : {}),
    });
    const proj: Project = {
      id: "p",
      name: "P",
      startDate: START2,
      plan: null,
      planViewMode: "person",
      epics: [
        {
          id: "e",
          name: "E",
          tasks: [
            mkTask("t1"),
            mkTask("t2"),
            mkTask("t3", ["t1"]),
            mkTask("t4"),
            mkTask("t5", ["t3"]),
            mkTask("t6"),
          ],
        },
      ],
    };
    const team: Team = {
      id: "t",
      name: "T",
      members: [A, B],
      offDays: { a: HOLIDAY },
    };
    const smart = runPlanTeams(proj, [team], FIXED_NOW, { mode: "smart" });
    const balanced = runPlanTeams(proj, [team], FIXED_NOW);
    const byTaskLocal = Object.fromEntries(
      smart.assignments.map((a) => [a.taskId, a.memberId]),
    );
    // The whole dependency chain stays with present B…
    expect(byTaskLocal.t1).toBe("b");
    expect(byTaskLocal.t3).toBe("b");
    expect(byTaskLocal.t5).toBe("b");
    // …and smart no longer finishes later than plain balanced list-scheduling.
    expect(lastEnd(smart)).toBe(lastEnd(balanced));
    expect(lastEnd(smart)).toBe("2026-08-17");
  });

  it("still hands an unavoidable straddle to the soonest finisher (no regression vs balanced)", () => {
    // Only A exists, so the long task must cross A's break no matter what.
    const proj = twoTaskProject(LONG, SHORT);
    const solo: Team = {
      id: "t",
      name: "T",
      members: [A],
      offDays: { a: A_BREAK },
    };
    const smart = runPlanTeams(proj, [solo], FIXED_NOW, { mode: "smart" });
    const balanced = runPlanTeams(proj, [solo], FIXED_NOW);
    expect(smart.assignments).toEqual(balanced.assignments);
    expect(smart.assignments.every((a) => a.memberId === "a")).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const proj = twoTaskProject(SHORT, LONG);
    const opts = { mode: "smart" as const, lookahead: 5 };
    const first = runPlanTeams(proj, [feTeam([A, B])], FIXED_NOW, opts);
    const second = runPlanTeams(proj, [feTeam([A, B])], FIXED_NOW, opts);
    expect(first).toEqual(second);
  });

  it("respects task dependencies", () => {
    const proj: Project = {
      id: "p",
      name: "P",
      startDate: START,
      plan: null,
      planViewMode: "person",
      epics: [
        {
          id: "e",
          name: "E",
          tasks: [
            {
              id: "first",
              name: "first",
              estimateDays: 2,
              specialization: "FE",
              excluded: false,
            },
            {
              id: "second",
              name: "second",
              estimateDays: 2,
              specialization: "FE",
              excluded: false,
              dependsOn: ["first"],
            },
          ],
        },
      ],
    };
    const plan = runPlanTeams(proj, [feTeam([A, B])], FIXED_NOW, {
      mode: "smart",
    });
    const first = plan.assignments.find((a) => a.taskId === "first")!;
    const second = plan.assignments.find((a) => a.taskId === "second")!;
    expect(second.start > first.end).toBe(true);
  });

  it("reports tasks with no matching specialist as unassigned", () => {
    const proj = twoTaskProject(
      { id: "qa", estimateDays: 1, specialization: "QA" },
      SHORT,
    );
    const plan = runPlanTeams(proj, [feTeam([A, B])], FIXED_NOW, {
      mode: "smart",
    });
    expect(plan.assignments.map((a) => a.taskId)).toEqual(["short"]);
    const qa = plan.unassigned.find((u) => u.id === "qa")!;
    expect(qa.reason).toContain("QA");
  });

  it("clamps a zero/negative lookahead to a valid window", () => {
    const proj = twoTaskProject(SHORT, LONG);
    const plan = runPlanTeams(proj, [feTeam([A, B])], FIXED_NOW, {
      mode: "smart",
      lookahead: 0,
    });
    // A complete plan (no crash, both tasks placed).
    expect(plan.assignments).toHaveLength(2);
    expect(plan.unassigned).toHaveLength(0);
  });
});

describe("project estimate buffer", () => {
  it("pads every task's estimate by the buffer percentage", () => {
    // 5-day task starting Mon 07-27 with no buffer: Mon–Fri, ends Fri 07-31.
    const base = project("2026-07-27", [
      { id: "t1", estimateDays: 5, specialization: "dev" },
    ]);
    const team = { members: [member("m1", "dev")], offDays: {} };

    const noBuffer = runPlan(base, team, FIXED_NOW);
    expect(noBuffer.assignments[0].end).toBe("2026-07-31");

    // 20% buffer -> 5 * 1.2 = 6 workdays: Mon 27–Mon 08-03 (weekend skipped).
    const buffered = runPlan({ ...base, buffer: 20 }, team, FIXED_NOW);
    expect(buffered.assignments[0].end).toBe("2026-08-03");
    // The recorded estimate reflects the buffer too, so exports stay consistent.
    expect(buffered.assignments[0].estimateDays).toBe(6);
  });

  it("treats absent / zero buffer as no padding", () => {
    const base = project("2026-07-27", [
      { id: "t1", estimateDays: 3, specialization: "dev" },
    ]);
    const team = { members: [member("m1", "dev")], offDays: {} };
    const zero = runPlan({ ...base, buffer: 0 }, team, FIXED_NOW);
    const absent = runPlan(base, team, FIXED_NOW);
    expect(zero.assignments[0].end).toBe(absent.assignments[0].end);
  });
});

describe("scheduling module purity", () => {
  it("does not import React or reference the DOM", () => {
    const src = readFileSync("src/scheduling.ts", "utf8");
    expect(src).not.toMatch(/from\s+['"]react/);
    // DOM globals as property access (window.x / document.x), not the English
    // words that appear in comments.
    expect(src).not.toMatch(/\bdocument\.\w/);
    expect(src).not.toMatch(/\bwindow\.\w/);
  });
});
