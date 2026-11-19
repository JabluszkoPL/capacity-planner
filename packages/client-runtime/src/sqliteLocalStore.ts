/**
 * LocalStore over a real SQLite database.
 *
 * Used by the Electron main process (and, later, React Native) so the Mac app's
 * data lives in an actual queryable `state.sqlite` you can open with any SQLite
 * tool — not an opaque blob. All the merge logic comes from @planner/db, which
 * is the same code the server runs.
 */
import type { Op, StampedOp } from "@planner/contracts";
import type { AppState } from "@planner/core";
import {
  applyLocalOp,
  applyRemoteOp,
  clearPending,
  getMeta,
  migrate,
  pendingOps,
  readAppState,
  setMeta,
  type SqliteDriver,
} from "@planner/db";
import type { LocalStore } from "./localStore";

const CURSOR_KEY = "server_cursor";
const DEVICE_KEY = "device_id";

export interface SqliteLocalStoreOptions {
  /** Injected so tests are deterministic and Electron can reuse a stored id. */
  generateDeviceId?: () => string;
}

export function createSqliteLocalStore(
  db: SqliteDriver,
  options: SqliteLocalStoreOptions = {},
): LocalStore {
  migrate(db);

  const generate =
    options.generateDeviceId ??
    (() => `dev-${Math.random().toString(36).slice(2, 10)}`);
  let deviceId = getMeta(db, DEVICE_KEY);
  if (!deviceId) {
    deviceId = generate();
    setMeta(db, DEVICE_KEY, deviceId);
  }

  const readCursor = (): number => Number(getMeta(db, CURSOR_KEY) ?? 0);

  return {
    deviceId,

    async read() {
      return readAppState(db);
    },

    async applyLocal(ops: Op[]) {
      if (ops.length === 0) return;
      db.transaction(() => {
        for (const op of ops) applyLocalOp(db, op);
      });
    },

    async applyRemote(ops: StampedOp[], cursor: number) {
      let changed = false;
      db.transaction(() => {
        for (const op of ops) {
          if (applyRemoteOp(db, op)) changed = true;
        }
        if (cursor > readCursor()) setMeta(db, CURSOR_KEY, String(cursor));
      });
      return changed;
    },

    async pending() {
      return pendingOps(db);
    },

    async ackThrough(outboxSeq: number) {
      clearPending(db, outboxSeq);
    },

    async cursor() {
      return readCursor();
    },

    async resetCursor() {
      setMeta(db, CURSOR_KEY, "0");
    },

    async close() {
      db.close();
    },
  } satisfies LocalStore & { read(): Promise<AppState> };
}

export type { LocalStore } from "./localStore";
