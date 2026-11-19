/**
 * The whole loop, end to end: two independent clients, each with its own local
 * store, talking to a real Hub over in-process sockets. No mocks of the merge
 * logic, the protocol, or the server — only the transport is shortened.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Clock } from "@planner/contracts";
import {
  canonicalState,
  diffStates,
  migrate,
  readAppState,
  type SqliteDriver,
} from "@planner/db";
import { openNodeDatabase } from "@planner/db/node";
import { seedState, type AppState } from "@planner/core";
import {
  PlannerRuntime,
  SyncClient,
  createMemoryLocalStore,
  type LocalStore,
  type SocketFactory,
} from "@planner/client-runtime";
import { Hub, type Peer } from "./hub";

const EMPTY: AppState = { projects: [], teams: [] };

/** Let every queued microtask and timer-0 callback run. */
async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * A socket factory that wires a client straight into a hub.
 *
 * `live` is scoped to each connection, not to the factory, so a client that
 * reconnects after `cut()` gets a working socket — otherwise the harness could
 * never exercise the reconnect path it exists to test.
 */
function inProcess(
  hub: Hub,
  peerId: string,
): { factory: SocketFactory; cut: () => void } {
  let killCurrent: (() => void) | null = null;

  const factory: SocketFactory = (_url, handlers) => {
    let live = true;
    const peer: Peer = {
      id: peerId,
      send: (msg) => {
        if (live) setTimeout(() => handlers.onMessage(JSON.stringify(msg)), 0);
      },
    };
    hub.connect(peer);
    setTimeout(() => handlers.onOpen(), 0);

    killCurrent = () => {
      if (!live) return;
      live = false;
      hub.disconnect(peerId);
      handlers.onClose();
    };

    return {
      send: (data) => {
        if (!live) return;
        setTimeout(() => hub.handle(peer, JSON.parse(data)), 0);
      },
      close: () => {
        live = false;
        hub.disconnect(peerId);
      },
    };
  };

  return { factory, cut: () => killCurrent?.() };
}

interface Device {
  store: LocalStore;
  client: SyncClient;
  clock: Clock;
  changes: number;
  /** Local edit: diff against the last known state and queue the ops. */
  edit(next: AppState): Promise<void>;
  state(): Promise<AppState>;
}

async function makeDevice(
  hub: Hub,
  id: string,
  backoffMs = 1,
): Promise<Device & { cut: () => void }> {
  const store = await createMemoryLocalStore({ generateDeviceId: () => id });
  const wire = inProcess(hub, id);
  const device: Device & { cut: () => void } = {
    store,
    clock: new Clock(store.deviceId),
    changes: 0,
    cut: wire.cut,
    client: new SyncClient({
      url: "ws://test/ws",
      store,
      socketFactory: wire.factory,
      onChange: () => void device.changes++,
      minBackoffMs: backoffMs,
      maxBackoffMs: backoffMs,
    }),
    async edit(next: AppState) {
      const prev = await store.read();
      const ops = diffStates(prev, next, device.clock);
      await store.applyLocal(ops);
      device.client.push();
    },
    state: () => store.read(),
  };
  return device;
}

let serverDb: SqliteDriver;
let hub: Hub;

beforeEach(() => {
  serverDb = openNodeDatabase(":memory:");
  migrate(serverDb);
  hub = new Hub(serverDb, { serverId: "srv-e2e" });
});

describe("two devices over a live connection", () => {
  it("propagates a new project from one device to the other", async () => {
    const a = await makeDevice(hub, "dev-a");
    const b = await makeDevice(hub, "dev-b");
    a.client.start();
    b.client.start();
    await settle();

    const state = seedState();
    await a.edit(state);
    await settle();

    expect(await b.state()).toEqual(canonicalState(state));
    expect(readAppState(serverDb)).toEqual(canonicalState(state));
    expect(a.client.getStatus()).toBe("live");
    expect(b.client.getStatus()).toBe("live");
  });

  it("does not echo a device's own edit back to it", async () => {
    const a = await makeDevice(hub, "dev-a");
    a.client.start();
    await settle();

    await a.edit(seedState());
    await settle();
    expect(a.changes).toBe(0);
    expect(await a.store.pending()).toEqual([]);
  });

  it("merges concurrent edits to different projects", async () => {
    const a = await makeDevice(hub, "dev-a");
    const b = await makeDevice(hub, "dev-b");
    a.client.start();
    b.client.start();
    await settle();

    await a.edit({
      projects: [],
      teams: [{ id: "t-a", name: "Team A", members: [], offDays: {} }],
    });
    await b.edit({
      projects: [],
      teams: [{ id: "t-b", name: "Team B", members: [], offDays: {} }],
    });
    await settle();

    const names = (s: AppState) => s.teams.map((t) => t.name).sort();
    expect(names(await a.state())).toEqual(["Team A", "Team B"]);
    expect(names(await b.state())).toEqual(["Team A", "Team B"]);
  });

  it("resolves a concurrent edit to the same row identically on both devices", async () => {
    const a = await makeDevice(hub, "dev-a");
    const b = await makeDevice(hub, "dev-b");
    a.client.start();
    b.client.start();
    await settle();

    const base: AppState = {
      projects: [],
      teams: [{ id: "t1", name: "Original", members: [], offDays: {} }],
    };
    await a.edit(base);
    await settle();

    await a.edit({
      ...base,
      teams: [{ ...base.teams[0], name: "Renamed by A" }],
    });
    await b.edit({
      ...base,
      teams: [{ ...base.teams[0], name: "Renamed by B" }],
    });
    await settle();

    const left = await a.state();
    const right = await b.state();
    expect(left).toEqual(right);
    expect(readAppState(serverDb)).toEqual(left);
  });
});

