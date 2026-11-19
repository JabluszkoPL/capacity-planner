import { resolveFieldIds } from "./fields";
import {
  jiraCall,
  JiraError,
  searchIssues,
  type JiraReadOptions,
} from "./refresh";
import type { JiraTransport } from "./transport";

/**
 * Reading Atlassian's Teams directory: the teams people set up under Jira's
 * Teams tab, and who is on each.
 *
 * Three APIs are involved, because no single one answers the question:
 *
 *  - **The organization id.** Every Teams endpoint is scoped by it, and a site
 *    token has no REST call that returns it. The GraphQL gateway's
 *    `tenantContexts` lookup does, given the site's host name, along with the
 *    site's cloud id (which the Teams API calls `siteId`). The query is fixed
 *    text built by {@link tenantQuery}, because the two URL guards accept
 *    exactly that query and nothing else on the GraphQL endpoint.
 *  - **The Teams public API** (`/gateway/api/public/teams/v1/…`) lists the
 *    teams and each team's member account ids.
 *  - **Jira's user lookup** (`/rest/api/3/user/bulk`) turns account ids into
 *    names, since the Teams API returns ids only.
 *
 * The Teams public API is reportedly limited to accounts with
 * organization-level access, so each read has fallbacks that work with an
 * ordinary user's permissions, tried only when the one before is refused:
 *
 *  - **Team list:** site-scoped, then org-wide, then GraphQL `teamSearchV2`.
 *  - **A team's members:** the Teams API, then — for a team synced from a
 *    Jira group — that group's members (`/rest/api/3/group/member`, which
 *    needs only *Browse users and groups*), then GraphQL `teamV2.members`.
 *
 * The GraphQL Teams fields are beta and their member query is not documented
 * in full, so those queries select as little as possible and any GraphQL
 * error is reported in the gateway's own words. Each one is fixed text around
 * validated ids, because the two URL guards accept exactly these shapes.
 *
 * Everything goes through the site's own `/gateway/api/…` path so the host
 * rule in both guards (an `*.atlassian.net` site) is unchanged; only these
 * exact path shapes were added to them.
 *
 * Pure like the rest of this package: the transport is injected and nothing
 * reads the clock.
 */

export interface JiraTenant {
  orgId: string;
  /** The site's cloud id — the Teams API's `siteId`. */
  cloudId?: string;
}

export interface JiraDirectoryTeam {
  /** Atlassian team id. */
  id: string;
  name: string;
  description?: string;
  /** The Jira group the team is synced from, when it is. Its members can
   *  then be read as that group's. */
  groupId?: string;
}

export interface JiraDirectoryPerson {
  accountId: string;
  displayName: string;
  /** Set only when the person came from the team's Jira issues rather than
   *  its roster: how many of those issues are assigned to them. */
  issueCount?: number;
}

export interface TeamsDirectoryOptions extends JiraReadOptions {
  orgId: string;
  /** Include site-scoped teams, which the list omits without it. */
  siteId?: string;
}

const ID = /^[A-Za-z0-9-]+$/;
const TEAMS_ROOT = "/gateway/api/public/teams/v1/org";
const MAX_PAGES = 50;
const USER_CHUNK = 50;

/** True for something that can safely sit in a Teams API path segment. */
export function isTeamsId(value: string): boolean {
  return ID.test(value);
}

function assertId(value: string, what: string): string {
  if (!isTeamsId(value)) throw new RangeError(`Not a valid ${what}: ${value}`);
  return value;
}

/**
 * An organization id as the Teams API wants it. Accepts a bare id, an ARI
 * (`ari:cloud:platform::org/<id>`) or a pasted admin.atlassian.com URL
 * (`…/o/<id>/overview`), since those are the forms people have to hand.
 */
export function parseOrgId(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  const fromUrl = /\/o\/([A-Za-z0-9-]+)/.exec(text);
  if (fromUrl) return fromUrl[1];
  const fromAri = /org\/([A-Za-z0-9-]+)$/.exec(text);
  if (fromAri) return fromAri[1];
  return isTeamsId(text) ? text : null;
}

/** The one GraphQL query the URL guards let through, for one site host. */
export function tenantQuery(host: string): string {
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new RangeError(`Not a site host name: ${host}`);
  }
  return `query PlannerTenant { tenantContexts(hostNames: ["${host}"]) { cloudId orgId } }`;
}

