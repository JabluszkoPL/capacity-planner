/**
 * LocalStore over an async bridge to another process.
 *
 * This is how the Mac app gets a real database. Electron's renderer can't open
 * SQLite itself — and shouldn't, since that would mean handing the web content
 * process filesystem access — so the main process owns the database and the
 * renderer talks to it across the context bridge. Everything above this line
 * (the store, the reducer, all 33 components) is identical to the browser build;
 * only which LocalStore gets constructed differs.
 */
import type { Op, StampedOp } from "@planner/contracts";
import type { AppState } from "@planner/core";
import type { LocalStore } from "./localStore";

/** The methods the host process must expose. Mirrors LocalStore, but with the
 *  device id fetched rather than read, since IPC has no synchronous getters. */
export interface LocalStoreBridge {
  deviceId(): Promise<string>;
  read(): Promise<AppState>;
  applyLocal(ops: Op[]): Promise<void>;
  applyRemote(ops: StampedOp[], cursor: number): Promise<boolean>;
  pending(): Promise<StampedOp[]>;
  ackThrough(outboxSeq: number): Promise<void>;
  cursor(): Promise<number>;
  resetCursor(): Promise<void>;
}

export async function createBridgeLocalStore(
  bridge: LocalStoreBridge,
): Promise<LocalStore> {
  const deviceId = await bridge.deviceId();

  return {
    deviceId,
    read: () => bridge.read(),
    applyLocal: (ops) =>
      ops.length === 0 ? Promise.resolve() : bridge.applyLocal(ops),
    applyRemote: (ops, cursor) => bridge.applyRemote(ops, cursor),
    pending: () => bridge.pending(),
    ackThrough: (seq) => bridge.ackThrough(seq),
    cursor: () => bridge.cursor(),
    resetCursor: () => bridge.resetCursor(),
    // The host owns the database handle and closes it on quit; a renderer
    // teardown must not take it down with it.
    close: async () => {},
  };
}
