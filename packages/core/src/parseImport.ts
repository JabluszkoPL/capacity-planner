/**
 * Pure parser for paste-from-Google-Sheets import (T07).
 *
 * Accepts pasted text and returns a plan of what to add — it never mutates the
 * project. The caller (PasteImportModal) applies the plan via store actions.
 *
 * Row shapes (tab-separated, or comma-separated as a fallback):
 *   4 cols: Epic, Task, Estimate, Specialization
 *           → creates the epic if it doesn't exist yet, matching existing
 *             epic names case-insensitively.
 *   5 cols: Epic, Task, Estimate, Specialization, TaskDependsOn
 *           → same as 4 cols, plus this task depends on the named task(s).
 *   6 cols: Epic, Task, Estimate, Specialization, TaskDependsOn, EpicDependsOn
 *           → same as 5 cols, plus this task's epic depends on the named
 *             epic(s). Epic dependencies are unioned across the epic's rows.
 *   3 cols: Task, Estimate, Specialization
 *           → added to the target epic chosen in the modal, or a new
 *             "Imported" epic when the target is NEW_EPIC.
 *
 * Dependency cells reference other tasks/epics by name and may list several,
 * separated by ";" or "|" (e.g. "Design screens; Build UI"). Names are
 * resolved to ids by the caller after everything is created. Header rows and
 * malformed/empty lines are skipped rather than crashing.
 */

/** Sentinel target meaning "a new (or existing) 'Imported' epic". */
export const NEW_EPIC = "__new__";
const IMPORTED_EPIC_NAME = "Imported";

export interface ParsedTask {
  name: string;
  estimateDays: number;
  specialization: string;
  /** Names of tasks this task depends on (resolved to ids by the caller). */
  dependsOn: string[];
}

export interface ImportGroup {
  /** Target an existing epic by id, or null to create a new one. */
  existingEpicId: string | null;
  /** Name for a new epic to create, or null when targeting an existing one. */
  newEpicName: string | null;
  /** Names of epics this epic depends on (resolved to ids by the caller). */
  epicDependsOn: string[];
  tasks: ParsedTask[];
}

export interface ImportResult {
  groups: ImportGroup[];
  importedCount: number;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Split a dependency cell into trimmed, non-empty names. */
function splitNames(cell: string | undefined): string[] {
  return (cell ?? "")
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseImport(
  text: string,
  existingEpics: { id: string; name: string }[],
  targetSelection: string,
): ImportResult {
  const lines = text
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const groups: ImportGroup[] = [];
  const byKey = new Map<string, ImportGroup>();
  let importedCount = 0;

  const findByName = (name: string) =>
    existingEpics.find((e) => norm(e.name) === norm(name));

  for (const line of lines) {
    const cols = (line.includes("\t") ? line.split("\t") : line.split(",")).map(
      (c) => c.trim(),
    );

    // Header rows.
    if (/^epic$/i.test(cols[0]) && /^task$/i.test(cols[1] ?? "")) continue;
    if (/^task$/i.test(cols[0])) continue;

    let epicName: string | null;
    let taskName: string;
    let est: string;
    let spec: string;
    let taskDeps: string[] = [];
    let epicDeps: string[] = [];
    if (cols.length >= 4) {
      [epicName, taskName, est, spec] = cols;
      taskDeps = splitNames(cols[4]);
      epicDeps = splitNames(cols[5]);
    } else if (cols.length === 3) {
      epicName = null;
      [taskName, est, spec] = cols;
    } else {
      continue; // too few columns — ignore
    }
    if (!taskName) continue;

    const estimateDays = parseFloat(String(est).replace(",", ".")) || 0;
    const task: ParsedTask = {
      name: taskName,
      estimateDays,
      specialization: (spec ?? "").trim(),
      dependsOn: taskDeps,
    };

    // Resolve the target epic + a grouping key so repeated rows collapse into
    // a single epic.
    let key: string;
    let existingEpicId: string | null = null;
    let newEpicName: string | null = null;

    if (epicName) {
      const existing = findByName(epicName);
      if (existing) {
        existingEpicId = existing.id;
        key = "id:" + existing.id;
      } else {
        newEpicName = epicName;
        key = "new:" + norm(epicName);
      }
    } else if (targetSelection === NEW_EPIC) {
      const existing = findByName(IMPORTED_EPIC_NAME);
      if (existing) {
        existingEpicId = existing.id;
        key = "id:" + existing.id;
      } else {
        newEpicName = IMPORTED_EPIC_NAME;
        key = "new:" + norm(IMPORTED_EPIC_NAME);
      }
    } else {
      const existing = existingEpics.find((e) => e.id === targetSelection);
      if (!existing) continue; // target epic no longer exists
      existingEpicId = existing.id;
      key = "id:" + existing.id;
    }

    let group = byKey.get(key);
    if (!group) {
      group = { existingEpicId, newEpicName, epicDependsOn: [], tasks: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    // Union epic dependencies declared on any of this epic's rows.
    for (const dep of epicDeps) {
      if (!group.epicDependsOn.some((d) => norm(d) === norm(dep))) {
        group.epicDependsOn.push(dep);
      }
    }
    group.tasks.push(task);
    importedCount++;
  }

  return { groups, importedCount };
}
