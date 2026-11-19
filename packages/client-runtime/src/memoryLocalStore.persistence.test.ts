import { describe, it, expect } from "vitest";
import { Clock } from "@planner/contracts";
import { canonicalState, snapshotOps } from "@planner/db";
import { seedState } from "@planner/core";
import {
  createMemoryLocalStore,
  type Snapshot,
  type SnapshotPersistence,
} from "./memoryLocalStore";

/** Stands in for IndexedDB. */
function fakeDisk() {
  let saved: Snapshot | null = null;
  let writes = 0;
  const persistence: SnapshotPersistence = {
    load: async () => (saved ? structuredClone(saved) : null),
    save: async (s) => {
      writes++;
      saved = structuredClone(s);
    },
  };
  return { persistence, writes: () => writes, peek: () => saved };
}

describe("memory store persistence", () => {
  it("restores state, outbox and cursor across a reload", async () => {
    const disk = fakeDisk();
    const state = seedState();

    const first = await createMemoryLocalStore({
      persistence: disk.persistence,
      saveDelayMs: 0,
      generateDeviceId: () => "dev-fixed",
    });
    const clock = new Clock(first.deviceId);
    await first.applyLocal(snapshotOps(state, clock));
    await first.applyRemote([], 12);
    await first.close();

    const second = await createMemoryLocalStore({
      persistence: disk.persistence,
      saveDelayMs: 0,
    });
    expect(second.deviceId).toBe("dev-fixed");
    expect(await second.read()).toEqual(canonicalState(state));
    expect(await second.cursor()).toBe(12);
    expect((await second.pending()).length).toBe(
      (await first.pending()).length,
    );
    await second.close();
  });

  it("coalesces a burst of edits into a single write", async () => {
    const disk = fakeDisk();
    const store = await createMemoryLocalStore({
      persistence: disk.persistence,
      saveDelayMs: 20,
    });
    const clock = new Clock(store.deviceId);
    for (let i = 0; i < 25; i++) {
      await store.applyLocal([
        {
          entity: "team",
          id: `t${i}`,
          hlc: clock.tick(),
          deleted: false,
          data: { name: `T${i}`, position: i },
        },
      ]);
    }
    await store.close();
    expect(disk.writes()).toBe(1);
    expect(disk.peek()!.rows).toHaveLength(25);
  });

  it("a failing disk never breaks the running store", async () => {
    const store = await createMemoryLocalStore({
      saveDelayMs: 0,
      persistence: {
        load: async () => null,
        save: async () => {
          throw new Error("quota exceeded");
        },
      },
    });
    const clock = new Clock(store.deviceId);
    await store.applyLocal([
      {
        entity: "team",
        id: "t1",
        hlc: clock.tick(),
        deleted: false,
        data: { name: "Core", position: 0 },
      },
    ]);
    await expect(store.close()).resolves.toBeUndefined();
    expect((await store.read()).teams[0].name).toBe("Core");
  });
});
