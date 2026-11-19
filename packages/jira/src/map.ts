import type {
  JiraEpic,
  JiraEpicTotals,
  JiraFieldIds,
  JiraIssue,
  JiraSnapshot,
  JiraStatusCategory,
} from "@planner/core";

/**
 * Jira JSON in, the flat shapes from `@planner/core` out.
 *
 * Two rules drive everything here.
 *
 * **Nothing is trusted.** Every field is optional as far as this code is
 * concerned: permissions hide fields, a custom field can be absent from a
 * project's screen, time tracking can be off entirely, and a search response
 * only carries the fields we asked for. A missing field yields an absent
 * property, never a thrown error and never `NaN` — one odd issue must not fail
 * a refresh of four hundred.
 *
 * **Totals are computed, never read.** Jira publishes `aggregatetimeestimate`
 * and friends, but those include the epic's own estimate and every level below
 * it, so trusting them double-counts as soon as anyone estimates an epic.
 * Totals here are sums over the children this refresh actually fetched, and a
 * child in the `done` category contributes zero remaining whatever its
 * remaining-estimate field says — a closed issue with a stale estimate is the
 * single most common way a "remaining" number lies.
 */

const DONE_CATEGORIES: Record<string, JiraStatusCategory> = {
  new: "new",
  indeterminate: "indeterminate",
  done: "done",
};

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The Sprint field is an array (an issue can have been in several), so the
 * useful single name is the active one, else the last one it was in.
 * Very old instances return Greenhopper's `...,name=Sprint 4,...` strings
 * instead of objects, which is cheap enough to keep working.
 */
function sprintName(value: unknown): string | undefined {
  const entries = Array.isArray(value) ? value : [value];
  let last: string | undefined;
  let active: string | undefined;
  for (const entry of entries) {
    const row = obj(entry);
    if (row) {
      const name = str(row.name);
      if (!name) continue;
      last = name;
      if (str(row.state)?.toLowerCase() === "active") active = name;
      continue;
    }
    const text = str(entry);
    if (!text) continue;
    const legacy = /(?:^|,)name=([^,\]]+)/.exec(text);
    last = legacy ? legacy[1] : text;
    if (/state=ACTIVE/i.test(text)) active = last;
  }
  return active ?? last;
}

function statusCategoryOf(status: Record<string, unknown> | undefined) {
  const key = str(obj(status?.statusCategory)?.key)?.toLowerCase();
  // Jira also uses the category key "undefined"; that and anything new map to
  // "new", which is the safe answer — only "done" is allowed to mean finished.
  return (key && DONE_CATEGORIES[key]) || "new";
}

/**
 * One raw issue (from `/issue/{key}` or a search page) flattened.
 *
 * Story Points is requested (it is in {@link issueFieldList}) but has nowhere
 * to live on `JiraIssue`: tracking measures days, not points. It is fetched so
 * the sprint-planning UI can read it off the raw response later.
 */
export function mapIssue(raw: unknown, fieldIds: JiraFieldIds): JiraIssue {
  const row = obj(raw) ?? {};
  const fields = obj(row.fields) ?? {};
  const status = obj(fields.status);
  const assignee = obj(fields.assignee);
  const accountId = str(assignee?.accountId);

  const issue: JiraIssue = {
    key: str(row.key) ?? "",
    summary: str(fields.summary) ?? "",
    issueType: str(obj(fields.issuetype)?.name) ?? "",
    status: str(status?.name) ?? "",
    statusCategory: statusCategoryOf(status),
    updated: str(fields.updated) ?? "",
  };

  if (accountId) {
    issue.assignee = {
      accountId,
      displayName: str(assignee?.displayName) ?? accountId,
    };
  }
  const parentKey = str(obj(fields.parent)?.key);
  if (parentKey) issue.parentKey = parentKey;

  const original = num(fields.timeoriginalestimate);
  if (original !== undefined) issue.originalEstimateSec = original;
  const remaining = num(fields.timeestimate);
  if (remaining !== undefined) issue.remainingEstimateSec = remaining;
  const spent = num(fields.timespent);
  if (spent !== undefined) issue.timeSpentSec = spent;

  const start = fieldIds.startDate
    ? str(fields[fieldIds.startDate])
    : undefined;
  if (start) issue.startDate = start;
  const due = str(fields.duedate);
  if (due) issue.dueDate = due;
  const resolved = str(fields.resolutiondate);
  if (resolved) issue.resolutionDate = resolved;
  const sprint = fieldIds.sprint
    ? sprintName(fields[fieldIds.sprint])
    : undefined;
  if (sprint) issue.sprint = sprint;
  const team = fieldIds.team ? teamName(fields[fieldIds.team]) : undefined;
  if (team) issue.team = team;
  if (Array.isArray(fields.labels)) {
    const labels = fields.labels.filter(
      (l): l is string => typeof l === "string" && l.trim() !== "",
    );
    if (labels.length > 0) issue.labels = labels;
  }

  return issue;
}

/**
 * The name in a "Team" field. Atlassian's team field is an object with `name`
 * (and `title`); a plain text team field is just the string.
 */