describe("working offline", () => {
  it("keeps accepting edits with no connection and syncs them on reconnect", async () => {
    const a = await makeDevice(hub, "dev-a");
    const b = await makeDevice(hub, "dev-b");
    b.client.start();
    await settle();

    // A never connects.
    const state = seedState();
    await a.edit(state);
    expect(await a.state()).toEqual(canonicalState(state));
    expect((await a.store.pending()).length).toBeGreaterThan(0);
    expect(await b.state()).toEqual(EMPTY);

    a.client.start();
    await settle();

    expect(await b.state()).toEqual(canonicalState(state));
    expect(await a.store.pending()).toEqual([]);
  });

  it("recovers from a dropped connection mid-session", async () => {
    // A slow backoff so the offline window is actually observable.
    const RECONNECT_MS = 200;
    const a = await makeDevice(hub, "dev-a", RECONNECT_MS);
    const b = await makeDevice(hub, "dev-b");
    a.client.start();
    b.client.start();
    await settle();

    a.cut();
    await settle(3);
    expect(a.client.getStatus()).toBe("connecting");

    await a.edit({
      projects: [],
      teams: [
        {
          id: "t-offline",
          name: "Written while offline",
          members: [],
          offDays: {},
        },
      ],
    });
    await settle();
    expect((await b.state()).teams).toHaveLength(0);

    // No manual reconnect — the client retries on its own once backoff elapses.
    await new Promise((r) => setTimeout(r, RECONNECT_MS + 50));
    await settle();
    expect((await b.state()).teams.map((t) => t.name)).toEqual([
      "Written while offline",
    ]);
  });

  it("a late joiner receives the entire history", async () => {
    const a = await makeDevice(hub, "dev-a");
    a.client.start();
    await settle();

    const state = seedState();
    await a.edit(state);
    await settle();

    const late = await makeDevice(hub, "dev-late");
    late.client.start();
    await settle();

    expect(await late.state()).toEqual(canonicalState(state));
    expect(await late.store.cursor()).toBe(hub.head());
  });
});

describe("first launch", () => {
  it("a new device joining an existing server does not seed over the real data", async () => {
    // Device A is already set up and has pushed real work to the server.
    const a = await makeDevice(hub, "dev-a");
    a.client.start();
    await settle();
    await a.edit({
      projects: [],
      teams: [{ id: "t-real", name: "My Real Team", members: [], offDays: {} }],
    });
    await settle();

    // Device B is brand new: empty store, seeding enabled — exactly the case
    // that used to produce a spurious "Sample Project" beside the real data.
    const store = await createMemoryLocalStore({
      generateDeviceId: () => "dev-new",
    });
    const wire = inProcess(hub, "dev-new");
    const fresh = new PlannerRuntime({
      store,
      sync: { url: "ws://test/ws", socketFactory: wire.factory },
      seedWhenEmpty: true,
      seedWaitMs: 2000,
    });

    const loaded = await fresh.load();
    expect(loaded.teams.map((t) => t.name)).toEqual(["My Real Team"]);
    expect(loaded.projects).toEqual([]);
  });

  it("still seeds when the server is unreachable", async () => {
    const store = await createMemoryLocalStore({
      generateDeviceId: () => "dev-alone",
    });
    const deadSocket: SocketFactory = () => {
      throw new Error("connection refused");
    };
    const offline = new PlannerRuntime({
      store,
      sync: { url: "ws://nowhere/ws", socketFactory: deadSocket },
      seedWhenEmpty: true,
      // Short, so the test doesn't sit through the real wait.
      seedWaitMs: 50,
    });

    const loaded = await offline.load();
    expect(loaded.projects.map((p) => p.name)).toEqual(["Sample Project"]);
  });
});

describe("deletes", () => {
  it("propagates a deletion", async () => {
    const a = await makeDevice(hub, "dev-a");
    const b = await makeDevice(hub, "dev-b");
    a.client.start();
    b.client.start();
    await settle();

    const state = seedState();
    await a.edit(state);
    await settle();
    expect((await b.state()).projects).toHaveLength(state.projects.length);

    await a.edit({ ...state, projects: [] });
    await settle();

    expect((await b.state()).projects).toEqual([]);
    expect(readAppState(serverDb).projects).toEqual([]);
  });

  it("a delete on one device beats a concurrent stale edit on the other", async () => {
    const a = await makeDevice(hub, "dev-a");
    const b = await makeDevice(hub, "dev-b");
    a.client.start();
    b.client.start();
    await settle();

    const base: AppState = {
      projects: [],
      teams: [{ id: "t1", name: "Doomed", members: [], offDays: {} }],
    };
    await a.edit(base);
    await settle();

    // B renames it, then A deletes it afterwards — the later stamp wins.
    await b.edit({ ...base, teams: [{ ...base.teams[0], name: "Renamed" }] });
    await settle();
    await a.edit({ projects: [], teams: [] });
    await settle();

    expect((await a.state()).teams).toEqual([]);
    expect((await b.state()).teams).toEqual([]);
  });
});
