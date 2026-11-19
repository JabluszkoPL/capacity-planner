/**
 * IndexedDB persistence for the browser's local store.
 *
 * The whole snapshot is written as one record. That sounds crude, but the data
 * is a few hundred rows and the store already coalesces bursts of edits into a
 * single write — a record-per-row schema would add transaction bookkeeping and
 * buy nothing measurable. IndexedDB rather than localStorage because a plan
 * with a few thousand assignments will comfortably exceed the 5 MB string quota,
 * and because writes here don't block the main thread.
 */
import type { Snapshot, SnapshotPersistence } from "@planner/client-runtime";

const DB_NAME = "planner";
const DB_VERSION = 1;
const STORE = "snapshot";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = fn(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB request failed"));
  });
}

export function createIndexedDbPersistence(): SnapshotPersistence {
  // One connection, opened lazily and reused. Reopening per call would make
  // every save wait on a handshake.
  let handle: Promise<IDBDatabase> | null = null;
  const db = () => (handle ??= open());

  return {
    async load(): Promise<Snapshot | null> {
      try {
        const value = await tx<Snapshot | undefined>(
          await db(),
          "readonly",
          (s) => s.get(KEY),
        );
        return value ?? null;
      } catch {
        // A blocked or corrupt database must not stop the app starting; the
        // user gets an empty local store and syncs down from the server.
        return null;
      }
    },

    async save(snapshot: Snapshot): Promise<void> {
      const conn = await db();
      await tx(conn, "readwrite", (s) => s.put(snapshot, KEY));
    },
  };
}

/** Whether this browser can persist at all (private mode can refuse). */
export function indexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}
