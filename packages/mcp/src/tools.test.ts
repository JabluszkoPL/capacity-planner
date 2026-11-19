import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppState } from "@planner/core";
import { runTool } from "./catalog";
import { applyActions, ToolError, type ToolOutcome } from "./context";
import { expandDates } from "./write";
import { fixtureContext, IDS } from "./fixtures.test-util";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const WRITE = { allowWrites: true };
const READ_ONLY = { allowWrites: false };

function call(
  name: string,
  args: Record<string, unknown> = {},
  options = WRITE,
  ctx = fixtureContext(),
): ToolOutcome & { result: Any; next: AppState } {
  const out = runTool(name, args, ctx, options);
  return {
    ...out,
    result: out.result as Any,
    next: applyActions(ctx, out.actions),
  };
}

function fails(
  name: string,
  args: Record<string, unknown>,
  options = WRITE,
): string {
  try {
    runTool(name, args, fixtureContext(), options);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return (err as Error).message;
  }
  throw new Error(`${name} did not fail`);
}

describe("read tools", () => {
  it("lists projects with their size and teams", () => {
    const { result, actions } = call("list_projects");
    expect(actions).toEqual([]);
    expect(result.projects).toEqual([
      expect.objectContaining({
        id: IDS.project,
        name: "Apollo",
        tasks: 3,
        estimateDays: 7,
        bufferPercent: 20,
        teams: ["Core"],
        plan: null,
        trackers: [expect.objectContaining({ id: IDS.tracker })],
      }),
    ]);
  });

  it("finds a project by name, ignoring case and spacing", () => {
    const { result } = call("get_project", { project: "  apollo " });
    expect(result.id).toBe(IDS.project);
    const billing = result.epics.find((e: Any) => e.name === "Billing");
    expect(billing.dependsOn).toEqual([{ id: IDS.epicLogin, name: "Login" }]);
    const api = result.epics[0].tasks.find((t: Any) => t.name === "API");
    expect(api.dependsOn).toEqual([{ id: IDS.taskUi, name: "UI" }]);
    expect(result.allTeamsParticipate).toBe(true);
    expect(result.teams[0].members.map((m: Any) => m.name)).toEqual([
      "Alice Kim",
      "Ben Osei",
      "Cara Diaz",
    ]);
  });

  it("says which names exist when one doesn't", () => {
    expect(fails("get_project", { project: "Zeus" })).toBe(
      'No project matches "Zeus". Known: "Apollo".',
    );
  });

  it("previews a plan without saving it", () => {
    const { result, actions } = call("preview_plan", { project: IDS.project });
    expect(actions).toEqual([]);
    expect(result.storedPlan).toBeNull();
    expect(result.preview.assignments).toHaveLength(3);
    expect(result.preview.start).toBe("2026-01-05");
    expect(result.endChanged).toBe(true);
  });

  it("lists teams with speeds and days off, optionally from a date", () => {
    const all = call("list_teams").result;
    const alice = all.teams[0].members.find((m: Any) => m.id === IDS.alice);
    expect(alice.offDays).toEqual(["2026-01-07"]);
    expect(all.teams[0].members.find((m: Any) => m.id === IDS.cara).speed).toBe(
      0.8,
    );
    const later = call("list_teams", { off_days_from: "2026-02-01" }).result;
    expect(later.teams[0].members[0].offDays).toEqual([]);
  });
});

