/**
 * One refresh, end to end, against a fake Jira.
 *
 * This is the closest thing to an integration test the feature has: the real
 * `fetchInitiativeSnapshot` walks the real JQL candidates and the real mappers,
 * and the result is fed through the real `trackerStatus`. Only the socket is
 * fake. A break anywhere along that path shows up here rather than on a real
 * board.
 */
import { describe, it, expect } from "vitest";
import type { AppState, Project, Tracker, Team } from "@planner/core";
import { runPlan } from "@planner/core";
import type { JiraRequest, JiraResponse, JiraTransport } from "@planner/jira";
import { refreshTracker, snapshotAgeDays } from "./refreshTracker";
import { JiraUnavailableError } from "./jiraTransport";
import type { JiraSettings } from "./jiraSettings";

const SITE = "https://acme.atlassian.net";

const settings: JiraSettings = {
  baseUrl: SITE,
  email: "sam@example.com",
  apiToken: "token",
  hoursPerDay: 8,
  allowWrites: false,
};

/* ------------------------------- fake Jira -------------------------------- */

const FIELD_LIST = [
  { id: "customfield_10015", name: "Start date", schema: { type: "date" } },
  { id: "customfield_10020", name: "Sprint", schema: { type: "array" } },
];

function issue(
  key: string,
  summary: string,
  type: string,
  category: "new" | "indeterminate" | "done",
  extra: Record<string, unknown> = {},
) {
  return {
    key,
    id: key,
    fields: {
      summary,
      issuetype: { name: type },
      status: {
        name: category === "done" ? "Done" : "In Progress",
        statusCategory: { key: category },
      },
      updated: "2026-09-13T09:00:00.000Z",
      ...extra,
    },
  };
}

/** Hours as Jira stores them: seconds. */
const h = (n: number) => n * 3600;

interface FakeOptions {
  /** Status to answer with instead of 200, for the failure cases. */
  failWith?: number;
  onRequest?: (req: JiraRequest) => void;
}

function fakeJira(opts: FakeOptions = {}): JiraTransport {
  return {
    canWrite: false,
    request(req: JiraRequest): Promise<JiraResponse> {
      opts.onRequest?.(req);
      if (opts.failWith) {
        return Promise.resolve({
          status: opts.failWith,
          body: { errorMessages: ["nope"] },
        });
      }
      if (req.path.startsWith("/rest/api/3/field")) {
        return Promise.resolve({ status: 200, body: FIELD_LIST });
      }
      if (req.path.startsWith("/rest/api/3/issue/ACME-1")) {
        return Promise.resolve({
          status: 200,
          body: issue("ACME-1", "Season 4", "Initiative", "indeterminate"),
        });
      }
      if (req.path.startsWith("/rest/api/3/search/jql")) {
        const jql = String(
          (req.body as Record<string, unknown> | undefined)?.jql ?? "",
        );
        // The epics query: only `parent =` finds anything on this site.
        if (jql.includes("parent = ACME-1")) {
          return Promise.resolve({
            status: 200,
            body: {
              issues: [
                issue("ACME-10", "Meta loop", "Epic", "indeterminate"),
                issue("ACME-20", "Shop rework", "Epic", "new"),
              ],
            },
          });
        }
        // The epic-children query names the epics, never the initiative.
        const isChildrenQuery = jql.includes("ACME-10");
        if (!isChildrenQuery) {
          // "Parent Link" / linkedIssues candidates find nothing on this site.
          return Promise.resolve({ status: 200, body: { issues: [] } });
        }
        return Promise.resolve({
          status: 200,
          body: {
            issues: [
              issue("ACME-11", "Quest board", "Story", "done", {
                parent: { key: "ACME-10" },
                timeoriginalestimate: h(24),
                timespent: h(24),
                timeestimate: 0,
              }),
              issue("ACME-12", "Quest rewards", "Story", "indeterminate", {
                parent: { key: "ACME-10" },
                timeoriginalestimate: h(24),
                timespent: h(8),
                timeestimate: h(16),
              }),
              issue("ACME-21", "Shop grid", "Story", "new", {
                parent: { key: "ACME-20" },
                timeoriginalestimate: h(16),
                timeestimate: h(16),
              }),
            ],
          },
        });
      }
      return Promise.resolve({ status: 404, body: {} });
    },
  };
}

