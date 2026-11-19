/**
 * The tag mappings last used to build a plan from Jira, kept on this device.
 *
 * Remembered so the next import starts from them rather than from nothing. Kept
 * apart from the Jira settings because disconnecting Jira wipes those, and a
 * vocabulary of tags has nothing to do with a token. Every accessor swallows
 * its errors, for the same reason `jiraSettings.ts` does.
 */
import type { TagAlias } from "@planner/jira";

export const TAG_ALIASES_KEY = "planner_tag_aliases_v1";

function coerce(value: unknown): TagAlias[] {
  if (!Array.isArray(value)) return [];
  const out: TagAlias[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const { tag, specialization } = row as Record<string, unknown>;
    if (typeof tag !== "string" || typeof specialization !== "string") continue;
    if (!tag.trim() || !specialization.trim()) continue;
    out.push({ tag: tag.trim(), specialization: specialization.trim() });
  }
  return out;
}

export function readTagAliases(): TagAlias[] {
  try {
    const raw = localStorage.getItem(TAG_ALIASES_KEY);
    return raw ? coerce(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Saves the complete rows; blank ones are dropped. */
export function writeTagAliases(aliases: TagAlias[]): void {
  try {
    localStorage.setItem(TAG_ALIASES_KEY, JSON.stringify(coerce(aliases)));
  } catch {
    // Storage full or blocked: the next import simply starts empty.
  }
}
