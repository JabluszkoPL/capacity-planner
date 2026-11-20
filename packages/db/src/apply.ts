/**
 * Reading and writing the synced tables.
 *
 * Two write paths, one merge rule:
 *  - `applyLocalOp`  — an edit made on this device. Marks the row dirty and
 *                      appends to the outbox so the sync client can push it.
 *  - `applyRemoteOp` — an op that arrived from the server. Same LWW comparison,
 *                      but does not touch the outbox.
 *
 * The merge rule is: the op wins if and only if its HLC is strictly greater
 * than the stamp already on the row. Strictly, so replaying the same op is a
 * no-op — which matters, because a client that reconnects mid-push will resend
 * ops the server already has.
 */
import {
  compareHlc,
  type EntityKind,
  type Op,
  type StampedOp,
} from "@planner/contracts";
import type { AppState } from "@planner/core";
import type { SqlValue, SqliteDriver } from "./driver";
import { DESCRIPTORS, inclusionId, type Row } from "./rows";
import { assemble, type Entry } from "./assemble";

/** Rows carry `dirty` only on clients; the server ignores it. */
type WriteMode = "local" | "remote";

function upsert(db: SqliteDriver, op: Op, mode: WriteMode): boolean {
  const d = DESCRIPTORS[op.entity];
  if (!d) return false;

  const existing = db.get<{ hlc: string }>(
    `SELECT hlc FROM ${d.table} WHERE id = ?`,
    [op.id],
  );
  if (existing && compareHlc(op.hlc, existing.hlc) <= 0) return false;

  const dirty = mode === "local" ? 1 : 0;

  if (op.deleted) {
    if (existing) {
      db.run(
        `UPDATE ${d.table} SET deleted = 1, hlc = ?, dirty = ? WHERE id = ?`,
        [op.hlc, dirty, op.id],
      );
    } else {
      // A tombstone for a row we never saw: record it so we don't later accept
      // a stale create for the same id.
      //
      // Every data column is written, from an empty payload, because some
      // tables have NOT NULL parent columns with no default (epics.project_id,
      // tasks.epic_id, members.team_id, ...). Inserting only id/hlc used to
      // throw for those, and a client produces exactly this op whenever it
      // creates and deletes a row before pushing: the outbox keeps only the
      // tombstone. The values are never read — tombstones are filtered out.
      const blank = d.toRow({});
      const cols = d.columns;
      db.run(
        `INSERT INTO ${d.table} (id, ${cols.join(", ")}, hlc, deleted, dirty)
         VALUES (?, ${cols.map(() => "?").join(", ")}, ?, 1, ?)`,
        [op.id, ...cols.map((c) => blank[c] ?? null), op.hlc, dirty],
      );
    }
    return true;
  }

  const row = d.toRow(op.data ?? {});
  const cols = d.columns;
  const placeholders = cols.map(() => "?").join(", ");
  const assignments = cols.map((c) => `${c} = excluded.${c}`).join(", ");
  const values: SqlValue[] = [
    op.id,
    ...cols.map((c) => row[c] ?? null),
    op.hlc,
    dirty,
  ];
  db.run(
    `INSERT INTO ${d.table} (id, ${cols.join(", ")}, hlc, deleted, dirty)
     VALUES (?, ${placeholders}, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET ${assignments},
       hlc = excluded.hlc, deleted = 0, dirty = excluded.dirty`,
    values,
  );
  return true;
}

/** Apply an op that arrived from the server. True if it won the merge. */
export function applyRemoteOp(db: SqliteDriver, op: Op): boolean {
  return upsert(db, op, "remote");
}

/**
 * Apply an edit made on this device and queue it for push.
 *
 * The queue is compacted as it goes: because merging is last-write-wins per
 * row, an older queued op for the same row can never affect the outcome, so it
 * is replaced rather than accumulated. That keeps the outbox bounded by the
 * number of rows the device has touched instead of by how many times it touched
 * them — which matters most for someone running with no server at all, whose
 * outbox would otherwise grow without limit.
 *
 * Replacing an op that is already in flight is safe: the pushed batch was read
 * before this call, and the replacement carries a higher seq, so the incoming
 * ack (which clears only up to the seq it was given) leaves it queued for the
 * next round.
 */