export const GRAPHQL_PATH = "/gateway/api/graphql";

/** Beta programs the Teams GraphQL fields may need. */
export const TEAMS_EXPERIMENTAL = ["teams-beta", "team-members-beta"];

const CURSOR = /^[A-Za-z0-9+/=_:.-]{1,512}$/;

function afterArg(after: string | undefined): string {
  if (after === undefined) return "";
  if (!CURSOR.test(after)) throw new RangeError(`Not a page cursor: ${after}`);
  return `, after: "${after}"`;
}

/** GraphQL team search, one page. `siteId` "None" means org-wide. */
export function teamSearchQuery(
  orgId: string,
  siteId: string,
  after?: string,
): string {
  assertId(orgId, "organization id");
  assertId(siteId, "site id");
  return `query PlannerTeamSearch { team @optIn(to: "Team-search-v2") { teamSearchV2(organizationId: "ari:cloud:platform::org/${orgId}", siteId: "${siteId}", first: 100${afterArg(after)}) { pageInfo { hasNextPage endCursor } edges { node { team { id displayName } } } } } }`;
}

/** GraphQL members of one team, one page. */
export function teamMembersQuery(
  teamId: string,
  siteId: string,
  after?: string,
): string {
  assertId(teamId, "team id");
  assertId(siteId, "site id");
  return `query PlannerTeamMembers { team { teamV2(id: "ari:cloud:identity::team/${teamId}", siteId: "${siteId}") @optIn(to: "Team") { members(first: 50${afterArg(after)}) { pageInfo { hasNextPage endCursor } edges { node { member { accountId } } } } } } }`;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The last segment of an ARI (`ari:cloud:identity::team/<id>` -> `<id>`). */
function bareId(v: unknown): string | undefined {
  const t = text(v);
  if (!t) return undefined;
  const id = t.slice(t.lastIndexOf("/") + 1);
  return isTeamsId(id) ? id : undefined;
}

/**
 * One GraphQL call. The gateway answers a refused or malformed query with
 * HTTP 200 and an `errors` array, so that is turned into the same typed error
 * a REST refusal would be — with the gateway's message, which is the only
 * useful thing to show when a beta field has moved.
 */
async function graphql(
  transport: JiraTransport,
  options: JiraReadOptions,
  operationName: string,
  query: string,
): Promise<Record<string, unknown>> {
  const body = obj(
    await jiraCall(
      transport,
      options,
      GRAPHQL_PATH,
      "POST",
      { operationName, query },
      TEAMS_EXPERIMENTAL,
    ),
  );
  const errors = list(body?.errors);
  const data = obj(body?.data);
  if (errors.length > 0 && !hasValue(data)) {
    const first = obj(errors[0]);
    const message = text(first?.message) ?? "unknown GraphQL error";
    const status = Number(obj(first?.extensions)?.statusCode);
    throw new JiraError(
      status === 401 || status === 403 ? "auth" : "bad-response",
      `Jira rejected the request (GraphQL): ${message}`,
      Number.isFinite(status) ? status : 400,
      undefined,
      GRAPHQL_PATH,
    );
  }
  return data ?? {};
}

/** True when a GraphQL `data` tree holds anything but nulls. */
function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v !== "object") return true;
  return Object.values(v as Record<string, unknown>).some(hasValue);
}

function isRefusal(err: unknown): err is JiraError {
  return (
    err instanceof JiraError &&
    (err.status === 400 ||
      err.status === 403 ||
      err.status === 404 ||
      err.status === 410)
  );
}

/** Several refusals as one error: the first one's kind, everyone's reason. */
function combined(refusals: JiraError[]): JiraError {
  const [first] = refusals;
  if (refusals.length === 1) return first;
  const reasons = refusals.map((r) => {
    const i = r.message.indexOf("): ");
    return i === -1 ? r.message : r.message.slice(i + 3);
  });
  return new JiraError(
    first.kind,
    `Jira rejected the request (HTTP ${first.status}): ${reasons.join("; ")}`,
    first.status,
    undefined,
    first.requestPath,
  );
}