function teamName(value: unknown): string | undefined {
  const row = obj(value);
  const name = row ? (str(row.name) ?? str(row.title)) : str(value);
  return name?.trim() || undefined;
}

/**
 * Classic projects put an issue's epic on the "Epic Link" custom field rather
 * than on `parent`, and that field's id differs per site. Resolving it by name
 * would cost another round trip for a field that is only ever read, so instead
 * we look for any string field on the issue whose value is one of the epic keys
 * this refresh asked about. Nothing else on an issue can accidentally hold an
 * epic key we just queried for, so the match is safe and needs no id.
 */
function epicLinkKey(raw: unknown, epicKeys: Set<string>): string | undefined {
  const fields = obj(obj(raw)?.fields);
  if (!fields) return undefined;
  for (const value of Object.values(fields)) {
    if (typeof value === "string" && epicKeys.has(value)) return value;
  }
  return undefined;
}

function totalsOf(children: JiraIssue[]): JiraEpicTotals {
  const totals: JiraEpicTotals = {
    originalSec: 0,
    spentSec: 0,
    remainingSec: 0,
    done: 0,
    all: children.length,
  };
  for (const child of children) {
    totals.originalSec += child.originalEstimateSec ?? 0;
    totals.spentSec += child.timeSpentSec ?? 0;
    if (child.statusCategory === "done") {
      totals.done += 1;
      continue; // finished work has no remaining, whatever the field says.
    }
    // Jira mirrors the original estimate into the remaining one when work is
    // first estimated, so the fallback almost never fires; when it does (the
    // remaining field is hidden or was cleared) the original is a far better
    // guess than treating the issue as free.
    totals.remainingSec +=
      child.remainingEstimateSec ?? child.originalEstimateSec ?? 0;
  }
  return totals;
}

/**
 * Assemble one refresh: raw initiative, raw epics and the raw children of all
 * of them, grouped and totalled.
 *
 * Children whose epic is not among `epics` are dropped — they can only come
 * from the `Epic Link` half of the query matching something outside the
 * initiative, and an orphan has no row to appear in.
 */
export function buildSnapshot(
  initiative: unknown,
  epics: unknown[],
  children: unknown[],
  fieldIds: JiraFieldIds,
  fetchedAt: string,
): JiraSnapshot {
  const mappedEpics = epics.map((raw) => mapIssue(raw, fieldIds));
  const epicKeys = new Set(mappedEpics.map((e) => e.key).filter((k) => k));
  const byEpic = new Map<string, JiraIssue[]>();
  const seen = new Set<string>();

  for (const raw of children) {
    const child = mapIssue(raw, fieldIds);
    if (child.key === "" || seen.has(child.key)) continue; // pages can overlap
    const parent =
      child.parentKey && epicKeys.has(child.parentKey)
        ? child.parentKey
        : epicLinkKey(raw, epicKeys);
    if (!parent) continue;
    seen.add(child.key);
    const bucket = byEpic.get(parent);
    if (bucket) bucket.push(child);
    else byEpic.set(parent, [child]);
  }

  const withChildren: JiraEpic[] = mappedEpics.map((epic) => {
    const kids = byEpic.get(epic.key) ?? [];
    return { ...epic, children: kids, totals: totalsOf(kids) };
  });

  return {
    fetchedAt,
    initiative: mapIssue(initiative, fieldIds),
    epics: withChildren,
    fieldIds,
  };
}

/** Hours in a Planner day when a tracker does not say (`Tracker.hoursPerDay`). */
export const DEFAULT_HOURS_PER_DAY = 8;

function workHours(hoursPerDay: number | undefined): number {
  return typeof hoursPerDay === "number" &&
    Number.isFinite(hoursPerDay) &&
    hoursPerDay > 0
    ? hoursPerDay
    : DEFAULT_HOURS_PER_DAY;
}

/**
 * Jira seconds -> Planner days, unrounded (callers round for display, and
 * rounding here would make totals drift from the sum of their parts).
 */
export function secondsToDays(sec: number, hoursPerDay?: number): number {
  if (!Number.isFinite(sec)) return 0;
  return sec / (workHours(hoursPerDay) * 3600);
}

/**
 * Planner days -> a Jira duration string such as `"2d 4h"` or `"6h"`.
 *
 * Assumption worth stating: Jira's own "day" for time tracking is a site-wide
 * setting (8h out of the box), and this uses the tracker's `hoursPerDay` as
 * that number. If a site is configured for a 7.5-hour day and the tracker says
 * 8, a written duration is off by that ratio — which is why hours-per-day is a
 * visible setting rather than a constant.
 */
export function daysToJiraDuration(days: number, hoursPerDay?: number): string {
  const perDay = workHours(hoursPerDay);
  const minutes = Number.isFinite(days)
    ? Math.max(0, Math.round(days * perDay * 60))
    : 0;
  if (minutes === 0) return "0h";
  const perDayMinutes = perDay * 60;
  const d = Math.floor(minutes / perDayMinutes);
  const h = Math.floor((minutes - d * perDayMinutes) / 60);
  const m = minutes - d * perDayMinutes - h * 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.join(" ");
}