export function applyLocalOp(db: SqliteDriver, op: Op): boolean {
  const won = upsert(db, op, "local");
  if (!won) return false;
  db.run("DELETE FROM oplog WHERE entity = ? AND entity_id = ?", [
    op.entity,
    op.id,
  ]);
  appendToLog(db, op, "local");
  return true;
}

/** Append to the durable stream. Returns the assigned seq. */
export function appendToLog(db: SqliteDriver, op: Op, origin: string): number {
  db.run(
    `INSERT INTO oplog (entity, entity_id, hlc, deleted, data, origin)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      op.entity,
      op.id,
      op.hlc,
      op.deleted ? 1 : 0,
      op.data === null || op.data === undefined
        ? null
        : JSON.stringify(op.data),
      origin,
    ],
  );
  const row = db.get<{ seq: number }>("SELECT last_insert_rowid() AS seq");
  return Number(row?.seq ?? 0);
}

function rowToStampedOp(r: Row): StampedOp {
  const deleted = r.deleted === 1 || r.deleted === 1n;
  return {
    seq: Number(r.seq),
    entity: String(r.entity) as EntityKind,
    id: String(r.entity_id),
    hlc: String(r.hlc),
    deleted,
    data:
      deleted || typeof r.data !== "string"
        ? null
        : (JSON.parse(r.data) as Record<string, unknown>),
  };
}

/** Ops with seq > `since`, oldest first. */
export function readOpsSince(
  db: SqliteDriver,
  since: number,
  limit: number,
): StampedOp[] {
  const rows = db.all<Row>(
    "SELECT * FROM oplog WHERE seq > ? ORDER BY seq ASC LIMIT ?",
    [since, limit],
  );
  return rows.map(rowToStampedOp);
}

/** The head of the log. */
export function headSeq(db: SqliteDriver): number {
  const row = db.get<{ seq: number | null }>(
    "SELECT MAX(seq) AS seq FROM oplog",
  );
  return Number(row?.seq ?? 0);
}

/** A client's unsynced outbox, oldest first. */
export function pendingOps(db: SqliteDriver): StampedOp[] {
  const rows = db.all<Row>("SELECT * FROM oplog ORDER BY seq ASC");
  return rows.map(rowToStampedOp);
}

/** Drop acked ops from the outbox and clear the dirty flags they set. */
export function clearPending(db: SqliteDriver, throughSeq: number): void {
  db.transaction(() => {
    const acked = db.all<Row>(
      "SELECT entity, entity_id, hlc FROM oplog WHERE seq <= ?",
      [throughSeq],
    );
    for (const a of acked) {
      const d = DESCRIPTORS[String(a.entity) as EntityKind];
      if (!d) continue;
      // Only clear dirty if the row hasn't been edited again since this op.
      db.run(`UPDATE ${d.table} SET dirty = 0 WHERE id = ? AND hlc = ?`, [
        String(a.entity_id),
        String(a.hlc),
      ]);
    }
    db.run("DELETE FROM oplog WHERE seq <= ?", [throughSeq]);
  });
}

// ------------------------------------------------------------- assembly ----

/** Live (non-tombstoned) rows of one table, as entries. */
function entriesOf(db: SqliteDriver, kind: EntityKind): Entry[] {
  const d = DESCRIPTORS[kind];
  const rows = db.all<Row>(`SELECT * FROM ${d.table} WHERE deleted = 0`);
  return rows.map((r) => ({
    entity: kind,
    id: String(r.id),
    payload: d.fromRow(r),
  }));
}

/**
 * Materialise the full AppState the UI works with.
 *
 * This is the read side of the whole persistence layer: the reducer and every
 * component keep operating on a plain AppState exactly as they did against
 * localStorage, and never learn that a database exists.
 */
export function readAppState(db: SqliteDriver): AppState {
  const entries: Entry[] = [];
  for (const kind of Object.keys(DESCRIPTORS) as EntityKind[]) {
    entries.push(...entriesOf(db, kind));
  }
  return assemble(entries);
}

export { inclusionId };
