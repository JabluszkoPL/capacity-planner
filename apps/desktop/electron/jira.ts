/**
 * The Mac app's Jira relay.
 *
 * Jira Cloud sends no CORS headers, so the renderer — which is an ordinary web
 * page — cannot call it. The main process is not a browser and has no such
 * restriction, so the renderer hands a fully-described request across the
 * context bridge and the main process makes it.
 *
 * That makes this the one place in the app that can reach an arbitrary URL on
 * the user's behalf, so it is deliberately narrow: {@link checkJiraTarget}
 * decides, before any socket opens, that the host is a Jira site and the path
 * is inside the REST API. Without that, a compromised renderer would have a
 * general-purpose request forwarder with the user's network position, and
 * every request it made would carry whatever credentials it chose.
 *
 * Credentials themselves are never held here. The `Authorization` header
 * arrives with the request, is forwarded once, and is never logged.
 */
import type { JiraRequest, JiraResponse } from "@planner/jira";

const ALLOWED_PATH_PREFIXES = ["/rest/api/3/", "/rest/agile/1.0/"];

/*
 * Atlassian's Teams directory, read-only, by exact path shape: the team list
 * (GET), one team's members (POST, but only `/members` — never `/members/add`
 * or `/members/remove`), and the GraphQL gateway for one fixed query that
 * looks up the site's organization id (see {@link checkJiraBody}).
 * Duplicated in apps/server/src/jiraProxy.ts on purpose.
 */
const TEAMS_LIST =
  /^\/gateway\/api\/public\/teams\/v1\/org\/[A-Za-z0-9-]+\/teams$/;
const TEAMS_MEMBERS =
  /^\/gateway\/api\/public\/teams\/v1\/org\/[A-Za-z0-9-]+\/teams\/[A-Za-z0-9-]+\/members$/;
const GRAPHQL_PATH = "/gateway/api/graphql";

function isAllowedPath(pathname: string, method: string): boolean {
  if (ALLOWED_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (method === "GET" && TEAMS_LIST.test(pathname)) return true;
  if (method === "POST" && TEAMS_MEMBERS.test(pathname)) return true;
  return method === "POST" && pathname === GRAPHQL_PATH;
}

/** The only GraphQL query this relay forwards: the org-id lookup for the
 *  site being called. Must match `tenantQuery` in @planner/jira. */
function tenantQuery(host: string): string {
  return `query PlannerTenant { tenantContexts(hostNames: ["${host}"]) { cloudId orgId } }`;
}

/** Beta program names forwarded as `X-ExperimentalApi`, GraphQL only. */
const EXPERIMENTAL = /^[A-Za-z0-9-]{1,40}$/;

/** Validated beta program names, or null when any is not word-like. */
function experimentalHeader(values: unknown): string | null {
  const list =
    typeof values === "string"
      ? values.split(",").map((v) => v.trim())
      : Array.isArray(values)
        ? values
        : [];
  if (list.length === 0 || list.length > 5) return null;
  if (!list.every((v) => typeof v === "string" && EXPERIMENTAL.test(v))) {
    return null;
  }
  return list.join(",");
}

/*
 * The two Teams GraphQL queries, as exact shapes: fixed text, with only the
 * ids and page cursor varying, each held to a character set that cannot close
 * a string literal. Must match teamSearchQuery / teamMembersQuery in
 * @planner/jira.
 */
const GQL_ID = "[A-Za-z0-9-]+";
const GQL_AFTER = '(?:, after: "[A-Za-z0-9+/=_:.-]{1,512}")?';
const TEAM_SEARCH_QUERY = new RegExp(
  "^" +
    literal(
      'query PlannerTeamSearch { team @optIn(to: "Team-search-v2") { teamSearchV2(organizationId: "ari:cloud:platform::org/',
    ) +
    GQL_ID +
    literal('", siteId: "') +
    GQL_ID +
    literal('", first: 100') +
    GQL_AFTER +
    literal(
      ") { pageInfo { hasNextPage endCursor } edges { node { team { id displayName } } } } } }",
    ) +
    "$",
);
const TEAM_MEMBERS_QUERY = new RegExp(
  "^" +
    literal(
      'query PlannerTeamMembers { team { teamV2(id: "ari:cloud:identity::team/',
    ) +
    GQL_ID +
    literal('", siteId: "') +
    GQL_ID +
    literal('") @optIn(to: "Team") { members(first: 50') +
    GQL_AFTER +
    literal(
      ") { pageInfo { hasNextPage endCursor } edges { node { member { accountId } } } } } } }",
    ) +
    "$",
);

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a GraphQL body is one of the queries this relay forwards. */
function isAllowedGraphql(
  host: string,
  query: unknown,
  operationName: unknown,
): boolean {
  if (typeof query !== "string") return false;
  const shapes: [string, (q: string) => boolean][] = [
    ["PlannerTenant", (q) => q === tenantQuery(host)],
    ["PlannerTeamSearch", (q) => TEAM_SEARCH_QUERY.test(q)],
    ["PlannerTeamMembers", (q) => TEAM_MEMBERS_QUERY.test(q)],
  ];
  return shapes.some(
    ([name, matches]) =>
      (operationName === undefined || operationName === name) &&
      query.startsWith(`query ${name} `) &&
      matches(query),
  );
}

/**
 * The body check that a path check cannot make. The GraphQL endpoint accepts
 * mutations as readily as queries, so a POST there is relayed only when it is
 * exactly the org-id lookup, for the very site named in the request.
 */
export function checkJiraBody(
  baseUrl: string,
  path: string,
  body: unknown,
): boolean {
  let origin: URL;
  let target: URL;
  try {
    origin = new URL(baseUrl);
    target = new URL(path, origin);
  } catch {
    return false;
  }
  if (target.pathname !== GRAPHQL_PATH) return true;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const { query, operationName, ...rest } = body as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    isAllowedGraphql(origin.hostname.toLowerCase(), query, operationName)
  );
}
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT"]);

