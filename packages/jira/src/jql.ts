import type { JiraFieldIds } from "@planner/core";
import { isIssueKey } from "./link";

/**
 * The queries, in one place.
 *
 * Two things make this worth its own module. First, there is no single way to
 * ask Jira "what are this initiative's epics": a company-managed hierarchy
 * answers `parent = KEY`, an Advanced-Roadmaps hierarchy answers
 * `"Parent Link" = KEY`, and a team that wires initiatives up with issue links
 * answers neither — so the caller tries candidates in order until one returns
 * rows. Second, the search endpoint itself moved (`/rest/api/3/search` with
 * `startAt` is deprecated in favour of `/rest/api/3/search/jql` with token
 * pagination), and hiding the query shapes here keeps that a one-file change.
 *
 * Keys are validated, never escaped: a Jira key matches
 * `[A-Z][A-Z0-9_]+-\d+`, which contains no quote, space or operator, so a
 * validated key cannot terminate a string literal or inject a clause. Anything
 * that fails validation is rejected rather than quoted, because a "key" with a
 * quote in it is not a key and there is no sane query to build from it.
 */

/** Fields every issue is fetched with, before site-specific custom fields. */
export const BASE_ISSUE_FIELDS = [
  "summary",
  "issuetype",
  "status",
  "assignee",
  "parent",
  "timeoriginalestimate",
  "timeestimate",
  "timespent",
  "duedate",
  "resolutiondate",
  "labels",
  "priority",
  "updated",
] as const;

/** Largest number of epic keys per children query (two `in (…)` lists). */
export const EPIC_CHUNK_SIZE = 50;

function assertKey(key: string): string {
  if (!isIssueKey(key)) {
    throw new RangeError(`Not a Jira issue key: ${JSON.stringify(key)}`);
  }
  return key;
}

/**
 * The three ways an initiative's epics can hang off it, most common first.
 * The caller runs them in order and keeps the first that returns rows.
 */
export function initiativeEpicsJqlCandidates(key: string): string[] {
  const k = assertKey(key);
  return [
    `parent = ${k}`,
    `"Parent Link" = ${k}`,
    `issue in linkedIssues("${k}", "initiates")`,
  ];
}

/**
 * Children of several epics in one query. Both forms are asked for at once
 * because a site can hold a mix: team-managed projects use `parent`, older
 * company-managed ones still use the `Epic Link` field.
 */
export function epicChildrenJql(keys: string[]): string {
  const valid = keys.map(assertKey);
  if (valid.length === 0) {
    throw new RangeError("epicChildrenJql needs at least one epic key");
  }
  const list = valid.join(", ");
  return `parent in (${list}) OR "Epic Link" in (${list})`;
}

/**
 * The `fields` list for issue and search requests: the fixed set plus whatever
 * custom ids were resolved for this site, de-duplicated and order-stable.
 */
export function issueFieldList(fieldIds: JiraFieldIds): string[] {
  const out: string[] = [...BASE_ISSUE_FIELDS];
  for (const id of [
    fieldIds.startDate,
    fieldIds.sprint,
    fieldIds.storyPoints,
    fieldIds.team,
  ]) {
    if (typeof id === "string" && id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}
