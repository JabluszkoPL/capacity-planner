/**
 * One-time import of data from the original localStorage-only Planner.
 *
 * The previous app kept everything under `planner_state_v1`. Anyone opening
 * this version on the same origin should find their projects already here
 * rather than an empty app, so on a first run — and only when the local
 * database is genuinely empty — we lift that blob across.
 *
 * The old key is left untouched. If this version turns out not to work for
 * them, the original app still opens on its own data.
 */
import { isValidAppState, migrateState, type AppState } from "@planner/core";

export const LEGACY_KEY = "planner_state_v1";
/** Set once we have looked, so a user who deletes everything isn't re-seeded. */
const IMPORTED_FLAG = "planner_legacy_imported";

export function readLegacyState(): AppState | null {
  try {
    if (localStorage.getItem(IMPORTED_FLAG) === "1") return null;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = migrateState(JSON.parse(raw));
    return isValidAppState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function markLegacyImported(): void {
  try {
    localStorage.setItem(IMPORTED_FLAG, "1");
  } catch {
    // Best-effort. Worst case we re-check next launch and find the database
    // non-empty, which short-circuits the import anyway.
  }
}