/** Requests are JQL queries and small field updates; nothing here is large. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Sent in place of the network stack's own User-Agent. The main process makes
 * these calls through Chromium (see main.ts), whose default UA is a browser's,
 * and Atlassian's XSRF check rejects a POST from a browser UA with "XSRF check
 * failed" even when `x-atlassian-token: no-check` is set.
 */
const USER_AGENT = "Planner (desktop)";

export type TargetCheck =
  { ok: true; url: string } | { ok: false; message: string };

/**
 * Whether one relayed request may be made at all.
 *
 * Pure, and exported so the rule can be tested directly: the cases that matter
 * (a lookalike hostname, a path climbing out of the REST namespace) are
 * tedious to provoke through a live Electron window and easy to get subtly
 * wrong.
 *
 * @param extraHost an additional permitted hostname, for a deployment whose
 *   Jira is not on atlassian.net (PLANNER_JIRA_HOST).
 */
export function checkJiraTarget(
  baseUrl: string,
  path: string,
  method: string,
  extraHost?: string,
): TargetCheck {
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, message: `${method} is not relayed.` };
  }

  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    return { ok: false, message: "Malformed Jira base URL." };
  }
  if (origin.protocol !== "https:") {
    return { ok: false, message: "Jira must be reached over https." };
  }
  const host = origin.hostname.toLowerCase();
  const allowed =
    host.endsWith(".atlassian.net") ||
    (extraHost !== undefined && host === extraHost.toLowerCase());
  if (!allowed) {
    return { ok: false, message: `${host} is not a Jira site.` };
  }

  // Resolve against the origin before testing the prefix, so `..` segments and
  // encoded slashes are normalised here rather than being smuggled past a
  // string test and re-expanded by the target.
  let target: URL;
  try {
    target = new URL(path, origin);
  } catch {
    return { ok: false, message: "Malformed Jira path." };
  }
  if (target.origin !== origin.origin) {
    return { ok: false, message: "Path escapes the Jira site." };
  }
  if (!isAllowedPath(target.pathname, method)) {
    return {
      ok: false,
      message: "Only the Jira REST API and the Teams directory are relayed.",
    };
  }
  return { ok: true, url: target.toString() };
}

/** Shape-check what crossed the context bridge before acting on it. */
function asRequest(value: unknown): JiraRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.baseUrl !== "string" || typeof v.path !== "string") return null;
  if (typeof v.method !== "string" || typeof v.auth !== "string") return null;
  return v as unknown as JiraRequest;
}

/**
 * Perform one relayed request. Never throws: a failure comes back as a
 * response with a 4xx/5xx status and a JSON body, exactly as the pure client
 * in @planner/jira expects, so one error path handles both.
 */
export async function relayJiraRequest(
  raw: unknown,
  extraHost = process.env.PLANNER_JIRA_HOST || undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraResponse> {
  const req = asRequest(raw);
  if (!req) {
    return { status: 400, body: { error: "Malformed Jira request." } };
  }
  const method = req.method.toUpperCase();
  const check = checkJiraTarget(req.baseUrl, req.path, method, extraHost);
  if (!check.ok) return { status: 403, body: { error: check.message } };
  if (!checkJiraBody(req.baseUrl, req.path, req.body)) {
    return {
      status: 403,
      body: { error: "Only the organization lookup query is relayed." },
    };
  }

  // The beta header only means something to the GraphQL gateway; anywhere
  // else, or with anything but plain program names, it is dropped.
  const experimental =
    req.experimental !== undefined &&
    new URL(check.url).pathname === GRAPHQL_PATH
      ? experimentalHeader(req.experimental)
      : null;

  const body =
    req.body !== undefined && method !== "GET"
      ? JSON.stringify(req.body)
      : undefined;
  if (body !== undefined && Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return { status: 413, body: { error: "Request body too large." } };
  }

  try {
    const response = await fetchImpl(check.url, {
      method,
      // Chromium's stack would otherwise attach and store session cookies; the
      // Authorization header is the only credential this relay should carry.
      credentials: "omit",
      headers: {
        authorization: req.auth,
        accept: "application/json",
        "user-agent": USER_AGENT,
        // Atlassian's XSRF check rejects POST/PUT calls without this, even
        // from a native client with no cookie/session involved — required
        // for e.g. the JQL search endpoint refresh depends on.
        "x-atlassian-token": "no-check",
        ...(experimental ? { "x-experimentalapi": experimental } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const retryAfter = response.headers.get("retry-after");
    return {
      status: response.status,
      body: parsed,
      ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
    };
  } catch (err) {
    // Deliberately not stringifying the whole error: a fetch failure can echo
    // the request it was given, and the request carries the token.
    return {
      status: 502,
      body: { error: `Could not reach Jira: ${failureReason(err)}` },
    };
  }
}

/**
 * Why a request never got a response, specific enough to act on. Node's fetch
 * reports every network failure as a bare "fetch failed" and keeps the real
 * reason — a certificate it does not trust, a proxy refusing, DNS — in
 * `cause`, which is exactly what a tester needs to read back.
 */
function failureReason(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const detail =
      typeof code === "string" ? `${code} ${cause.message}` : cause.message;
    return `${err.message} (${detail})`;
  }
  return err.message;
}
