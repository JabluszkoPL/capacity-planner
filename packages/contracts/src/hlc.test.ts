import { describe, it, expect } from "vitest";
import { Clock, compareHlc, formatHlc, parseHlc, MAX_DRIFT_MS } from "./hlc";

function fixedClock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("hlc format", () => {
  it("round-trips through parse", () => {
    const s = formatHlc({
      millis: 1_700_000_000_000,
      counter: 7,
      deviceId: "dev-a",
    });
    expect(parseHlc(s)).toEqual({
      millis: 1_700_000_000_000,
      counter: 7,
      deviceId: "dev-a",
    });
  });

  it("is fixed-width so string order == time order", () => {
    const early = formatHlc({ millis: 999, counter: 0, deviceId: "a" });
    const late = formatHlc({
      millis: 1_700_000_000_000,
      counter: 0,
      deviceId: "a",
    });
    expect(early.length).toBe(late.length);
    expect(compareHlc(early, late)).toBe(-1);
  });

  it("rejects malformed stamps", () => {
    expect(parseHlc("nope")).toBeNull();
    expect(parseHlc("")).toBeNull();
    expect(parseHlc("0000-0000-dev")).toBeNull();
  });
});

describe("Clock.tick", () => {
  it("is strictly increasing even within one millisecond", () => {
    const t = fixedClock(1000);
    const c = new Clock("dev-a", t.now);
    const stamps = [c.tick(), c.tick(), c.tick()];
    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(3);
  });

  it("resets the counter once wall time moves on", () => {
    const t = fixedClock(1000);
    const c = new Clock("dev-a", t.now);
    c.tick();
    c.tick();
    t.advance(5);
    expect(parseHlc(c.tick())!.counter).toBe(0);
  });
});

describe("Clock.observe", () => {
  it("orders a local edit after a remote stamp it has seen", () => {
    const t = fixedClock(1000);
    const local = new Clock("dev-a", t.now);
    const remote = new Clock("dev-b", () => 5000);

    const remoteStamp = remote.tick();
    expect(local.observe(remoteStamp)).toBe(true);
    expect(compareHlc(local.tick(), remoteStamp)).toBe(1);
  });

  it("ignores a stamp from a wildly wrong clock", () => {
    const t = fixedClock(1000);
    const local = new Clock("dev-a", t.now);
    const insane = formatHlc({
      millis: 1000 + MAX_DRIFT_MS * 2,
      counter: 0,
      deviceId: "dev-b",
    });
    expect(local.observe(insane)).toBe(false);
    // Local time was not dragged forward.
    expect(parseHlc(local.tick())!.millis).toBe(1000);
  });

  it("ignores unparseable stamps", () => {
    const local = new Clock("dev-a", () => 1000);
    expect(local.observe("garbage")).toBe(false);
  });

  it("two devices converge on a total order", () => {
    const a = new Clock("dev-a", () => 1000);
    const b = new Clock("dev-b", () => 1000);
    const s1 = a.tick();
    b.observe(s1);
    const s2 = b.tick();
    a.observe(s2);
    const s3 = a.tick();
    expect([s1, s2, s3]).toEqual([s1, s2, s3].sort());
  });
});
