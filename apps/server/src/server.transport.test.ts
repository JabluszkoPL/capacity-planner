/**
 * The real transport.
 *
 * hub.test.ts covers the routing and sync.e2e.test.ts covers two clients
 * converging, but both shorten the wire. This one stands up an actual HTTP +
 * WebSocket server on an ephemeral port and drives it with the same
 * `webSocketFactory` the browser and the Mac app use — so a break in framing,
 * upgrade handling, or the health endpoint is caught here rather than in a
 * browser.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { migrate, readAppState, type SqliteDriver } from "@planner/db";
import { openNodeDatabase } from "@planner/db/node";
import type { AppState } from "@planner/core";
import {
  PlannerRuntime,
  createMemoryLocalStore,
  webSocketFactory,
} from "@planner/client-runtime";
import { listen, type RunningServer } from "./server";

let db: SqliteDriver;
let server: RunningServer;
let url: string;

beforeEach(async () => {
  db = openNodeDatabase(":memory:");
  migrate(db);
  server = await listen(db, randomUUID(), 0, "127.0.0.1");
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterEach(async () => {
  await server.close();
  db.close();
});

async function device(id: string) {
  const store = await createMemoryLocalStore({ generateDeviceId: () => id });
  const runtime = new PlannerRuntime({
    store,
    sync: { url, socketFactory: webSocketFactory },
    seedWaitMs: 200,
  });
  return { store, runtime };
}

/** Poll until `check` passes or the budget runs out. */
async function eventually(check: () => boolean | Promise<boolean>, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const teamState = (name: string): AppState => ({
  projects: [],
  teams: [{ id: "t1", name, members: [], offDays: {} }],
});

describe("HTTP surface", () => {
  it("reports health", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      protocol: 1,
      seq: 0,
    });
  });

  it("reports its version, and whether the Mac app owns it", async () => {
    const plain = await (
      await fetch(`http://127.0.0.1:${server.port}/health`)
    ).json();
    expect(plain).toMatchObject({ version: null, managed: false });
    expect(plain).not.toHaveProperty("pid");

    const owned = await listen(db, randomUUID(), 0, "127.0.0.1", {
      version: "9.9.9",
      managed: true,
    });
    try {
      const body = await (
        await fetch(`http://127.0.0.1:${owned.port}/health`)
      ).json();
      expect(body).toMatchObject({
        version: "9.9.9",
        managed: true,
        pid: process.pid,
      });
    } finally {
      await owned.close();
    }
  });

  it("serves a read-only state dump", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`);
    await expect(res.json()).resolves.toEqual({ projects: [], teams: [] });
  });

  it("404s anything else", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("over a real socket", () => {
  it("pushes a local edit through to the server's database", async () => {
    const a = await device("dev-a");
    await a.runtime.load();

    await a.runtime.commit(
      { projects: [], teams: [] },
      teamState("Pushed Team"),
    );
    await eventually(() => readAppState(db).teams.length === 1);

    expect(readAppState(db).teams[0].name).toBe("Pushed Team");
    await eventually(async () => (await a.store.pending()).length === 0);
    await a.runtime.stop();
  });

  it("carries an edit from one device to another", async () => {
    const a = await device("dev-a");
    const b = await device("dev-b");
    await Promise.all([a.runtime.load(), b.runtime.load()]);

    await a.runtime.commit({ projects: [], teams: [] }, teamState("From A"));

    await eventually(async () => (await b.store.read()).teams.length === 1);
    expect((await b.store.read()).teams[0].name).toBe("From A");

    await a.runtime.stop();
    await b.runtime.stop();
  });

  it("gives a device joining later the full history", async () => {
    const a = await device("dev-a");
    await a.runtime.load();
    await a.runtime.commit(
      { projects: [], teams: [] },
      teamState("Established"),
    );
    await eventually(() => readAppState(db).teams.length === 1);

    // load() answers from local storage straight away — that is the local-first
    // contract, and it is why the UI never blocks on the network. The server's
    // history arrives a moment later and the runtime notifies.
    const late = await device("dev-late");
    let notified = 0;
    late.runtime.onRemoteChange(() => void notified++);
    expect((await late.runtime.load()).teams).toEqual([]);

    await eventually(async () => (await late.store.read()).teams.length === 1);
    expect((await late.store.read()).teams[0].name).toBe("Established");
    expect(notified).toBeGreaterThan(0);

    await a.runtime.stop();
    await late.runtime.stop();
  });

  it("an edit made before the socket finishes opening is still pushed", async () => {
    const a = await device("dev-eager");
    // Deliberately no await on load(): commit into the window between the
    // socket being requested and it actually opening.
    void a.runtime.load();
    await a.runtime.commit(
      { projects: [], teams: [] },
      teamState("Written eagerly"),
    );

    await eventually(() => readAppState(db).teams.length === 1);
    expect(readAppState(db).teams[0].name).toBe("Written eagerly");
    await a.runtime.stop();
  });

  it("reports the connection count while devices are attached", async () => {
    const a = await device("dev-a");
    await a.runtime.load();
    await eventually(() => server.hub.connectionCount === 1);
    await a.runtime.stop();
    await eventually(() => server.hub.connectionCount === 0);
  });
});