/** Look up the site's organization id (and cloud id) by host name. */
export async function fetchJiraTenant(
  transport: JiraTransport,
  options: JiraReadOptions,
): Promise<JiraTenant | null> {
  const host = new URL(options.baseUrl).hostname.toLowerCase();
  const body = await jiraCall(transport, options, GRAPHQL_PATH, "POST", {
    operationName: "PlannerTenant",
    query: tenantQuery(host),
  });
  const ctx = list(obj(obj(body)?.data)?.tenantContexts).map(obj)[0];
  const orgId = parseOrgId(text(ctx?.orgId) ?? "");
  if (!orgId) return null;
  const cloudId = text(ctx?.cloudId);
  return cloudId && isTeamsId(cloudId) ? { orgId, cloudId } : { orgId };
}

async function listTeamsPages(
  transport: JiraTransport,
  options: TeamsDirectoryOptions,
  siteId: string | undefined,
): Promise<JiraDirectoryTeam[]> {
  const orgId = assertId(options.orgId, "organization id");
  const out: JiraDirectoryTeam[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = ["size=100"];
    if (siteId) params.push(`siteId=${encodeURIComponent(siteId)}`);
    if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
    const body = obj(
      await jiraCall(
        transport,
        options,
        `${TEAMS_ROOT}/${orgId}/teams?${params.join("&")}`,
        "GET",
      ),
    );
    const entities = list(body?.entities);
    for (const raw of entities) {
      const t = obj(raw);
      const id = text(t?.teamId) ?? text(t?.id);
      const name = text(t?.displayName) ?? text(t?.name);
      if (!id || !name) continue;
      // Archived and deleted teams stay in the directory; nobody plans them.
      const state = text(t?.state);
      if (state && state.toUpperCase() !== "ACTIVE") continue;
      const team: JiraDirectoryTeam = { id, name };
      const description = text(t?.description);
      if (description) team.description = description;
      const ref = obj(t?.externalReference);
      const groupId = text(ref?.id);
      if (groupId && text(ref?.source)?.toUpperCase() === "ATLASSIAN_GROUP") {
        team.groupId = groupId;
      }
      out.push(team);
    }
    const next = text(body?.cursor);
    if (!next || entities.length === 0 || next === cursor) break;
    cursor = next;
  }
  return out;
}

/**
 * Every active team in the organization, by name. `siteId` should always be
 * given (it is the site's cloud id, from {@link fetchJiraTenant}): Atlassian
 * rejects a team list without one.
 */
export async function fetchTeamDirectory(
  transport: JiraTransport,
  options: TeamsDirectoryOptions,
): Promise<JiraDirectoryTeam[]> {
  // Atlassian now requires `siteId` on the team list ("siteId Mandatory
  // Enforcement on Teams Public APIs") and refuses a list without it — with a
  // 400 or, for some accounts, a 403. So the site-scoped list is asked first,
  // and the org-wide one only as a fallback for organizations that still
  // answer it. The listing fails only when every way was refused, and then
  // with the site-scoped refusal, which is the one that matters.
  const scopes: (string | undefined)[] = options.siteId
    ? [options.siteId, undefined]
    : [undefined];
  const refusals: JiraError[] = [];
  let teams: JiraDirectoryTeam[] | undefined;
  for (const siteId of scopes) {
    try {
      teams = await listTeamsPages(transport, options, siteId);
      break;
    } catch (err) {
      if (!isRefusal(err)) throw err;
      refusals.push(err);
    }
  }
  if (!teams) {
    // The Teams API is closed to this account; GraphQL is the route meant for
    // ordinary users.
    try {
      teams = await searchTeamsGraphql(transport, options);
    } catch (err) {
      if (!isRefusal(err)) throw err;
      refusals.push(err);
      throw combined(refusals);
    }
  }
  const byId = new Map<string, JiraDirectoryTeam>();
  for (const t of teams) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function searchTeamsGraphql(
  transport: JiraTransport,
  options: TeamsDirectoryOptions,
): Promise<JiraDirectoryTeam[]> {
  const out: JiraDirectoryTeam[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(
      transport,
      options,
      "PlannerTeamSearch",
      teamSearchQuery(options.orgId, options.siteId ?? "None", after),
    );
    const search = obj(obj(data.team)?.teamSearchV2);
    const edges = list(search?.edges);
    for (const edge of edges) {
      const t = obj(obj(obj(edge)?.node)?.team);
      const id = bareId(t?.id);
      const name = text(t?.displayName);
      if (id && name) out.push({ id, name });
    }
    const info = obj(search?.pageInfo);
    const next = text(info?.endCursor);
    if (info?.hasNextPage !== true || !next || !CURSOR.test(next)) break;
    if (edges.length === 0 || next === after) break;
    after = next;
  }
  return out;
}

/** Account ids of a team's members via GraphQL, every page. */
async function memberIdsGraphql(
  transport: JiraTransport,
  options: TeamsDirectoryOptions & { teamId: string },
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(
      transport,
      options,
      "PlannerTeamMembers",
      teamMembersQuery(options.teamId, options.siteId ?? "None", after),
    );
    const members = obj(obj(obj(data.team)?.teamV2)?.members);
    const edges = list(members?.edges);
    for (const edge of edges) {
      const id = text(obj(obj(obj(edge)?.node)?.member)?.accountId);
      if (id && !ids.includes(id)) ids.push(id);
    }
    const info = obj(members?.pageInfo);
    const next = text(info?.endCursor);
    if (info?.hasNextPage !== true || !next || !CURSOR.test(next)) break;
    if (edges.length === 0 || next === after) break;
    after = next;
  }
  return ids;
}