/* -------------------------------- fixtures -------------------------------- */

function project(): Project {
  const p: Project = {
    id: "p1",
    name: "Season 4",
    startDate: "2026-09-07", // a Monday
    buffer: 20,
    planViewMode: "person",
    plan: null,
    epics: [
      {
        id: "e-meta",
        name: "Meta loop",
        tasks: [
          {
            id: "t1",
            name: "Quest board",
            estimateDays: 3,
            specialization: "dev",
            excluded: false,
          },
          {
            id: "t2",
            name: "Quest rewards",
            estimateDays: 3,
            specialization: "dev",
            excluded: false,
          },
        ],
      },
      {
        id: "e-shop",
        name: "Shop rework",
        tasks: [
          {
            id: "t3",
            name: "Shop grid",
            estimateDays: 2,
            specialization: "dev",
            excluded: false,
          },
        ],
      },
    ],
  };
  return p;
}

const teams: Team[] = [
  {
    id: "team1",
    name: "Core",
    members: [{ id: "m1", name: "Ada", specialization: "dev" }],
    offDays: {},
  },
];

function stateWith(p: Project): AppState {
  return { projects: [{ ...p, plan: runPlan(p, teams) }], teams };
}

function tracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: "tr1",
    name: "Season 4",
    initiativeUrl: `${SITE}/browse/ACME-1`,
    initiativeKey: "ACME-1",
    baseUrl: SITE,
    ...overrides,
  };
}

const NOW = "2026-09-21T10:00:00.000Z";
const TODAY = "2026-09-21";

/* --------------------------------- tests ---------------------------------- */

