import { describe, it, expect } from "vitest";
import { decodeClientMessage, decodeServerMessage, encode } from "./protocol";
import { isOp } from "./entities";

const goodOp = {
  entity: "task",
  id: "t1",
  hlc: "0000018c1a2b-0000-dev-a",
  deleted: false,
  data: { name: "Build it" },
};

describe("isOp", () => {
  it("accepts a well-formed op", () => {
    expect(isOp(goodOp)).toBe(true);
  });
  it("requires a tombstone to carry no data", () => {
    expect(isOp({ ...goodOp, deleted: true, data: null })).toBe(true);
    const { data: _drop, ...noData } = goodOp;
    expect(isOp({ ...noData, deleted: true })).toBe(true);
    expect(isOp({ ...goodOp, deleted: true, data: { name: "x" } })).toBe(false);
  });
  it("rejects unknown entity kinds and empty ids", () => {
    expect(isOp({ ...goodOp, entity: "sprocket" })).toBe(false);
    expect(isOp({ ...goodOp, id: "" })).toBe(false);
  });
});

describe("decodeClientMessage", () => {
  it("round-trips each frame", () => {
    const frames = [
      { t: "hello" as const, v: 1, deviceId: "dev-a", since: 0 },
      { t: "push" as const, ops: [goodOp as never] },
      { t: "pull" as const, since: 42 },
      { t: "ping" as const },
    ];
    for (const f of frames) {
      expect(decodeClientMessage(encode(f))).toEqual(f);
    }
  });

  it("returns null rather than throwing on junk", () => {
    expect(decodeClientMessage("{{{")).toBeNull();
    expect(decodeClientMessage("null")).toBeNull();
    expect(decodeClientMessage('{"t":"nope"}')).toBeNull();
    expect(decodeClientMessage('{"t":"pull","since":-1}')).toBeNull();
    expect(decodeClientMessage('{"t":"pull","since":1.5}')).toBeNull();
    expect(
      decodeClientMessage('{"t":"hello","v":1,"deviceId":"","since":0}'),
    ).toBeNull();
  });

  it("rejects a push containing even one bad op", () => {
    const raw = encode({
      t: "push",
      ops: [goodOp, { entity: "task" }] as never,
    });
    expect(decodeClientMessage(raw)).toBeNull();
  });
});

describe("decodeServerMessage", () => {
  it("round-trips each frame", () => {
    const frames = [
      { t: "welcome" as const, v: 1, serverId: "srv", seq: 3 },
      {
        t: "ops" as const,
        ops: [{ ...goodOp, seq: 4 } as never],
        seq: 4,
        hasMore: false,
      },
      { t: "ack" as const, applied: 2, rejected: 0, seq: 6 },
      { t: "error" as const, code: "bad_message" as const, message: "nope" },
      { t: "pong" as const },
    ];
    for (const f of frames) {
      expect(decodeServerMessage(encode(f))).toEqual(f);
    }
  });

  it("rejects an ops frame whose ops lack a seq", () => {
    const raw = encode({
      t: "ops",
      ops: [goodOp as never],
      seq: 1,
      hasMore: false,
    });
    expect(decodeServerMessage(raw)).toBeNull();
  });
});
