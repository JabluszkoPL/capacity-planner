/**
 * The unit of synchronisation.
 *
 * Sync granularity is per-row, and these are the rows. Two devices editing
 * different tasks in the same epic merge cleanly; two devices editing the *same*
 * task concurrently resolve last-write-wins, which is the right trade-off for a
 * single user across their own machines.
 *
 * Collections that only ever make sense as a set owned by one parent — a
 * member's off-days, a task's dependsOn, a project's epic assignments — are NOT
 * separate entities. They travel inside their parent row's payload and are
 * replaced wholesale when the parent wins. Splitting them out would buy
 * finer merges at the cost of a much larger surface where a half-applied merge
 * could produce a shape the scheduler rejects.
 *
 * `tracker` follows the same rule: its snapshot, samples, epic map and sprint
 * draft all travel inside the tracker row. PROTOCOL_VERSION is deliberately
 * *not* bumped for it — an older server relays an unknown kind's rows without
 * inspecting them, and an older client ignores a kind it does not know, so a
 * mixed fleet degrades to "no trackers on the old device" rather than to a
 * refused connection.
 */
export const ENTITY_KINDS = [
  "project",
  "epic",
  "task",
  "helper",
  "team_inclusion",
  "team",
  "member",
  "plan",
  "tracker",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export function isEntityKind(v: unknown): v is EntityKind {
  return (
    typeof v === "string" && (ENTITY_KINDS as readonly string[]).includes(v)
  );
}

/**
 * One row's state at one point in time.
 *
 * `data` is null exactly when `deleted` is true — a tombstone carries no
 * payload, only the stamp proving when the delete happened. Tombstones are kept
 * (not vacuumed) because a device that has been offline for a week must be able
 * to learn that a project it still holds was deleted.
 */
export interface Op {
  entity: EntityKind;
  /** Client-generated id — stable from the moment the row is created offline. */
  id: string;
  /** HLC stamp of the edit. Total order; see ./hlc. */
  hlc: string;
  deleted: boolean;
  data: Record<string, unknown> | null;
}

/** An Op after the server has assigned it a place in the global stream. */
export interface StampedOp extends Op {
  /** Monotonic, server-assigned. Clients pull with "everything after N". */
  seq: number;
}

export function isOp(v: unknown): v is Op {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isEntityKind(o.entity)) return false;
  if (typeof o.id !== "string" || o.id.length === 0) return false;
  if (typeof o.hlc !== "string" || o.hlc.length < 19) return false;
  if (typeof o.deleted !== "boolean") return false;
  if (o.deleted) return o.data === null || o.data === undefined;
  return typeof o.data === "object" && o.data !== null;
}
