// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeSyncUrl,
  readSyncUrlSetting,
  servedBySyncServer,
  writeSyncUrlSetting,
} from "./syncSettings";

afterEach(() => {
  localStorage.clear();
  document.head.innerHTML = "";
});

describe("normalizeSyncUrl", () => {
  it.each([
    ["localhost:5191", "ws://localhost:5191/ws"],
    ["http://192.168.1.20:5191", "ws://192.168.1.20:5191/ws"],
    ["https://planner.example.com", "wss://planner.example.com/ws"],
    ["ws://localhost:5191/ws", "ws://localhost:5191/ws"],
    ["  wss://box/custom  ", "wss://box/custom"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeSyncUrl(input)).toBe(expected);
  });

  it("rejects what can't be a sync server", () => {
    expect(normalizeSyncUrl("")).toBeNull();
    expect(normalizeSyncUrl("ftp://box")).toBeNull();
    expect(normalizeSyncUrl("http://")).toBeNull();
  });
});

describe("stored setting", () => {
  it("round-trips and clears", () => {
    expect(readSyncUrlSetting()).toBeNull();
    writeSyncUrlSetting("ws://localhost:5191/ws");
    expect(readSyncUrlSetting()).toBe("ws://localhost:5191/ws");
    writeSyncUrlSetting(null);
    expect(readSyncUrlSetting()).toBeNull();
  });
});

describe("servedBySyncServer", () => {
  it("reads the marker the server injects", () => {
    expect(servedBySyncServer()).toBe(false);
    document.head.innerHTML =
      '<meta name="planner-sync" content="same-origin">';
    expect(servedBySyncServer()).toBe(true);
  });
});
