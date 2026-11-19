/**
 * AppState -> ops.
 *
 * The bridge that lets the existing reducer keep its job. Components dispatch
 * the same typed actions they always did and the reducer produces a whole new
 * AppState; this module compares the state before and after and emits one op
 * per row that actually changed. Nothing in the UI has to know about rows,
 * stamps, or sync.
 *
 * The cost of the approach is an O(size-of-state) walk per dispatch. For a
 * planner holding a few hundred tasks that is microseconds, and it buys us a
 * persistence layer that can't drift out of step with the reducer — every edit
 * is diffed from the same source of truth the UI renders.
 */
import type { Clock, Op } from "@planner/contracts";
import type { AppState } from "@planner/core";
import type { Entry } from "./assemble";
import {
  epicPayload,
  helperPayload,
  inclusionId,
  inclusionPayload,
  memberPayload,
  planPayload,
  projectPayload,
  taskPayload,
  teamPayload,
  trackerPayload,
  type Payload,
} from "./rows";
import type { EntityKind } from "@planner/contracts";
import { assemble } from "./assemble";

/** Key-sorted JSON, so two payloads built in different orders still compare
 *  equal. Payload values are plain JSON — no cycles, no undefined survivors. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** Every syncable row implied by an AppState, keyed "<entity>:<id>". */
export function flattenState(state: AppState): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const put = (entity: EntityKind, id: string, payload: Payload) =>
    out.set(`${entity}:${id}`, { entity, id, payload });

  state.teams.forEach((team, ti) => {
    put("team", team.id, teamPayload(team, ti));
    team.members.forEach((m, mi) => {
      put(
        "member",
        m.id,
        memberPayload(m, team.id, mi, team.offDays[m.id] ?? []),
      );
    });
  });

  state.projects.forEach((project, pi) => {
    put("project", project.id, projectPayload(project, pi));
    put("plan", project.id, planPayload(project.plan));

    project.epics.forEach((epic, ei) => {
      const assigned = project.epicAssignments?.[epic.id] ?? [];
      put("epic", epic.id, epicPayload(epic, project.id, ei, assigned));
      epic.tasks.forEach((task, tiIdx) => {
        put("task", task.id, taskPayload(task, epic.id, project.id, tiIdx));
      });
    });

    (project.helpers ?? []).forEach((h, hi) => {
      put("helper", h.id, helperPayload(h, project.id, hi));
    });

    (project.teamInclusions ?? []).forEach((inc, ii) => {
      const id = inclusionId(project.id, inc.teamId);
      put("team_inclusion", id, inclusionPayload(inc, project.id, ii));
    });
  });

  // Top-level, like projects and teams: a tracker names a project but does not
  // belong to one, and it keeps working (showing raw Jira numbers) when no
  // baseline project is chosen at all.
  (state.trackers ?? []).forEach((tracker, ti) => {
    put("tracker", tracker.id, trackerPayload(tracker, ti));
  });

  return out;
}

/**
 * Ops that carry `prev` to `next`. Order is creates/updates first, tombstones
 * last, so a peer applying the batch never briefly sees a task whose epic is
 * already gone.
 */
export function diffStates(prev: AppState, next: AppState, clock: Clock): Op[] {
  const before = flattenState(prev);
  const after = flattenState(next);
  const changes: Op[] = [];
  const removals: Op[] = [];

  for (const [key, entry] of after) {
    const old = before.get(key);
    if (old && stable(old.payload) === stable(entry.payload)) continue;
    changes.push({
      entity: entry.entity,
      id: entry.id,
      hlc: clock.tick(),
      deleted: false,
      data: entry.payload,
    });
  }

  for (const [key, entry] of before) {
    if (after.has(key)) continue;
    removals.push({
      entity: entry.entity,
      id: entry.id,
      hlc: clock.tick(),
      deleted: true,
      data: null,
    });
  }

  return [...changes, ...removals];
}

/** Every row of a state as a create op — used to seed an empty database and to
 *  land an imported JSON export. */
export function snapshotOps(state: AppState, clock: Clock): Op[] {
  return [...flattenState(state).values()].map((e) => ({
    entity: e.entity,
    id: e.id,
    hlc: clock.tick(),
    deleted: false,
    data: e.payload,
  }));
}

/**
 * The state as the database would hand it back.
 *
 * Round-tripping through rows is lossy in exactly one harmless way: a
 * collection that is present-but-empty (`helpers: []`) is indistinguishable
 * from an absent one, and the model already treats those as the same thing.
 * Use this to compare an in-memory state with a persisted one without tripping
 * over that difference.
 */
export function canonicalState(state: AppState): AppState {
  return assemble(flattenState(state).values());
}