/**
 * Members of a Jira group, with names. Needs only the *Browse users and
 * groups* permission, which ordinary users usually have.
 */
async function groupPeople(
  transport: JiraTransport,
  options: JiraReadOptions,
  groupId: string,
): Promise<JiraDirectoryPerson[]> {
  const out: JiraDirectoryPerson[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = obj(
      await jiraCall(
        transport,
        options,
        `/rest/api/3/group/member?groupId=${encodeURIComponent(groupId)}` +
          `&includeInactiveUsers=false&startAt=${page * USER_CHUNK}` +
          `&maxResults=${USER_CHUNK}`,
        "GET",
      ),
    );
    const values = list(body?.values);
    for (const raw of values) {
      const u = obj(raw);
      const accountId = text(u?.accountId);
      if (!accountId || u?.active === false) continue;
      if (text(u?.accountType) === "app") continue;
      out.push({ accountId, displayName: text(u?.displayName) ?? accountId });
    }
    if (body?.isLast !== false || values.length === 0) break;
  }
  return out;
}

/** Account ids of a team's members, every page. */
async function memberIds(
  transport: JiraTransport,
  options: TeamsDirectoryOptions & { teamId: string },
): Promise<string[]> {
  const orgId = assertId(options.orgId, "organization id");
  const teamId = assertId(options.teamId, "team id");
  const siteQuery = options.siteId
    ? `?siteId=${encodeURIComponent(options.siteId)}`
    : "";
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = obj(
      await jiraCall(
        transport,
        options,
        `${TEAMS_ROOT}/${orgId}/teams/${teamId}/members${siteQuery}`,
        "POST",
        after ? { first: 50, after } : { first: 50 },
      ),
    );
    // The documented shape is `results` + `pageInfo`; older answers used
    // `entities`/`members` and a bare `cursor`. Read whichever is present.
    const rows = [
      ...list(body?.results),
      ...list(body?.entities),
      ...list(body?.members),
    ];
    for (const raw of rows) {
      const id = text(obj(raw)?.accountId) ?? text(raw);
      if (id && !ids.includes(id)) ids.push(id);
    }
    const info = obj(body?.pageInfo);
    const next = text(info?.endCursor) ?? text(body?.cursor);
    const more = info ? info.hasNextPage === true : next !== undefined;
    if (!more || !next || rows.length === 0 || next === after) break;
    after = next;
  }
  return ids;
}

/** Names for account ids, via Jira's bulk user lookup. Skips apps/bots and
 *  deactivated accounts, which nobody can plan with. */
async function people(
  transport: JiraTransport,
  options: JiraReadOptions,
  accountIds: string[],
): Promise<JiraDirectoryPerson[]> {
  const found = new Map<string, JiraDirectoryPerson>();
  for (let i = 0; i < accountIds.length; i += USER_CHUNK) {
    const chunk = accountIds.slice(i, i + USER_CHUNK);
    const query = [
      ...chunk.map((id) => `accountId=${encodeURIComponent(id)}`),
      `maxResults=${USER_CHUNK}`,
    ].join("&");
    const body = obj(
      await jiraCall(
        transport,
        options,
        `/rest/api/3/user/bulk?${query}`,
        "GET",
      ),
    );
    for (const raw of list(body?.values)) {
      const u = obj(raw);
      const accountId = text(u?.accountId);
      if (!accountId) continue;
      if (u?.active === false) continue;
      if (text(u?.accountType) === "app") continue;
      found.set(accountId, {
        accountId,
        displayName: text(u?.displayName) ?? accountId,
      });
    }
  }
  // Keep the directory's order; drop ids Jira would not describe.
  return accountIds.flatMap((id) => {
    const p = found.get(id);
    return p ? [p] : [];
  });
}

