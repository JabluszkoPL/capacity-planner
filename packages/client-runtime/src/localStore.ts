/**
 * The client's local database, as an interface.
 *
 * Every platform Planner runs on holds a complete copy of the data and works
 * with the network down — that is what "local-first" buys, and it is why this
 * is an interface rather than a concrete SQLite handle. The Mac app fulfils it
 * with a real SQLite file in the Electron main process; the browser fulfils it
 * with an in-memory row index persisted to IndexedDB; React Native will fulfil
 * it with expo-sqlite. The store and the sync client know only this shape.
 *
 * Two sequence numbers appear here and they are NOT the same thing:
 *  - the **outbox seq** is local, and only ever used to say "these queued ops
 *    have now been acked, drop them".
 *  - the **cursor** is the server's global seq, and says "I have durably
 *    applied everything up to here" — it is what a reconnect resumes from.
 */
import type { Op, StampedOp } from "@planner/contracts";
import type { AppState } from "@planner/core";

export interface LocalStore {
  /** Stable per-installation id. Also the tiebreak in every HLC stamp this
   *  device produces, so it must survive restarts. */
  readonly deviceId: string;

  /** Materialise the whole state for the UI. */
  read(): Promise<AppState>;

  /** Persist edits made on this device and queue them for push. */
  applyLocal(ops: Op[]): Promise<void>;

  /**
   * Merge ops from the server and advance the cursor. Returns true if any op
   * won its merge — the caller re-renders only when something actually changed,
   * so a reconnect that replays known ops doesn't churn the UI.
   */
  applyRemote(ops: StampedOp[], cursor: number): Promise<boolean>;

  /** Queued local edits, oldest first. */
  pending(): Promise<StampedOp[]>;

  /** Drop acked ops from the outbox. */
  ackThrough(outboxSeq: number): Promise<void>;

  /** Last server seq durably applied. */
  cursor(): Promise<number>;

  /** Forget the cursor — used when the server identity changes and our seq
   *  numbers no longer refer to the same stream. */
  resetCursor(): Promise<void>;

  close(): Promise<void>;
}