describe("tracker tools", () => {
  it("lists trackers with their reading and freshness", () => {
    const { result } = call("list_trackers");
    expect(result.trackers[0]).toMatchObject({
      id: IDS.tracker,
      initiativeKey: "ACME-1",
      initiativeLink: "https://acme.atlassian.net/browse/ACME-1",
      project: { id: IDS.project, name: "Apollo" },
      lastRefresh: "2026-01-12T08:00:00.000Z",
      snapshotAgeDays: 0,
      samples: 2,
    });
    expect(typeof result.trackers[0].status).toBe("string");
  });

  it("classifies every Jira task against the plan, with links", () => {
    const { result } = call("get_tracker_issues", {
      tracker: "Apollo in Jira",
    });
    const byKey = Object.fromEntries(result.issues.map((i: Any) => [i.key, i]));
    expect(byKey["ACME-11"]).toMatchObject({
      classification: "matched",
      planTask: { id: IDS.taskUi, name: "UI", epicName: "Login" },
      assignee: "Alice Kim",
      link: "https://acme.atlassian.net/browse/ACME-11",
    });
    expect(byKey["ACME-12"]).toMatchObject({
      classification: "matched",
      originalEstimateDays: 4,
    });
    expect(byKey["ACME-13"]).toMatchObject({
      classification: "added_scope",
      specialization: "Backend",
    });
    expect(byKey["ACME-14"].classification).toBe("unmapped");
    expect(byKey["ACME-21"].classification).toBe("untracked");
    expect(result.counts).toEqual({
      matched: 2,
      added_scope: 1,
      unmapped: 1,
      untracked: 1,
      nice_to_have: 0,
    });
    const added = call("get_tracker_issues", {
      tracker: IDS.tracker,
      classification: "added_scope",
    }).result;
    expect(added.issues.map((i: Any) => i.key)).toEqual(["ACME-13"]);
  });

  it("gathers postmortem facts: added scope, gaps both ways, estimate drift", () => {
    const { result } = call("get_tracker_scope_changes", {
      tracker: IDS.tracker,
    });
    expect(result.counts).toMatchObject({
      planTasks: 3,
      planTasksMatched: 2,
      planTasksWithoutJira: 1,
      jiraTasks: 5,
      added_scope: 1,
      unmapped: 1,
    });
    expect(result.addedScope).toMatchObject({
      totalDays: 1,
      bySpecialization: [{ specialization: "Backend", issues: 1, days: 1 }],
    });
    expect(result.addedScope.issues[0].link).toBe(
      "https://acme.atlassian.net/browse/ACME-13",
    );
    expect(result.unmapped.map((i: Any) => i.key)).toEqual(["ACME-14"]);
    expect(result.planTasksWithoutJira).toEqual([
      expect.objectContaining({ name: "Invoices", epicName: "Billing" }),
    ]);
    // API: 3 days planned, 4 in Jira; UI: 2 planned, 1 in Jira.
    const drift = Object.fromEntries(
      result.estimateChanges.map((c: Any) => [c.taskName, c.deltaDays]),
    );
    expect(drift).toEqual({ UI: -1, API: 1 });
    expect(result.untrackedEpics).toEqual([
      {
        key: "ACME-20",
        link: "https://acme.atlassian.net/browse/ACME-20",
        summary: "Other team's epic",
      },
    ]);
    expect(result.buffer.first.date).toBe("2026-01-09");
    expect(result.buffer.last.bufferUsedDays).toBe(1);
  });

  it("returns one tracker with its epics and history", () => {
    const { result } = call("get_tracker", { tracker: IDS.tracker });
    expect(result.epics.map((e: Any) => [e.key, e.tracking])).toEqual([
      ["ACME-10", "tracked"],
      ["ACME-20", "untracked"],
    ]);
    expect(result.samples).toHaveLength(2);
    expect(result.status.today).toBe("2026-01-12");
    const lean = call("get_tracker", {
      tracker: IDS.tracker,
      include_samples: false,
    }).result;
    expect(lean.samples).toBeUndefined();
  });
});