/**
 * One team's members with their names, in the directory's order. Tries the
 * Teams API, then the team's Jira group (when it has one), then GraphQL; a
 * refusal moves on to the next, and only when all refuse is it reported, with
 * every reason.
 */
export async function fetchTeamMembers(
  transport: JiraTransport,
  options: TeamsDirectoryOptions & { teamId: string; groupId?: string },
): Promise<JiraDirectoryPerson[]> {
  const refusals: JiraError[] = [];
  const named = async (ids: string[]) =>
    ids.length === 0 ? [] : people(transport, options, ids);

  try {
    return await named(await memberIds(transport, options));
  } catch (err) {
    if (!isRefusal(err)) throw err;
    refusals.push(err);
  }
  if (options.groupId) {
    try {
      return await groupPeople(transport, options, options.groupId);
    } catch (err) {
      if (!isRefusal(err)) throw err;
      refusals.push(err);
    }
  }
  try {
    return await named(await memberIdsGraphql(transport, options));
  } catch (err) {
    if (!isRefusal(err)) throw err;
    refusals.push(err);
  }
  throw combined(refusals);
}

/** How far back {@link fetchTeamIssuePeople} looks, in days. */
export const TEAM_ISSUE_WINDOW_DAYS = 180;

/** A field id as JQL names it: custom fields go by `cf[n]`. */
function jqlField(fieldId: string): string {
  const m = /^customfield_(\d+)$/.exec(fieldId);
  if (m) return `cf[${m[1]}]`;
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldId)) return fieldId;
  throw new RangeError(`Not a Jira field id: ${fieldId}`);
}

/** The search behind {@link fetchTeamIssuePeople}. */
export function teamIssuesJql(
  teamFieldId: string,
  teamId: string,
  sinceDays: number = TEAM_ISSUE_WINDOW_DAYS,
): string {
  assertId(teamId, "team id");
  const days = Math.floor(sinceDays);
  if (!Number.isFinite(days) || days < 1) {
    throw new RangeError("teamIssuesJql needs a window of at least one day");
  }
  return `${jqlField(teamFieldId)} = "${teamId}" AND updated >= -${days}d ORDER BY updated DESC`;
}

/**
 * The people assigned to a team's Jira issues: every issue whose Team field is
 * this team, updated in the window, grouped by assignee, most issues first.
 *
 * This is the fallback for when Atlassian will not hand over a team's roster
 * (its Teams service refuses member reads for some accounts through every
 * API). It is not the roster — someone who helped once appears, someone with
 * no issues yet does not — so callers must say so and let the user choose.
 * It needs only the issue search every Jira user can run.
 */
export async function fetchTeamIssuePeople(
  transport: JiraTransport,
  options: JiraReadOptions & { teamId: string; sinceDays?: number },
): Promise<JiraDirectoryPerson[]> {
  const fieldIds = resolveFieldIds(
    await jiraCall(transport, options, "/rest/api/3/field", "GET"),
  );
  const teamField = fieldIds.team;
  if (!teamField) return [];
  const issues = await searchIssues(transport, {
    ...options,
    jql: teamIssuesJql(teamField, options.teamId, options.sinceDays),
    fields: ["assignee"],
  });
  const byId = new Map<string, JiraDirectoryPerson & { issueCount: number }>();
  for (const raw of issues) {
    const assignee = obj(obj(obj(raw)?.fields)?.assignee);
    const accountId = text(assignee?.accountId);
    if (!accountId || assignee?.active === false) continue;
    if (text(assignee?.accountType) === "app") continue;
    const known = byId.get(accountId);
    if (known) known.issueCount += 1;
    else {
      byId.set(accountId, {
        accountId,
        displayName: text(assignee?.displayName) ?? accountId,
        issueCount: 1,
      });
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      b.issueCount - a.issueCount || a.displayName.localeCompare(b.displayName),
  );
}
