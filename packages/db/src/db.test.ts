import { describe, it, expect, beforeEach } from "vitest";
import { Clock, type Op } from "@planner/contracts";
import {
  runPlan,
  seedState,
  type AppState,
  type JiraEpic,
  type JiraIssue,
  type Tracker,
} from "@planner/core";
import { openNodeDatabase } from "./node";
import {
  migrate,
  MIGRATIONS,
  SCHEMA_VERSION,
  getMeta,
  setMeta,
} from "./schema";
import {
  applyLocalOp,
  applyRemoteOp,
  clearPending,
  headSeq,
  pendingOps,
  readAppState,
  readOpsSince,
} from "./apply";
import { canonicalState, diffStates, flattenState, snapshotOps } from "./diff";
import type { SqliteDriver } from "./driver";

function freshDb(): SqliteDriver {
  const db = openNodeDatabase(":memory:");
  migrate(db);
  return db;
}

function userVersion(d: SqliteDriver): number {
  return Number(
    d.get<{ user_version: number }>("PRAGMA user_version;")?.user_version ?? 0,
  );
}

function tableNames(d: SqliteDriver): string[] {
  return d
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )
    .map((r) => r.name);
}

const issue = (key: string, parentKey: string): JiraIssue => ({
  key,
  summary: `Work item ${key} with a summary long enough to weigh something`,
  issueType: "Story",
  status: "In Progress",
  statusCategory: "indeterminate",
  assignee: { accountId: `acc-${key}`, displayName: "Dana Developer" },
  parentKey,
  originalEstimateSec: 28800,
  remainingEstimateSec: 14400,
  timeSpentSec: 14400,
  startDate: "2026-01-05",
  dueDate: "2026-01-09",
  sprint: "Sprint 12",
  updated: "2026-01-08T09:30:00.000Z",
});

/** A tracker the size a real initiative produces — the snapshot is by far the
 *  largest thing the database stores, so the round-trip is tested at scale. */
function bigTracker(id = "tr1"): Tracker {
  const epics: JiraEpic[] = Array.from({ length: 40 }, (_, e) => {
    const key = `ACME-${100 + e}`;
    const children = Array.from({ length: 30 }, (_, c) =>
      issue(`ACME-${1000 + e * 30 + c}`, key),
    );
    return {
      ...issue(key, "ACME-1"),
      key,
      issueType: "Epic",
      children,
      totals: {
        originalSec: 28800 * children.length,
        spentSec: 14400 * children.length,
        remainingSec: 14400 * children.length,
        done: 0,
        all: children.length,
      },
    };
  });

  return {
    id,
    name: "Big Bang",
    initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
    initiativeKey: "ACME-1",
    baseUrl: "https://acme.atlassian.net",
    hoursPerDay: 6,
    epicMap: Object.fromEntries(
      epics.map((e, i) => [e.key, i % 3 === 0 ? null : `epic-${i}`]),
    ),
    taskMap: Object.fromEntries(
      epics.flatMap((e, i) =>
        e.children.map((child, c) => [
          child.key,
          c % 5 === 0 ? null : `task-${i}-${c}`,
        ]),
      ),
    ),
    snapshot: {
      fetchedAt: "2026-01-08T10:00:00.000Z",
      initiative: issue("ACME-1", ""),
      epics,
      fieldIds: { startDate: "customfield_10015", sprint: "customfield_10020" },
    },
    samples: Array.from({ length: 60 }, (_, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      plannedDays: i,
      earnedDays: i - 1,
      varianceDays: -1,
      bufferUsedDays: 1,
      bufferDays: 10,
      jiraSpentDays: i * 2,
      jiraRemainingDays: 100 - i,
    })),
    sprintDraft: {
      start: "2026-01-12",
      end: "2026-01-23",
      items: [
        { issueKey: "ACME-1000", estimateDays: 2, start: "2026-01-12" },
        {
          issueKey: "ACME-1001",
          memberId: "m1",
          estimateDays: 3,
          start: "2026-01-14",
          applied: {
            at: "2026-01-12T08:00:00.000Z",
            startDate: "2026-01-14",
            dueDate: "2026-01-16",
          },
        },
      ],
    },
  };
}

/** Land a whole AppState into an empty database. */
function seedInto(db: SqliteDriver, state: AppState, clock: Clock): void {
  db.transaction(() => {
    for (const op of snapshotOps(state, clock)) applyRemoteOp(db, op);
  });
}

let db: SqliteDriver;
let clock: Clock;

beforeEach(() => {
  db = freshDb();
  clock = new Clock("dev-a");
});

