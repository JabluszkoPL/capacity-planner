import type { AppState } from "./types";
import { newId } from "./ids";

/**
 * Bring older persisted/imported shapes up to the current model. Currently:
 * the pre-multi-team shape had a single `team: { members, offDays }`; fold it
 * into `teams: [{ id, name: "Team 1", members, offDays }]`. Idempotent — a
 * value already carrying `teams` is returned untouched. Never throws.
 */
export function migrateState(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.teams)) return value; // already current
  if (
    typeof v.team === "object" &&
    v.team !== null &&
    Array.isArray((v.team as Record<string, unknown>).members)
  ) {
    const team = v.team as Record<string, unknown>;
    const { team: _drop, ...rest } = v;
    return {
      ...rest,
      teams: [
        {
          id: newId(),
          name: "Team 1",
          members: team.members,
          offDays: team.offDays ?? {},
        },
      ],
    };
  }
  return value;
}

/** True if the parsed value has the minimum shape of an AppState. */
export function isValidAppState(value: unknown): value is AppState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.projects)) return false;
  if (!Array.isArray(v.teams)) return false;
  for (const t of v.teams) {
    if (typeof t !== "object" || t === null) return false;
    const team = t as Record<string, unknown>;
    if (!Array.isArray(team.members)) return false;
    if (typeof team.offDays !== "object" || team.offDays === null) return false;
  }
  // Trackers are optional (absent on anything saved before tracking existed).
  // When present, only the fields the app cannot work without are required —
  // a snapshot is derived data and a malformed one should cost you a refresh,
  // not your whole file.
  if (v.trackers !== undefined) {
    if (!Array.isArray(v.trackers)) return false;
    for (const t of v.trackers) {
      if (typeof t !== "object" || t === null) return false;
      const tracker = t as Record<string, unknown>;
      if (typeof tracker.id !== "string" || tracker.id.length === 0) {
        return false;
      }
      if (typeof tracker.name !== "string") return false;
      if (
        typeof tracker.initiativeKey !== "string" ||
        tracker.initiativeKey.length === 0
      ) {
        return false;
      }
      if (typeof tracker.baseUrl !== "string") return false;
      if (tracker.samples !== undefined && !Array.isArray(tracker.samples)) {
        return false;
      }
      if (
        tracker.epicMap !== undefined &&
        (typeof tracker.epicMap !== "object" || tracker.epicMap === null)
      ) {
        return false;
      }
      if (
        tracker.taskMap !== undefined &&
        (typeof tracker.taskMap !== "object" || tracker.taskMap === null)
      ) {
        return false;
      }
      if (
        tracker.addedScope !== undefined &&
        (typeof tracker.addedScope !== "object" ||
          tracker.addedScope === null ||
          Object.values(tracker.addedScope).some((s) => typeof s !== "string"))
      ) {
        return false;
      }
      if (
        tracker.untrackedEpics !== undefined &&
        (!Array.isArray(tracker.untrackedEpics) ||
          tracker.untrackedEpics.some((k) => typeof k !== "string"))
      ) {
        return false;
      }
      if (
        tracker.viewTeams !== undefined &&
        (!Array.isArray(tracker.viewTeams) ||
          tracker.viewTeams.some((k) => typeof k !== "string"))
      ) {
        return false;
      }
      if (
        tracker.taskTeams !== undefined &&
        (typeof tracker.taskTeams !== "object" ||
          tracker.taskTeams === null ||
          Array.isArray(tracker.taskTeams) ||
          Object.values(tracker.taskTeams).some((v) => typeof v !== "string"))
      ) {
        return false;
      }
    }
  }
  return true;
}
