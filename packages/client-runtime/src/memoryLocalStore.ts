/**
 * LocalStore over an in-memory row index, with pluggable persistence.
 *
 * This is the browser's implementation. Running real SQLite in a tab means
 * shipping a wasm build and wrestling with OPFS, and Planner's whole dataset is
 * a few hundred rows — an index in memory, snapshotted to IndexedDB, is both
 * smaller and faster. What matters is that it obeys *exactly* the same merge
 * rule as the SQLite store; `conformance.ts` runs one shared test suite against
 * both to keep that true.
 *
 * State assembly is not reimplemented here: the rows are handed to the very
 * same `assemble()` that @planner/db uses on the server, so a project renders
 * identically wherever it is read from.
 */
import { compareHlc, type Op, type StampedOp } from "@planner/contracts";
import type { AppState } from "@planner/core";
import { assemble, type Entry } from "@planner/db";
import type { LocalStore } from "./localStore";

type StoredRow = Op;

export interface Snapshot {
  deviceId: string;
  cursor: number;
  outboxSeq: number;
  rows: StoredRow[];
  outbox: StampedOp[];
}

/** Where a snapshot is durably kept. Absent = a purely in-memory store. */
export interface SnapshotPersistence {
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
}

export interface MemoryLocalStoreOptions {
  persistence?: SnapshotPersistence;
  generateDeviceId?: () => string;
  /** Coalesce writes this many ms after the last change. */
  saveDelayMs?: number;
}

const key = (entity: string, id: string): string => `${entity}:${id}`;

/**
 * Build the store from an already-loaded snapshot. Synchronous, so a component
 * that just needs somewhere to put state (a test, a preview, a throwaway
 * session) can have one without an await.
 */
export function createInMemoryLocalStore(
  options: MemoryLocalStoreOptions & { restored?: Snapshot | null } = {},
): LocalStore {
  const restored = options.restored ?? null;
  const persistence = options.persistence;
  const saveDelayMs = options.saveDelayMs ?? 250;
  const generate =
    options.generateDeviceId ??
    (() => `dev-${Math.random().toString(36).slice(2, 10)}`);

  const rows = new Map<string, StoredRow>(
    (restored?.rows ?? []).map((r) => [key(r.entity, r.id), r]),
  );
  const outbox: StampedOp[] = [...(restored?.outbox ?? [])];
  let cursor = restored?.cursor ?? 0;
  let outboxSeq = restored?.outboxSeq ?? 0;
  const deviceId = restored?.deviceId ?? generate();

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  function snapshot(): Snapshot {
    return {
      deviceId,
      cursor,
      outboxSeq,
      rows: [...rows.values()],
      outbox: [...outbox],
    };
  }

  /** Debounced write-behind. Callers never await it; `close()` flushes. */
  function schedulePersist(): void {
    if (!persistence) return;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      inFlight = persistence.save(snapshot()).catch(() => {
        // Best-effort: a failed snapshot costs us unsynced edits on a hard
        // reload, but must never break the running app.
      });
    }, saveDelayMs);
  }

  async function flush(): Promise<void> {
    if (!persistence) return;
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      inFlight = persistence.save(snapshot()).catch(() => {});
    }
    await inFlight;
  }

  /** The one merge rule, mirroring @planner/db#applyRemoteOp. */
  function merge(op: Op): boolean {
    const k = key(op.entity, op.id);
    const existing = rows.get(k);
    if (existing && compareHlc(op.hlc, existing.hlc) <= 0) return false;
    rows.set(k, {
      entity: op.entity,
      id: op.id,
      hlc: op.hlc,
      deleted: op.deleted,
      data: op.deleted ? null : (op.data ?? {}),
    });
    return true;
  }

  return {
    deviceId,

    async read(): Promise<AppState> {
      const entries: Entry[] = [];
      for (const row of rows.values()) {
        if (row.deleted || row.data === null) continue;
        entries.push({ entity: row.entity, id: row.id, payload: row.data });
      }
      return assemble(entries);
    },

    async applyLocal(ops: Op[]) {
      let changed = false;
      for (const op of ops) {
        if (!merge(op)) continue;
        changed = true;
        // Compact: under last-write-wins an older queued op for the same row
        // can never change the outcome, so replace it rather than pile up.
        const k = key(op.entity, op.id);
        const stale = outbox.findIndex((o) => key(o.entity, o.id) === k);
        if (stale !== -1) outbox.splice(stale, 1);
        outbox.push({ ...op, seq: ++outboxSeq });
      }
      if (changed) schedulePersist();
    },

    async applyRemote(ops: StampedOp[], next: number) {
      let changed = false;
      for (const op of ops) {
        if (merge(op)) changed = true;
      }
      const cursorMoved = next > cursor;
      if (cursorMoved) cursor = next;
      // `changed` reports whether the *data* moved — a cursor bump alone must
      // not trigger a re-render, or every heartbeat would repaint the UI.
      if (changed || cursorMoved) schedulePersist();
      return changed;
    },

    async pending() {
      return [...outbox];
    },

    async ackThrough(seq: number) {
      const keep = outbox.filter((o) => o.seq > seq);
      outbox.length = 0;
      outbox.push(...keep);
      schedulePersist();
    },

    async cursor() {
      return cursor;
    },

    async resetCursor() {
      cursor = 0;
      schedulePersist();
    },

    async close() {
      await flush();
    },
  };
}

/** Load any persisted snapshot first, then build the store around it. */
export async function createMemoryLocalStore(
  options: MemoryLocalStoreOptions = {},
): Promise<LocalStore> {
  const restored = options.persistence
    ? await options.persistence.load()
    : null;
  return createInMemoryLocalStore({ ...options, restored });
}