describe("migrate", () => {
  it("brings a blank database to the current version", () => {
    const fresh = openNodeDatabase(":memory:");
    expect(migrate(fresh)).toBe(SCHEMA_VERSION);
  });

  it("is idempotent", () => {
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
  });

  it("round-trips sync metadata", () => {
    expect(getMeta(db, "device_id")).toBeNull();
    setMeta(db, "device_id", "dev-a");
    setMeta(db, "device_id", "dev-b");
    expect(getMeta(db, "device_id")).toBe("dev-b");
  });

  it("creates every table on a blank database", () => {
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(["teams", "trackers"]),
    );
  });

  it("upgrades a V1 database without touching the rows it already holds", () => {
    // Exactly what a device that has not opened the app since the first
    // release carries: V1's statements and nothing else.
    const legacy = openNodeDatabase(":memory:");
    legacy.exec(MIGRATIONS[0].up);
    legacy.exec("PRAGMA user_version = 1;");
    legacy.run(
      `INSERT INTO teams (id, name, position, hlc, deleted, dirty)
       VALUES (?, ?, 0, ?, 0, 0)`,
      ["t1", "Core", "0000000003e8-0000-dev-a"],
    );
    expect(tableNames(legacy)).not.toContain("trackers");

    expect(migrate(legacy)).toBe(SCHEMA_VERSION);
    expect(userVersion(legacy)).toBe(SCHEMA_VERSION);
    expect(tableNames(legacy)).toContain("trackers");
    expect(legacy.all("SELECT * FROM trackers")).toEqual([]);
    // The pre-existing row survives the upgrade untouched.
    expect(readAppState(legacy).teams).toEqual([
      { id: "t1", name: "Core", members: [], offDays: {} },
    ]);
  });

  it("adds an empty task map to existing V2 trackers", () => {
    const legacy = openNodeDatabase(":memory:");
    legacy.exec(MIGRATIONS[0].up);
    legacy.exec(MIGRATIONS[1].up);
    legacy.exec("PRAGMA user_version = 2;");
    legacy.run(
      `INSERT INTO trackers
       (id, name, initiative_url, initiative_key, base_url, position, hlc)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [
        "tr1",
        "Legacy",
        "https://acme.atlassian.net/browse/ACME-1",
        "ACME-1",
        "https://acme.atlassian.net",
        "0000000003e8-0000-dev-a",
      ],
    );

    expect(migrate(legacy)).toBe(SCHEMA_VERSION);
    expect(
      legacy.get<{ task_map: string }>(
        "SELECT task_map FROM trackers WHERE id = ?",
        ["tr1"],
      )?.task_map,
    ).toBe("{}");
    expect(readAppState(legacy).trackers?.[0].taskMap).toBeUndefined();
  });

  it("gives existing V3 trackers no deadlines, so they read as before", () => {
    const legacy = openNodeDatabase(":memory:");
    for (const m of MIGRATIONS.slice(0, 3)) legacy.exec(m.up);
    legacy.exec("PRAGMA user_version = 3;");
    legacy.run(
      `INSERT INTO trackers
       (id, name, initiative_url, initiative_key, base_url, position, hlc)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [
        "tr1",
        "Legacy",
        "",
        "ACME-1",
        "https://acme.atlassian.net",
        "0000000003e8-0000-dev-a",
      ],
    );

    expect(migrate(legacy)).toBe(SCHEMA_VERSION);
    expect(
      legacy.get<{ deadlines: string | null }>(
        "SELECT deadlines FROM trackers WHERE id = ?",
        ["tr1"],
      )?.deadlines,
    ).toBeNull();
    expect(readAppState(legacy).trackers?.[0]).not.toHaveProperty("deadlines");
  });
});

describe("AppState round-trip", () => {
  it("reads back a seeded state byte-for-byte", () => {
    const state = seedState();
    seedInto(db, state, clock);
    expect(readAppState(db)).toEqual(canonicalState(state));
  });

  it("survives a state carrying a generated plan", () => {
    const state = seedState();
    const project = state.projects[0];
    project.plan = runPlan(project, state.teams);
    expect(project.plan.assignments.length).toBeGreaterThan(0);

    seedInto(db, state, clock);
    expect(readAppState(db)).toEqual(canonicalState(state));
  });

  it("preserves ordering of projects, epics and tasks", () => {
    const state = seedState();
    const epic = state.projects[0].epics[0];
    epic.tasks.reverse();
    seedInto(db, state, clock);
    expect(
      readAppState(db).projects[0].epics[0].tasks.map((t) => t.name),
    ).toEqual(epic.tasks.map((t) => t.name));
  });

  it("keeps an empty state empty", () => {
    expect(readAppState(db)).toEqual({ projects: [], teams: [] });
  });
});

