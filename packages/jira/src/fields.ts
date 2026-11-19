import type { JiraFieldIds } from "@planner/core";

/**
 * Finding the custom fields this integration needs on *this* Jira site.
 *
 * Start date, Sprint and Story Points are custom fields, and their ids differ
 * per site — `customfield_10015` on one instance is something else on another.
 * So they are discovered by name from `GET /rest/api/3/field` rather than
 * hard-coded, and the resolved ids are stored in the snapshot so a later
 * write-back sets exactly the fields that snapshot read.
 *
 * The known ids are still kept as a last resort: a site that renames "Start
 * date" (or a token whose scope cannot list fields) should degrade to "probably
 * right" rather than to "no dates at all", and a wrong guess costs nothing —
 * an unknown field id simply comes back absent on every issue.
 *
 * The input is untrusted JSON straight off the wire, so every step is defensive.
 */

/** Ids used when no field matches by name. */
export const FALLBACK_FIELD_IDS: Required<JiraFieldIds> = {
  startDate: "customfield_10015",
  sprint: "customfield_10020",
  storyPoints: "customfield_10037",
  // Atlassian's own "Team" field, which every Cloud site has under this id.
  team: "customfield_10001",
};

const START_DATE_NAMES = ["start date"];
const SPRINT_NAMES = ["sprint"];
const STORY_POINT_NAMES = ["story points", "story point estimate"];
const TEAM_NAMES = ["team"];

interface FieldRow {
  id: string;
  name: string;
  custom: boolean;
}

function normaliseName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : "";
}

function toRows(fieldList: unknown): FieldRow[] {
  if (!Array.isArray(fieldList)) return [];
  const rows: FieldRow[] = [];
  for (const entry of fieldList) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : "";
    const name = normaliseName(raw.name);
    if (id === "" || name === "") continue;
    rows.push({
      id,
      name,
      custom: raw.custom === true || id.startsWith("customfield_"),
    });
  }
  return rows;
}

/**
 * Custom fields win over system fields with the same display name: some sites
 * expose a read-only system field whose name collides ("Start date" on a
 * team-managed project), and the writable custom one is the one we want.
 */
function pick(rows: FieldRow[], names: string[]): string | undefined {
  const matches = rows.filter((r) => names.includes(r.name));
  if (matches.length === 0) return undefined;
  const custom = matches.find((r) => r.custom);
  return (custom ?? matches[0]).id;
}

/** Resolve the custom field ids from a `/rest/api/3/field` response body. */
export function resolveFieldIds(fieldList: unknown): JiraFieldIds {
  const rows = toRows(fieldList);
  return {
    startDate: pick(rows, START_DATE_NAMES) ?? FALLBACK_FIELD_IDS.startDate,
    sprint: pick(rows, SPRINT_NAMES) ?? FALLBACK_FIELD_IDS.sprint,
    storyPoints:
      pick(rows, STORY_POINT_NAMES) ?? FALLBACK_FIELD_IDS.storyPoints,
    team: pick(rows, TEAM_NAMES) ?? FALLBACK_FIELD_IDS.team,
  };
}
