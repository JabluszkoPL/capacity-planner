import { describe, it, expect, beforeEach } from "vitest";
import {
  Clock,
  PROTOCOL_VERSION,
  type Op,
  type ServerMessage,
} from "@planner/contracts";
import {
  migrate,
  readAppState,
  snapshotOps,
  type SqliteDriver,
} from "@planner/db";
import { openNodeDatabase } from "@planner/db/node";
import { seedState } from "@planner/core";
import { Hub, type Peer } from "./hub";

/** A peer that records what the hub sent it. */
function testPeer(id: string) {
  const inbox: ServerMessage[] = [];
  const peer: Peer = { id, send: (m) => void inbox.push(m) };
  return {
    peer,
    inbox,
    last: () => inbox[inbox.length - 1],
    ofType: <T extends ServerMessage["t"]>(t: T) =>
      inbox.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[],
    clear: () => void (inbox.length = 0),
  };
}

let db: SqliteDriver;
let hub: Hub;
let clock: Clock;

beforeEach(() => {
  db = openNodeDatabase(":memory:");
  migrate(db);
  hub = new Hub(db, { serverId: "srv-test", pageSize: 3 });
  clock = new Clock("dev-a");
});

const teamOp = (id: string, name: string, hlc: string): Op => ({
  entity: "team",
  id,
  hlc,
  deleted: false,
  data: { name, position: 0 },
});

describe("handshake", () => {
  it("welcomes a client and immediately sends the ops it is missing", () => {
    const a = testPeer("a");
    hub.connect(a.peer);
    hub.handle(a.peer, {
      t: "push",
      ops: [teamOp("t1", "Core", clock.tick())],
    });
    a.clear();

    const b = testPeer("b");
    hub.connect(b.peer);
    hub.handle(b.peer, {
      t: "hello",
      v: PROTOCOL_VERSION,
      deviceId: "dev-b",
      since: 0,
    });

    expect(b.inbox[0]).toMatchObject({ t: "welcome", serverId: "srv-test" });
    expect(b.inbox[1]).toMatchObject({ t: "ops", hasMore: false });
    expect(b.ofType("ops")[0].ops).toHaveLength(1);
  });

  it("refuses a client speaking a different protocol version", () => {
    const a = testPeer("a");
    hub.connect(a.peer);
    hub.handle(a.peer, {
      t: "hello",
      v: PROTOCOL_VERSION + 1,
      deviceId: "dev-a",
      since: 0,
    });
    expect(a.last()).toMatchObject({ t: "error", code: "version_mismatch" });
  });

  it("answers ping", () => {
    const a = testPeer("a");
    hub.connect(a.peer);
    hub.handle(a.peer, { t: "ping" });
    expect(a.last()).toEqual({ t: "pong" });
  });
});

describe("push", () => {
  it("acks and applies a batch", () => {
    const a = testPeer("a");
    hub.connect(a.peer);
    hub.handle(a.peer, {
      t: "push",
      ops: [
        teamOp("t1", "Core", clock.tick()),
        teamOp("t2", "Platform", clock.tick()),
      ],
    });
    expect(a.last()).toMatchObject({ t: "ack", applied: 2, rejected: 0 });
    expect(readAppState(db).teams.map((t) => t.name)).toEqual([
      "Core",
      "Platform",
    ]);
  });

  it("counts a stale op as rejected and keeps it out of the log", () => {
    const a = testPeer("a");
    hub.connect(a.peer);
    const older = clock.tick();
    const newer = clock.tick();
    hub.handle(a.peer, { t: "push", ops: [teamOp("t1", "Newer", newer)] });
    const headAfterFirst = hub.head();

    hub.handle(a.peer, { t: "push", ops: [teamOp("t1", "Older", older)] });
    expect(a.last()).toMatchObject({ t: "ack", applied: 0, rejected: 1 });
    expect(hub.head()).toBe(headAfterFirst);
    expect(readAppState(db).teams[0].name).toBe("Newer");
  });

  it("is idempotent when a client resends after a dropped connection", () => {
    const a = testPeer("a");
    hub.connect(a.peer);
    const op = teamOp("t1", "Core", clock.tick());
    hub.handle(a.peer, { t: "push", ops: [op] });
    hub.handle(a.peer, { t: "push", ops: [op] });
    expect(a.last()).toMatchObject({ applied: 0, rejected: 1 });
    expect(hub.head()).toBe(1);
  });
});

describe("fan-out", () => {
  it("broadcasts to other peers but not back to the sender", () => {
    const a = testPeer("a");
    const b = testPeer("b");
    hub.connect(a.peer);
    hub.connect(b.peer);

    hub.handle(a.peer, {
      t: "push",
      ops: [teamOp("t1", "Core", clock.tick())],
    });

    expect(a.ofType("ops")).toHaveLength(0);
    expect(a.ofType("ack")).toHaveLength(1);
    expect(b.ofType("ops")).toHaveLength(1);
    expect(b.ofType("ops")[0].ops[0]).toMatchObject({ id: "t1", seq: 1 });
  });

  it("stops broadcasting to a disconnected peer", () => {
    const a = testPeer("a");
    const b = testPeer("b");
    hub.connect(a.peer);
    hub.connect(b.peer);
    hub.disconnect("b");

    hub.handle(a.peer, {
      t: "push",
      ops: [teamOp("t1", "Core", clock.tick())],
    });
    expect(b.inbox).toHaveLength(0);
    expect(hub.connectionCount).toBe(1);
  });

  it("one failing peer does not stop the others receiving the batch", () => {
    const good = testPeer("good");
    const bad: Peer = {
      id: "bad",
      send() {
        throw new Error("socket is gone");
      },
    };
    const a = testPeer("a");
    hub.connect(a.peer);
    hub.connect(bad);
    hub.connect(good.peer);

    hub.handle(a.peer, {
      t: "push",
      ops: [teamOp("t1", "Core", clock.tick())],
    });
    expect(good.ofType("ops")).toHaveLength(1);
  });
});

describe("paging", () => {
  it("pages a large backlog and reports hasMore", () => {
    const a = testPeer("a");
    hub.connect(a.peer);
    const ops = snapshotOps(seedState(), clock);
    expect(ops.length).toBeGreaterThan(3);
    hub.handle(a.peer, { t: "push", ops });

    const b = testPeer("b");
    hub.connect(b.peer);
    hub.handle(b.peer, { t: "pull", since: 0 });
    const first = b.ofType("ops")[0];
    expect(first.ops).toHaveLength(3);
    expect(first.hasMore).toBe(true);

    // Walk the cursor to the end; the client ends up with every op exactly once.
    let cursor = first.seq;
    const collected = [...first.ops];
    for (let guard = 0; guard < 100; guard++) {
      b.clear();
      hub.handle(b.peer, { t: "pull", since: cursor });
      const page = b.ofType("ops")[0];
      collected.push(...page.ops);
      cursor = page.seq;
      if (!page.hasMore) break;
    }
    expect(collected).toHaveLength(ops.length);
    expect(new Set(collected.map((o) => o.seq)).size).toBe(ops.length);
  });

  it("returns an empty page when the client is already current", () => {
    const a = testPeer("a");
    hub.connect(a.peer);
    hub.handle(a.peer, {
      t: "push",
      ops: [teamOp("t1", "Core", clock.tick())],
    });
    a.clear();
    hub.handle(a.peer, { t: "pull", since: hub.head() });
    expect(a.ofType("ops")[0]).toMatchObject({
      ops: [],
      hasMore: false,
      seq: hub.head(),
    });
  });
});