describe("last-write-wins merge", () => {
  const teamOp = (hlc: string, name: string): Op => ({
    entity: "team",
    id: "t1",
    hlc,
    deleted: false,
    data: { name, position: 0 },
  });

  it("accepts a newer stamp and rejects an older one", () => {
    const first = clock.tick();
    const second = clock.tick();
    expect(applyRemoteOp(db, teamOp(second, "Later"))).toBe(true);
    expect(applyRemoteOp(db, teamOp(first, "Earlier"))).toBe(false);
    expect(readAppState(db).teams[0].name).toBe("Later");
  });

  it("is idempotent — replaying the same op changes nothing", () => {
    const op = teamOp(clock.tick(), "Once");
    expect(applyRemoteOp(db, op)).toBe(true);
    expect(applyRemoteOp(db, op)).toBe(false);
    expect(readAppState(db).teams).toHaveLength(1);
  });

  it("resolves a same-millisecond conflict by device id, identically on both peers", () => {
    const a = new Clock("dev-a", () => 1000);
    const b = new Clock("dev-b", () => 1000);
    const opA = teamOp(a.tick(), "From A");
    const opB = teamOp(b.tick(), "From B");

    // Peer 1 sees A then B; peer 2 sees B then A. Both must land on the same name.
    const db2 = freshDb();
    applyRemoteOp(db, opA);
    applyRemoteOp(db, opB);
    applyRemoteOp(db2, opB);
    applyRemoteOp(db2, opA);
    expect(readAppState(db).teams[0].name).toBe(
      readAppState(db2).teams[0].name,
    );
  });

  it("hides a tombstoned row but still remembers it", () => {
    applyRemoteOp(db, teamOp(clock.tick(), "Doomed"));
    applyRemoteOp(db, {
      entity: "team",
      id: "t1",
      hlc: clock.tick(),
      deleted: true,
      data: null,
    });
    expect(readAppState(db).teams).toHaveLength(0);
    // A stale re-create must not resurrect it.
    expect(applyRemoteOp(db, teamOp("000000000001-0000-dev-z", "Zombie"))).toBe(
      false,
    );
    expect(readAppState(db).teams).toHaveLength(0);
  });

  it("accepts a tombstone for a row it has never seen", () => {
    expect(
      applyRemoteOp(db, {
        entity: "team",
        id: "never-seen",
        hlc: clock.tick(),
        deleted: true,
        data: null,
      }),
    ).toBe(true);
    expect(readAppState(db).teams).toHaveLength(0);
  });
});

describe("outbox", () => {
  it("queues local edits and drops them once acked", () => {
    const state = seedState();
    for (const op of diffStates({ projects: [], teams: [] }, state, clock)) {
      applyLocalOp(db, op);
    }
    const queued = pendingOps(db);
    expect(queued.length).toBeGreaterThan(0);
    expect(headSeq(db)).toBe(queued[queued.length - 1].seq);

    clearPending(db, headSeq(db));
    expect(pendingOps(db)).toHaveLength(0);
    // Clearing the outbox must not touch the data itself.
    expect(readAppState(db)).toEqual(canonicalState(state));
  });

  it("remote ops do not enter the outbox", () => {
    seedInto(db, seedState(), clock);
    expect(pendingOps(db)).toHaveLength(0);
  });

  it("readOpsSince pages from a cursor", () => {
    for (const op of snapshotOps(seedState(), clock)) applyLocalOp(db, op);
    const all = readOpsSince(db, 0, 1000);
    const firstTwo = readOpsSince(db, 0, 2);
    expect(firstTwo).toHaveLength(2);
    expect(readOpsSince(db, firstTwo[1].seq, 1000)).toEqual(all.slice(2));
  });
});

describe("diffStates", () => {
  it("emits nothing for an unchanged state", () => {
    const state = seedState();
    expect(diffStates(state, structuredClone(state), clock)).toEqual([]);
  });

  it("emits one op for one renamed task", () => {
    const before = seedState();
    const after = structuredClone(before);
    after.projects[0].epics[0].tasks[0].name = "Renamed";

    const ops = diffStates(before, after, clock);
    expect(ops).toHaveLength(1);
    expect(ops[0].entity).toBe("task");
    expect(ops[0].data).toMatchObject({ name: "Renamed" });
  });

  it("emits a tombstone when a task is removed", () => {
    const before = seedState();
    const after = structuredClone(before);
    const removed = after.projects[0].epics[0].tasks.shift()!;

    const ops = diffStates(before, after, clock);
    const tomb = ops.find((o) => o.deleted);
    expect(tomb).toMatchObject({ entity: "task", id: removed.id, data: null });
    // Tombstones come last so no peer sees an orphan mid-batch.
    expect(ops.indexOf(tomb!)).toBe(ops.length - 1);
  });

  it("notices reordering, because position is part of the row", () => {
    const before = seedState();
    const after = structuredClone(before);
    after.projects[0].epics.reverse();
    const ops = diffStates(before, after, clock);
    expect(ops.every((o) => o.entity === "epic")).toBe(true);
    expect(ops.length).toBe(before.projects[0].epics.length);
  });

  it("applying a diff reproduces the target state exactly", () => {
    const before = seedState();
    seedInto(db, before, clock);

    const after = structuredClone(before);
    after.projects[0].name = "Renamed Project";
    after.projects[0].epics[0].tasks.pop();
    after.teams[0].members.push({
      id: "m-new",
      name: "New Person",
      specialization: "QA",
    });
    after.projects[0].plan = runPlan(after.projects[0], after.teams);

    for (const op of diffStates(before, after, clock)) applyRemoteOp(db, op);
    expect(readAppState(db)).toEqual(canonicalState(after));
  });

  it("covers every row of the state", () => {
    const state = seedState();
    const kinds = new Set(
      [...flattenState(state).values()].map((e) => e.entity),
    );
    expect(kinds).toContain("project");
    expect(kinds).toContain("epic");
    expect(kinds).toContain("task");
    expect(kinds).toContain("team");
    expect(kinds).toContain("member");
    expect(kinds).toContain("plan");
  });
});

