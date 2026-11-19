import { describe, expect, it } from "vitest";
import {
  decideShareStart,
  isAppServerCommand,
  parseHealth,
  type ServerHealth,
} from "./shareDecision";

const health = (over: Partial<ServerHealth> = {}): ServerHealth => ({
  protocol: 1,
  version: "0.1.4",
  managed: false,
  pid: null,
  ...over,
});

describe("parseHealth", () => {
  it("reads a current server", () => {
    expect(
      parseHealth({ protocol: 1, version: "0.1.5", managed: true, pid: 42 }),
    ).toEqual({ protocol: 1, version: "0.1.5", managed: true, pid: 42 });
  });

  it("reads an older server that reports neither version nor owner", () => {
    expect(parseHealth({ app: "planner", ok: true, protocol: 1 })).toEqual({
      protocol: 1,
      version: null,
      managed: false,
      pid: null,
    });
  });

  it("rejects anything that isn't a Planner server", () => {
    expect(parseHealth(null)).toBeNull();
    expect(parseHealth({ ok: true })).toBeNull();
    expect(parseHealth("ok")).toBeNull();
  });

  it("ignores a pid that couldn't be a real process to signal", () => {
    expect(parseHealth({ protocol: 1, pid: 1 })?.pid).toBeNull();
    expect(parseHealth({ protocol: 1, pid: -5 })?.pid).toBeNull();
    expect(parseHealth({ protocol: 1, pid: "42" })?.pid).toBeNull();
  });
});

describe("decideShareStart", () => {
  it("starts its own server when nothing answers", () => {
    expect(decideShareStart(null, false)).toEqual({ kind: "spawn" });
  });

  it("replaces a server a Planner app left behind", () => {
    expect(decideShareStart(health({ managed: true, pid: 42 }), false)).toEqual(
      { kind: "replace", pid: 42 },
    );
  });

  it("replaces an older app's server, identified by its process", () => {
    expect(decideShareStart(health({ version: null }), true)).toEqual({
      kind: "replace",
      pid: null,
    });
  });

  it("joins a server the user runs, and reports its version", () => {
    expect(decideShareStart(health({ version: "0.1.3" }), false)).toEqual({
      kind: "join",
      foreignVersion: "0.1.3",
    });
    expect(decideShareStart(health({ version: null }), false)).toEqual({
      kind: "join",
      foreignVersion: null,
    });
  });

  it("never replaces a server that reports itself unmanaged", () => {
    // Even if a process lookup claims otherwise: the server's own word wins.
    expect(decideShareStart(health({ version: "0.1.4" }), true).kind).toBe(
      "join",
    );
  });
});

describe("isAppServerCommand", () => {
  it("recognises the Mac app's bundled server", () => {
    expect(
      isAppServerCommand(
        "/Applications/Planner.app/Contents/MacOS/Planner /Applications/Planner.app/Contents/Resources/app.asar.unpacked/dist/sync-server.cjs",
      ),
    ).toBe(true);
  });

  it("leaves a developer's server alone", () => {
    expect(isAppServerCommand("node dist/server.cjs")).toBe(false);
    expect(isAppServerCommand("node /x/apps/server/dist/server.cjs")).toBe(
      false,
    );
    expect(isAppServerCommand("vim sync-server.cjs.bak")).toBe(false);
  });
});
