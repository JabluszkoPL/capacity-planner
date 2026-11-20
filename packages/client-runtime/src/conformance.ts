/**
 * One test suite, run against every LocalStore implementation.
 *
 * The browser and the Mac app persist data in completely different ways, but a
 * divergence in how they merge would show up as two devices that quietly
 * disagree about the same project — the worst possible bug in a sync system and
 * the hardest to notice. So the merge contract is specified once, here, and
 * each implementation is required to satisfy it.
 */
import {
  Clock,
  ENTITY_KINDS,
  type Op,
  type StampedOp,
} from "@planner/contracts";
import { canonicalState, diffStates, snapshotOps } from "@planner/db";
import {
  seedState,
  type AppState,
  type JiraSnapshot,
  type TrackerSample,
} from "@planner/core";
import type { LocalStore } from "./localStore";

export type StoreFactory = () => Promise<LocalStore>;

const EMPTY: AppState = { projects: [], teams: [] };

/** Called with vitest's globals so this file stays framework-agnostic. */
export function describeLocalStoreContract(
  name: string,
  createStore: StoreFactory,
  api: {
    describe: (name: string, fn: () => void) => void;
    it: (name: string, fn: () => Promise<void> | void) => void;
    expect: typeof import("vitest").expect;
  },
): void {
  const { describe, it, expect } = api;

  const teamOp = (id: string, teamName: string, hlc: string): Op => ({
    entity: "team",
    id,
    hlc,
    deleted: false,
    data: { name: teamName, position: 0 },
  });

  const stamped = (op: Op, seq: number): StampedOp => ({ ...op, seq });

  const snapshot = (fetchedAt: string): JiraSnapshot => ({
    fetchedAt,
    initiative: {
      key: "ACME-1",
      summary: "Initiative",
      issueType: "Initiative",
      status: "In Progress",
      statusCategory: "indeterminate",
      updated: fetchedAt,
    },
    epics: [
      {
        key: "ACME-2",
        summary: "First epic",
        issueType: "Epic",
        status: "In Progress",
        statusCategory: "indeterminate",
        parentKey: "ACME-1",
        updated: fetchedAt,
        children: [
          {
            key: "ACME-3",
            summary: "A story",
            issueType: "Story",
            status: "Done",
            statusCategory: "done",
            parentKey: "ACME-2",
            originalEstimateSec: 28800,
            timeSpentSec: 28800,
            updated: fetchedAt,
          },
        ],
        totals: {
          originalSec: 28800,
          spentSec: 28800,
          remainingSec: 0,
          done: 1,
          all: 1,
        },
      },
    ],
    fieldIds: { startDate: "customfield_10015" },
  });

  const samples: TrackerSample[] = [
    {
      date: "2026-01-07",
      plannedDays: 4,
      earnedDays: 3,
      varianceDays: -1,
      bufferUsedDays: 1,
      bufferDays: 5,
      jiraSpentDays: 3,
      jiraRemainingDays: 12,
    },
  ];

  /** Only the fields a case cares about; the rest default the way the model
   *  says an absent field defaults. */
  const trackerOp = (
    id: string,
    hlc: string,
    extra: Record<string, unknown>,
  ): Op => ({
    entity: "tracker",
    id,
    hlc,
    deleted: false,
    data: {
      name: "Tracked initiative",
      initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
      initiativeKey: "ACME-1",
      baseUrl: "https://acme.atlassian.net",
      position: 0,
      ...extra,
    },
  });

  describe(`LocalStore contract: ${name}`, () => {
    it("starts empty", async () => {
      const store = await createStore();
      expect(await store.read()).toEqual(EMPTY);
      expect(await store.cursor()).toBe(0);
      expect(await store.pending()).toEqual([]);
      await store.close();
    });

    it("has a stable, non-empty device id", async () => {
      const store = await createStore();
      expect(store.deviceId).toBeTruthy();
      expect(store.deviceId).toBe(store.deviceId);
      await store.close();
    });

    it("round-trips a full seeded state", async () => {
      const store = await createStore();
      const clock = new Clock(store.deviceId);
      const state = seedState();
      await store.applyLocal(snapshotOps(state, clock));
      expect(await store.read()).toEqual(canonicalState(state));
      await store.close();
    });

    it("round-trips every schedule view mode", async () => {
      for (const mode of ["person", "task", "epic"] as const) {
        const store = await createStore();
        const clock = new Clock(store.deviceId);
        const seeded = seedState();
        const state = {
          ...seeded,
          projects: seeded.projects.map((p) => ({ ...p, planViewMode: mode })),
        };
        await store.applyLocal(snapshotOps(state, clock));
        const read = await store.read();
        expect(read.projects.map((p) => p.planViewMode)).toEqual(
          state.projects.map(() => mode),
        );
        await store.close();
      }
    });

    it("round-trips timeline markers and whether they are hidden", async () => {
      const store = await createStore();
      const clock = new Clock(store.deviceId);
      const seeded = seedState();
      const markers = [
        { id: "m1", name: "Alpha gate", date: "2026-03-02" },
        { id: "m2", name: "Beta gate", date: "2026-04-13" },
      ];
      const state = {
        ...seeded,
        projects: seeded.projects.map((p, i) =>
          i === 0 ? { ...p, markers, hideMarkers: true } : p,
        ),
      };
      await store.applyLocal(snapshotOps(state, clock));
      const read = await store.read();
      expect(read.projects[0].markers).toEqual(markers);
      expect(read.projects[0].hideMarkers).toBe(true);
      // A project without markers reads back without the fields at all.
      if (read.projects[1]) {
        expect(read.projects[1].markers).toBeUndefined();
        expect(read.projects[1].hideMarkers).toBeUndefined();
      }
      expect(read).toEqual(canonicalState(state));
      await store.close();
    });

    it("round-trips a team imported from Jira next to a hand-made one", async () => {
      const store = await createStore();
      const clock = new Clock(store.deviceId);
      const seeded = seedState();
      const state = {
        ...seeded,
        teams: [
          ...seeded.teams,
          {
            id: "jira-team",
            name: "Stars (Planner name)",
            jira: {
              baseUrl: "https://acme.atlassian.net",
              teamId: "a1b2c3",
              teamName: "Stars",
              syncedAt: "2026-11-10T09:00:00.000Z",
            },
            members: [
              {
                id: "jira-m1",
                name: "Ada Lovelace",
                specialization: "Backend",
                jiraAccountId: "acc-1",
              },
              { id: "jira-m2", name: "Added by hand", specialization: "QA" },
            ],
            offDays: { "jira-m1": ["2026-12-24"] },
          },
        ],
      };
      await store.applyLocal(snapshotOps(state, clock));
      const read = await store.read();
      expect(read).toEqual(canonicalState(state));
      const team = read.teams.find((t) => t.id === "jira-team");
      expect(team?.jira?.teamName).toBe("Stars");
      expect(team?.members[0].jiraAccountId).toBe("acc-1");
      expect("jiraAccountId" in (team?.members[1] ?? {})).toBe(false);
      expect("jira" in read.teams[0]).toBe(false);
      await store.close();
    });

    it("queues local edits in the outbox and clears them on ack", async () => {
      const store = await createStore();
      const clock = new Clock(store.deviceId);
      await store.applyLocal(diffStates(EMPTY, seedState(), clock));

      const queued = await store.pending();
      expect(queued.length).toBeGreaterThan(0);
      expect(queued.map((o) => o.seq)).toEqual(
        [...queued.map((o) => o.seq)].sort((a, b) => a - b),
      );

      const before = await store.read();
      await store.ackThrough(queued[queued.length - 1].seq);
      expect(await store.pending()).toEqual([]);
      expect(await store.read()).toEqual(before);
      await store.close();
    });

    it("acks only through the given seq", async () => {
      const store = await createStore();
      const clock = new Clock(store.deviceId);
      await store.applyLocal([teamOp("t1", "One", clock.tick())]);
      await store.applyLocal([teamOp("t2", "Two", clock.tick())]);
      const queued = await store.pending();
      expect(queued).toHaveLength(2);

      await store.ackThrough(queued[0].seq);
      const left = await store.pending();
      expect(left).toHaveLength(1);
      expect(left[0].id).toBe("t2");
      await store.close();
    });

    it("keeps only the newest queued op per row", async () => {
      const store = await createStore();
      const clock = new Clock(store.deviceId);
      await store.applyLocal([teamOp("t1", "First", clock.tick())]);
      await store.applyLocal([teamOp("t1", "Second", clock.tick())]);
      await store.applyLocal([teamOp("t1", "Third", clock.tick())]);

      const queued = await store.pending();
      expect(queued).toHaveLength(1);
      expect(queued[0].data).toMatchObject({ name: "Third" });
      // Compaction is about the queue, not the data.
      expect((await store.read()).teams[0].name).toBe("Third");
      await store.close();
    });

    it("an edit made during a push survives that push's ack", async () => {
      const store = await createStore();
      const clock = new Clock(store.deviceId);
      await store.applyLocal([teamOp("t1", "In flight", clock.tick())]);
      const inFlight = await store.pending();

      // The user edits the same row again before the ack arrives.
      await store.applyLocal([
        teamOp("t1", "Edited during push", clock.tick()),
      ]);
      await store.ackThrough(inFlight[inFlight.length - 1].seq);

      const left = await store.pending();
      expect(left).toHaveLength(1);
      expect(left[0].data).toMatchObject({ name: "Edited during push" });
      await store.close();
    });

    it("remote ops do not enter the outbox", async () => {
      const store = await createStore();
      const clock = new Clock("dev-remote");
      await store.applyRemote(
        [stamped(teamOp("t1", "Core", clock.tick()), 1)],
        1,
      );
      expect(await store.pending()).toEqual([]);
      expect((await store.read()).teams[0].name).toBe("Core");
      await store.close();
    });

    it("keeps the newer stamp and reports whether anything changed", async () => {
      const store = await createStore();
      const clock = new Clock("dev-remote");
      const older = clock.tick();
      const newer = clock.tick();

      expect(
        await store.applyRemote([stamped(teamOp("t1", "Newer", newer), 1)], 1),
      ).toBe(true);
      expect(
        await store.applyRemote([stamped(teamOp("t1", "Older", older), 2)], 2),
      ).toBe(false);
      expect((await store.read()).teams[0].name).toBe("Newer");
      await store.close();
    });

    it("replaying a known op is a no-op", async () => {
      const store = await createStore();
      const clock = new Clock("dev-remote");
      const op = stamped(teamOp("t1", "Core", clock.tick()), 1);
      expect(await store.applyRemote([op], 1)).toBe(true);
      expect(await store.applyRemote([op], 1)).toBe(false);
      expect((await store.read()).teams).toHaveLength(1);
      await store.close();
    });

    it("hides tombstoned rows and refuses stale resurrection", async () => {
      const store = await createStore();
      const clock = new Clock("dev-remote");
      const created = teamOp("t1", "Doomed", clock.tick());
      await store.applyRemote([stamped(created, 1)], 1);
      await store.applyRemote(
        [
          stamped(
            {
              entity: "team",
              id: "t1",
              hlc: clock.tick(),
              deleted: true,
              data: null,
            },
            2,
          ),
        ],
        2,
      );
      expect((await store.read()).teams).toHaveLength(0);

      expect(await store.applyRemote([stamped(created, 3)], 3)).toBe(false);
      expect((await store.read()).teams).toHaveLength(0);
      await store.close();
    });

    // A device that creates a row and deletes it before pushing queues only
    // the tombstone, so peers routinely see a delete for a row they never
    // had. The SQLite store used to throw on this for every kind with a
    // NOT NULL parent column (an epic's project, a task's epic, ...).
    it("accepts a remote tombstone for a row it never saw, of every kind", async () => {
      const store = await createStore();
      const clock = new Clock("dev-remote");
      const tombstones = ENTITY_KINDS.map((entity, i) =>
        stamped(
          {
            entity,
            id: `ghost-${entity}`,
            hlc: clock.tick(),
            deleted: true,
            data: null,
          },
          i + 1,
        ),
      );
      expect(await store.applyRemote(tombstones, tombstones.length)).toBe(true);
      expect(await store.read()).toEqual(EMPTY);
      expect(await store.cursor()).toBe(tombstones.length);

      // The tombstone still guards the id against a stale create.
      const staleTeam = teamOp(
        "ghost-team",
        "Zombie",
        "000000000001-0000-dev-z",
      );
      expect(await store.applyRemote([stamped(staleTeam, 99)], 99)).toBe(false);
      expect(await store.read()).toEqual(EMPTY);
      await store.close();
    });

    it("advances the cursor and can reset it", async () => {
      const store = await createStore();
      const clock = new Clock("dev-remote");
      await store.applyRemote(
        [stamped(teamOp("t1", "Core", clock.tick()), 7)],
        7,
      );
      expect(await store.cursor()).toBe(7);

      // A cursor never goes backwards on its own.
      await store.applyRemote([], 3);
      expect(await store.cursor()).toBe(7);

      await store.resetCursor();
      expect(await store.cursor()).toBe(0);
      // Resetting the cursor must not lose data.
      expect((await store.read()).teams).toHaveLength(1);
      await store.close();
    });

    it("converges regardless of the order two devices' edits arrive in", async () => {
      const a = new Clock("dev-a", () => 1000);
      const b = new Clock("dev-b", () => 1000);
      const opA = stamped(teamOp("t1", "From A", a.tick()), 1);
      const opB = stamped(teamOp("t1", "From B", b.tick()), 2);

      const one = await createStore();
      const two = await createStore();
      await one.applyRemote([opA], 1);
      await one.applyRemote([opB], 2);
      await two.applyRemote([opB], 2);
      await two.applyRemote([opA], 1);

      expect(await one.read()).toEqual(await two.read());
      await one.close();
      await two.close();
    });

    it("applies an edit made while offline on top of newer remote state", async () => {
      const store = await createStore();
      const remote = new Clock("dev-remote", () => 1000);
      await store.applyRemote(
        [stamped(teamOp("t1", "Server name", remote.tick()), 1)],
        1,
      );

      // This device edits later in wall-clock terms, so it must win.
      const local = new Clock(store.deviceId, () => 2000);
      await store.applyLocal([teamOp("t1", "My name", local.tick())]);
      expect((await store.read()).teams[0].name).toBe("My name");

      // ...and the stale server copy arriving afterwards must not clobber it.
      await store.applyRemote(
        [stamped(teamOp("t1", "Server name", remote.tick()), 2)],
        2,
      );
      expect((await store.read()).teams[0].name).toBe("My name");
      await store.close();
    });

    it("stores a tracker with its snapshot and samples intact", async () => {
      const store = await createStore();
      const clock = new Clock(store.deviceId);
      const snap = snapshot("2026-01-08T10:00:00.000Z");
      await store.applyLocal([
        trackerOp("tr1", clock.tick(), {
          projectId: "p1",
          hoursPerDay: 6,
          epicMap: { "ACME-2": "epic-1", "ACME-9": null },
          snapshot: snap,
          samples,
          deadlines: { devEndDate: "2026-03-13", endPhase: ["QA"] },
          taskMap: { "ACME-31": null },
          addedScope: { "ACME-31": "QA" },
          untrackedEpics: ["ACME-40"],
          niceToHaveEpics: ["ACME-50"],
          viewTeams: ["team-stars"],
          taskTeams: { "ACME-31": "team-bulls" },
        }),
      ]);

      const [tracker] = (await store.read()).trackers ?? [];
      expect(tracker).toMatchObject({
        id: "tr1",
        projectId: "p1",
        hoursPerDay: 6,
        epicMap: { "ACME-2": "epic-1", "ACME-9": null },
        samples,
        deadlines: { devEndDate: "2026-03-13", endPhase: ["QA"] },
        taskMap: { "ACME-31": null },
        addedScope: { "ACME-31": "QA" },
        untrackedEpics: ["ACME-40"],
        niceToHaveEpics: ["ACME-50"],
        viewTeams: ["team-stars"],
        taskTeams: { "ACME-31": "team-bulls" },
      });
      // Deep, not shallow: the snapshot is nested JSON and is the thing most
      // likely to be flattened by a lossy round trip.
      expect(tracker.snapshot).toEqual(snap);
      await store.close();
    });

    it("resolves two devices editing one tracker by whole row, not by field", async () => {
      // A refresh on one device and a mapping change on the other. Merging them
      // field by field would invent a state neither device ever saw, so the
      // later stamp takes the row and the earlier edit is lost — visibly, the
      // way a single user expects their last action to be what stuck.
      const a = new Clock("dev-a", () => 1000);
      const b = new Clock("dev-b", () => 2000);
      const mapped = stamped(
        trackerOp("tr1", a.tick(), { epicMap: { "ACME-2": "epic-1" } }),
        1,
      );
      const refreshed = stamped(
        trackerOp("tr1", b.tick(), {
          snapshot: snapshot("2026-01-09T10:00:00.000Z"),
        }),
        2,
      );

      const one = await createStore();
      const two = await createStore();
      await one.applyRemote([mapped], 1);
      await one.applyRemote([refreshed], 2);
      // Same two ops, opposite order: convergence is the whole point.
      await two.applyRemote([refreshed], 2);
      await two.applyRemote([mapped], 1);

      const winner = (await one.read()).trackers?.[0];
      expect(winner?.snapshot?.fetchedAt).toBe("2026-01-09T10:00:00.000Z");
      expect(winner?.epicMap).toBeUndefined();
      expect(await two.read()).toEqual(await one.read());
      await one.close();
      await two.close();
    });

    it("tombstones a deleted tracker and refuses a stale re-create", async () => {
      const store = await createStore();
      const clock = new Clock("dev-remote");
      const created = trackerOp("tr1", clock.tick(), {
        snapshot: snapshot("2026-01-08T10:00:00.000Z"),
      });
      await store.applyRemote([stamped(created, 1)], 1);
      expect((await store.read()).trackers).toHaveLength(1);

      await store.applyRemote(
        [
          stamped(
            {
              entity: "tracker",
              id: "tr1",
              hlc: clock.tick(),
              deleted: true,
              data: null,
            },
            2,
          ),
        ],
        2,
      );
      expect((await store.read()).trackers).toBeUndefined();

      expect(await store.applyRemote([stamped(created, 3)], 3)).toBe(false);
      expect((await store.read()).trackers).toBeUndefined();
      await store.close();
    });
  });
}