describe("trackers", () => {
  it("round-trips a tracker with a large snapshot", () => {
    const state: AppState = { ...seedState(), trackers: [bigTracker()] };
    // Not an arbitrary fixture: the snapshot is the column that decides whether
    // JSON-on-the-row was a sane choice.
    expect(JSON.stringify(state.trackers![0].snapshot).length).toBeGreaterThan(
      300_000,
    );

    for (const op of diffStates({ projects: [], teams: [] }, state, clock)) {
      applyLocalOp(db, op);
    }
    expect(readAppState(db)).toEqual(canonicalState(state));
    expect(readAppState(db).trackers).toEqual(state.trackers);
  });

  it("round-trips a tracker's deadlines", () => {
    const tracker = {
      ...bigTracker(),
      deadlines: {
        endDate: "2027-01-29",
        devEndDate: "2027-01-15",
        endPhase: ["QA"],
      },
    };
    const state: AppState = { ...seedState(), trackers: [tracker] };
    for (const op of diffStates({ projects: [], teams: [] }, state, clock)) {
      applyLocalOp(db, op);
    }
    expect(readAppState(db).trackers?.[0].deadlines).toEqual(tracker.deadlines);
  });

  it("keeps trackers in position order", () => {
    const state: AppState = {
      projects: [],
      teams: [],
      trackers: [bigTracker("b"), bigTracker("a"), bigTracker("c")],
    };
    seedInto(db, state, clock);
    expect(readAppState(db).trackers?.map((t) => t.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("treats an absent tracker list and an empty one as the same state", () => {
    const withNone: AppState = { projects: [], teams: [] };
    const withEmpty: AppState = { projects: [], teams: [], trackers: [] };
    expect(canonicalState(withEmpty)).toEqual(canonicalState(withNone));
    expect(diffStates(withNone, withEmpty, clock)).toEqual([]);
  });

  it("treats empty maps and samples as absent", () => {
    const bare: Tracker = {
      id: "tr1",
      name: "Fresh",
      initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
      initiativeKey: "ACME-1",
      baseUrl: "https://acme.atlassian.net",
    };
    const filled: AppState = {
      projects: [],
      teams: [],
      trackers: [{ ...bare, epicMap: {}, taskMap: {}, samples: [] }],
    };
    const state: AppState = { projects: [], teams: [], trackers: [bare] };

    seedInto(db, state, clock);
    expect(readAppState(db).trackers).toEqual([bare]);
    expect(canonicalState(filled)).toEqual(canonicalState(state));
    expect(diffStates(state, filled, clock)).toEqual([]);
  });

  it("clears a snapshot back to absent rather than to null", () => {
    const before: AppState = {
      projects: [],
      teams: [],
      trackers: [bigTracker()],
    };
    seedInto(db, before, clock);

    const after = structuredClone(before);
    delete after.trackers![0].snapshot;
    delete after.trackers![0].sprintDraft;
    for (const op of diffStates(before, after, clock)) applyRemoteOp(db, op);

    const read = readAppState(db).trackers![0];
    expect("snapshot" in read).toBe(false);
    expect("sprintDraft" in read).toBe(false);
    expect(readAppState(db)).toEqual(canonicalState(after));
  });

  it("emits one op for a tracker edit and a tombstone for a removal", () => {
    const before: AppState = {
      projects: [],
      teams: [],
      trackers: [bigTracker("tr1"), bigTracker("tr2")],
    };
    const after = structuredClone(before);
    after.trackers![0].name = "Renamed";
    after.trackers!.pop();

    const ops = diffStates(before, after, clock);
    expect(ops.filter((o) => !o.deleted)).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: "tracker", id: "tr1" });
    expect(ops[ops.length - 1]).toMatchObject({
      entity: "tracker",
      id: "tr2",
      deleted: true,
      data: null,
    });
  });
});