describe("write tools", () => {
  it("are refused while changes are off, even if a client calls them", () => {
    expect(fails("run_plan", { project: IDS.project }, READ_ONLY)).toContain(
      "Changes are turned off",
    );
  });

  it("run the plan through the store's own setPlan action", () => {
    const { actions, next, result, navigate } = call("run_plan", {
      project: "Apollo",
    });
    expect(actions).toEqual([
      expect.objectContaining({ type: "setPlan", projectId: IDS.project }),
    ]);
    const plan = next.projects[0].plan!;
    expect(plan.generatedAt).toBe("2026-01-12T10:00:00.000Z");
    expect(plan.assignments).toHaveLength(3);
    expect(result.previousEnd).toBeNull();
    expect(result.end).toBe(result.plan.end);
    expect(navigate).toBe(`/project/${IDS.project}`);
  });

  it("set days off as the exact toggles that change them", () => {
    const { actions, result } = call("set_member_off_days", {
      member: "alice kim",
      add: ["2026-01-08", "2026-01-09..2026-01-12"],
      remove: ["2026-01-07"],
    });
    // 9 Fri, 10–11 weekend skipped, 12 Mon.
    expect(result.added).toEqual(["2026-01-08", "2026-01-09", "2026-01-12"]);
    expect(result.removed).toEqual(["2026-01-07"]);
    expect(result.offDays).toEqual(["2026-01-08", "2026-01-09", "2026-01-12"]);
    expect(actions).toHaveLength(4);
    expect(actions.every((a) => a.type === "toggleOffDay")).toBe(true);
  });

  it("are idempotent: setting the days already on file changes nothing", () => {
    const { actions, result } = call("set_member_off_days", {
      member: IDS.alice,
      set: ["2026-01-07"],
    });
    expect(actions).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("names the plans to re-run after a change to a person", () => {
    const ctx = fixtureContext();
    ctx.state = applyActions(
      ctx,
      runTool("run_plan", { project: IDS.project }, ctx, WRITE).actions,
    );
    const out = runTool(
      "set_member_off_days",
      {
        member: IDS.ben,
        add: ["2026-01-06"],
      },
      ctx,
      WRITE,
    ).result as Any;
    expect(out.plansToRerun).toEqual([{ id: IDS.project, name: "Apollo" }]);
  });

  it("change a project's start date and buffer", () => {
    const { next, result } = call("update_project", {
      project: IDS.project,
      start_date: "2026-02-02",
      buffer_percent: 0,
    });
    expect(next.projects[0].startDate).toBe("2026-02-02");
    expect(next.projects[0].buffer).toBeUndefined();
    expect(result.project.bufferPercent).toBe(0);
  });

  it("refuse lookahead outside smart mode", () => {
    expect(
      fails("update_project", { project: IDS.project, lookahead: 3 }),
    ).toContain("smart");
  });

  it("add a task with dependencies named by task name", () => {
    const { next, result } = call("add_task", {
      project: IDS.project,
      epic: "Billing",
      name: "Refunds",
      estimate_days: 1.5,
      specialization: "Backend",
      depends_on: ["Invoices"],
    });
    const billing = next.projects[0].epics[1];
    expect(billing.tasks[1]).toEqual({
      id: result.task.id,
      name: "Refunds",
      estimateDays: 1.5,
      specialization: "Backend",
      excluded: false,
      dependsOn: [IDS.taskInvoices],
    });
  });

  it("skip a task rather than delete it", () => {
    const { next } = call("update_task", {
      project: IDS.project,
      task: "Invoices",
      excluded: true,
    });
    expect(next.projects[0].epics[1].tasks[0].excluded).toBe(true);
  });

  it("create a project with teams, and copy one under a new name", () => {
    const created = call("create_project", {
      name: "Hermes",
      start_date: "2026-03-02",
      teams: ["Core"],
    });
    const hermes = created.next.projects.find((p) => p.name === "Hermes")!;
    expect(hermes.teamInclusions).toEqual([{ teamId: IDS.team }]);
    expect(created.navigate).toBe(`/project/${hermes.id}`);

    const copied = call("copy_project", {
      project: "Apollo",
      name: "Apollo – plan B",
    });
    const copy = copied.next.projects.find(
      (p) => p.id === copied.result.project.id,
    )!;
    expect(copy.name).toBe("Apollo – plan B");
    expect(copy.epics.map((e) => e.name)).toEqual(["Login", "Billing"]);
  });

  it("include a team for a window, and clear it again", () => {
    const set = call("set_team_inclusion", {
      project: IDS.project,
      team: "Core",
      available_from: "2026-01-12",
      velocity: 0.9,
      epics: ["Login"],
    });
    expect(set.next.projects[0].teamInclusions).toEqual([
      {
        teamId: IDS.team,
        availableFrom: "2026-01-12",
        velocity: 0.9,
        epicIds: [IDS.epicLogin],
      },
    ]);
    const ctx = fixtureContext();
    ctx.state = set.next;
    const cleared = runTool(
      "set_team_inclusion",
      {
        project: IDS.project,
        team: "Core",
        clear: ["available_from", "epics"],
      },
      ctx,
      WRITE,
    ).result as Any;
    expect(cleared).toMatchObject({
      availableFrom: null,
      onlyEpics: [],
      velocity: 0.9,
    });
  });

  it("add a member with a speed, and a helper with days off", () => {
    const member = call("add_team_member", {
      team: "Core",
      name: "Dan Ruiz",
      specialization: "QA",
      speed: 1.2,
    });
    expect(member.next.teams[0].members[3]).toMatchObject({
      name: "Dan Ruiz",
      specialization: "QA",
      speed: 1.2,
    });
    const helper = call("add_helper", {
      project: IDS.project,
      name: "Contractor",
      specialization: "Backend",
      available_from: "2026-01-05",
      available_to: "2026-01-30",
      off_days: ["2026-01-15..2026-01-16"],
    });
    expect(helper.next.projects[0].helpers?.[0]).toMatchObject({
      name: "Contractor",
      speed: 1,
      offDays: ["2026-01-15", "2026-01-16"],
    });
  });

  it("set and clear a member's start on a project", () => {
    const set = call("set_member_start", {
      project: IDS.project,
      member: "Ben Osei",
      date: "2026-01-19",
    });
    expect(set.next.projects[0].memberStarts).toEqual({
      [IDS.ben]: "2026-01-19",
    });
    expect(
      fails("set_member_start", { project: IDS.project, member: IDS.ben }),
    ).toContain("either date, or clear");
  });
});

describe("view tools", () => {
  it("say what the window shows", () => {
    const { result } = call(
      "get_current_view",
      {},
      READ_ONLY,
      fixtureContext({ view: { path: `/tracking/${IDS.tracker}` } }),
    );
    expect(result).toMatchObject({
      page: "tracker",
      tracker: { id: IDS.tracker, name: "Apollo in Jira" },
    });
  });

  it("open projects, trackers and pages without changing data", () => {
    expect(
      call("open_project", { project: "Apollo" }, READ_ONLY),
    ).toMatchObject({
      actions: [],
      navigate: `/project/${IDS.project}`,
    });
    expect(
      call("open_tracker", { tracker: IDS.tracker }, READ_ONLY).navigate,
    ).toBe(`/tracking/${IDS.tracker}`);
    expect(call("open_page", { page: "team" }, READ_ONLY).navigate).toBe(
      "/team",
    );
  });

  it("select a tracker's teams with read access only, defaulting to the open one", () => {
    const ctx = fixtureContext({ view: { path: `/tracking/${IDS.tracker}` } });
    const out = runTool(
      "select_tracker_teams",
      { teams: ["core"] },
      ctx,
      READ_ONLY,
    );
    expect(out.actions).toEqual([
      { type: "setTrackerViewTeams", id: IDS.tracker, teamNames: ["Core"] },
    ]);
  });

  it("refuse a team the tracker doesn't have", () => {
    expect(
      fails("select_tracker_teams", { tracker: IDS.tracker, teams: ["Stars"] }),
    ).toContain('"Stars" is not a team');
  });

  it("switch the plan view of the open project", () => {
    const ctx = fixtureContext({ view: { path: `/project/${IDS.project}` } });
    const out = runTool("set_plan_view", { mode: "epic" }, ctx, READ_ONLY);
    expect(out.actions).toEqual([
      { type: "setPlanViewMode", projectId: IDS.project, mode: "epic" },
    ]);
  });
});

describe("expandDates", () => {
  it("expands ranges to weekdays, sorted and without repeats", () => {
    expect(
      expandDates(["2026-01-09..2026-01-12", "2026-01-09", "2026-01-03"]),
    ).toEqual(["2026-01-03", "2026-01-09", "2026-01-12"]);
  });

  it("refuses a range longer than a year", () => {
    expect(() => expandDates(["2026-01-01..2027-06-01"])).toThrow(ToolError);
  });
});

describe("@planner/mcp stays pure", () => {
  it("imports no React, DOM, Node built-ins or fetch outside its tests", () => {
    const dir = __dirname;
    const sources = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.includes(".test"),
    );
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/from "react"|from "node:|require\(/);
      expect(text, file).not.toMatch(
        /\bfetch\(|\b(window|document|globalThis)\.[A-Za-z_]/,
      );
      // Only the Action type, never the React store, from client-runtime.
      expect(text, file).not.toMatch(
        /import \{[^}]*\} from "@planner\/client-runtime"/,
      );
    }
  });
});