describe("refreshTracker", () => {
  it("builds a snapshot with epic totals computed from the children", async () => {
    const result = await refreshTracker({
      tracker: tracker(),
      settings,
      transport: fakeJira(),
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { snapshot } = result;
    expect(snapshot.initiative.key).toBe("ACME-1");
    expect(snapshot.epics.map((e) => e.key)).toEqual(["ACME-10", "ACME-20"]);

    const meta = snapshot.epics[0];
    expect(meta.totals.all).toBe(2);
    expect(meta.totals.done).toBe(1);
    expect(meta.totals.spentSec).toBe(h(32));
    // The done child contributes no remaining, whatever its own field says.
    expect(meta.totals.remainingSec).toBe(h(16));
  });

  it("produces no sample when the tracker has no baseline", async () => {
    const result = await refreshTracker({
      tracker: tracker(),
      settings,
      transport: fakeJira(),
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result.ok && result.sample).toBeNull();
  });

  it("produces a sample once a baseline and an epic map exist", async () => {
    const p = project();
    const result = await refreshTracker({
      tracker: tracker({
        projectId: "p1",
        epicMap: { "ACME-10": "e-meta", "ACME-20": "e-shop" },
      }),
      settings,
      transport: fakeJira(),
      state: stateWith(p),
      today: TODAY,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.sample) throw new Error("expected a sample");
    expect(result.taskMap).toMatchObject({
      "ACME-11": "t1",
      "ACME-12": "t2",
      "ACME-21": "t3",
    });
    const sample = result.sample;
    expect(sample.date).toBe(TODAY);
    // Quest board is Done (3 plan days); open tasks earn nothing even when
    // time has been logged. Jira epic grouping is irrelevant.
    expect(sample.earnedDays).toBeCloseTo(3, 5);
    // 16h left on Meta + 16h on Shop = 32h = 4 days at 8h/day.
    expect(sample.jiraRemainingDays).toBeCloseTo(4, 5);
    // The plan has 8 raw days in total, so 4 are still to come.
    expect(sample.plannedDays).toBeGreaterThan(0);
  });

  it("falls through to the next JQL candidate rather than giving up", async () => {
    const seen: string[] = [];
    const result = await refreshTracker({
      tracker: tracker(),
      settings,
      transport: fakeJira({
        onRequest: (req) => {
          const jql = (req.body as Record<string, unknown> | undefined)?.jql;
          if (typeof jql === "string") seen.push(jql);
        },
      }),
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    // The first candidate is the one that works here, so it is tried first and
    // the others are never needed.
    expect(seen[0]).toContain("parent = ACME-1");
  });

  it("refuses before any request when Jira is not configured", async () => {
    let called = false;
    const result = await refreshTracker({
      tracker: tracker(),
      settings: { ...settings, apiToken: "" },
      transport: fakeJira({
        onRequest: () => {
          called = true;
        },
      }),
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, kind: "not-configured" });
    expect(called).toBe(false);
  });

  it("reports a rejected token as an auth failure", async () => {
    const result = await refreshTracker({
      tracker: tracker(),
      settings,
      transport: fakeJira({ failWith: 401 }),
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, kind: "auth" });
    if (!result.ok) expect(result.message).toMatch(/rejected/i);
  });

  it("names field metadata when that request returns 403", async () => {
    const result = await refreshTracker({
      tracker: tracker(),
      settings,
      transport: fakeJira({ failWith: 403 }),
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, kind: "auth" });
    if (!result.ok) {
      expect(result.message).toMatch(/field metadata/i);
      expect(result.message).not.toMatch(/rejected your email and token/i);
    }
  });

  it("only suggests project permission when the issue request returns 403", async () => {
    const transport = fakeJira({
      onRequest: () => {},
    });
    const request = transport.request.bind(transport);
    transport.request = async (req) =>
      req.path.startsWith("/rest/api/3/issue/")
        ? { status: 403, body: null }
        : request(req);

    const result = await refreshTracker({
      tracker: tracker(),
      settings,
      transport,
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, kind: "auth" });
    if (!result.ok) expect(result.message).toMatch(/browse this project/i);
  });

  it("reports a missing initiative as not-found, naming the key", async () => {
    const result = await refreshTracker({
      tracker: tracker(),
      settings,
      transport: fakeJira({ failWith: 404 }),
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, kind: "not-found" });
    if (!result.ok) expect(result.message).toContain("ACME-1");
  });

  it("explains that a plain browser cannot reach Jira at all", async () => {
    const transport: JiraTransport = {
      canWrite: false,
      request: () =>
        Promise.reject(new JiraUnavailableError("needs the Mac app")),
    };
    const result = await refreshTracker({
      tracker: tracker(),
      settings,
      transport,
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
    if (!result.ok) expect(result.message).toBe("needs the Mac app");
  });

  it("never leaks the token into a failure message", async () => {
    const result = await refreshTracker({
      tracker: tracker(),
      settings: { ...settings, apiToken: "super-secret-token" },
      transport: fakeJira({ failWith: 500 }),
      state: { projects: [], teams: [] },
      today: TODAY,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("super-secret-token");
  });
});

describe("snapshotAgeDays", () => {
  it("is null before the first refresh", () => {
    expect(snapshotAgeDays(tracker(), NOW)).toBeNull();
  });

  it("counts whole days since the snapshot", () => {
    const withSnapshot = tracker({
      snapshot: {
        fetchedAt: "2026-09-18T10:00:00.000Z",
        initiative: {
          key: "ACME-1",
          summary: "x",
          issueType: "Initiative",
          status: "In Progress",
          statusCategory: "indeterminate",
          updated: NOW,
        },
        epics: [],
        fieldIds: {},
      },
    });
    expect(snapshotAgeDays(withSnapshot, NOW)).toBe(3);
  });
});
