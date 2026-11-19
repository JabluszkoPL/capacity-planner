/**
 * A narrow forward proxy to Jira Cloud, for browsers only.
 *
 * Jira's REST API sends no CORS headers, so a page served from the web app's
 * origin cannot call it at all — the request never leaves the browser. The Mac
 * app sidesteps this by calling from Electron's main process; a plain browser
 * has nowhere to go but through a server it already trusts, which is this one.
 *
 * It is a proxy, not a client: it holds no credentials of its own. The caller's
 * `Authorization` header is forwarded verbatim and never logged, so the token
 * stays the user's, and the server keeps nothing after the response is written.
 *
 * Two things keep it from being an open relay. The target host must pass
 * {@link isAllowedJiraTarget} (an Atlassian site, or one named by the
 * deployer), and writes are refused unless `PLANNER_JIRA_WRITES=1` — reading
 * somebody's board is recoverable, silently rewriting its dates is not.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const JIRA_PROXY_PREFIX = "/api/jira";
/** The caller names its Jira site here rather than in the path, so the path
 *  stays a verbatim Jira path and is trivial to validate. */
export const JIRA_BASE_HEADER = "x-planner-jira-base";

/** Request bodies are JSON queries; anything large is a mistake or an attack. */
const MAX_BODY_BYTES = 1024 * 1024;

const ALLOWED_PATH_PREFIXES = ["/rest/api/3/", "/rest/agile/1.0/"];

/*
 * Atlassian's Teams directory, read-only, by exact path shape: the team list
 * (GET), one team's members (POST, but only `/members` — never `/members/add`
 * or `/members/remove`), and the GraphQL gateway for one fixed query that
 * looks up the site's organization id (see {@link isAllowedJiraBody}).
 * Duplicated in apps/desktop/electron/jira.ts on purpose.
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

/** The only GraphQL query this proxy forwards: the org-id lookup for the
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
 * mutations as readily as queries, so a POST there is forwarded only when it
 * is exactly the org-id lookup, for the very site named in the request.
 */
export function isAllowedJiraBody(
  base: string,
  path: string,
  body: string | undefined,
): boolean {
  let origin: URL;
  let target: URL;
  try {
    origin = new URL(base);
    target = new URL(path, origin);
  } catch {
    return false;
  }
  if (target.pathname !== GRAPHQL_PATH) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const { query, operationName, ...rest } = parsed as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    isAllowedGraphql(origin.hostname.toLowerCase(), query, operationName)
  );
}
const READ_METHODS = new Set(["GET", "POST"]);
const WRITE_METHODS = new Set(["PUT"]);

export interface JiraProxyOptions {
  /** Allow PUT. Off unless the deployer sets PLANNER_JIRA_WRITES=1. */
  allowWrites: boolean;
  /** An extra permitted host (e.g. a Jira Data Center behind a company name). */
  extraHost?: string;
}

export function jiraProxyOptions(): JiraProxyOptions {
  return {
    allowWrites: process.env.PLANNER_JIRA_WRITES === "1",
    extraHost: process.env.PLANNER_JIRA_HOST || undefined,
  };
}

export type TargetCheck =
  { ok: true; url: string } | { ok: false; status: number; message: string };

/**
 * Decide whether one proxied call may be made at all.
 *
 * Pure and exported so the rule can be tested directly — the interesting cases
 * (a lookalike host, a path escaping the REST namespace) are tedious to reach
 * through a live socket and easy to get subtly wrong.
 */
export function isAllowedJiraTarget(
  base: string,
  path: string,
  method: string,
  opts: JiraProxyOptions,
): TargetCheck {
  if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) {
    return { ok: false, status: 405, message: `${method} is not proxied.` };
  }
  if (WRITE_METHODS.has(method) && !opts.allowWrites) {
    return {
      ok: false,
      status: 405,
      message: "Writing to Jira is disabled on this server.",
    };
  }

  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return { ok: false, status: 400, message: "Malformed Jira base URL." };
  }
  if (origin.protocol !== "https:") {
    return {
      ok: false,
      status: 403,
      message: "Jira must be reached over https.",
    };
  }
  const host = origin.hostname.toLowerCase();
  const allowed =
    host.endsWith(".atlassian.net") ||
    (opts.extraHost !== undefined && host === opts.extraHost.toLowerCase());
  if (!allowed) {
    return { ok: false, status: 403, message: `${host} is not a Jira site.` };
  }

  // Resolve the path against the origin before checking it, so `..` segments
  // and encoded slashes are normalised away first rather than being smuggled
  // past a prefix test and then re-expanded by the target.
  let target: URL;
  try {
    target = new URL(path, origin);
  } catch {
    return { ok: false, status: 400, message: "Malformed Jira path." };
  }
  if (target.origin !== origin.origin) {
    return { ok: false, status: 403, message: "Path escapes the Jira site." };
  }
  if (!isAllowedPath(target.pathname, method)) {
    return {
      ok: false,
      status: 403,
      message: "Only the Jira REST API and the Teams directory are proxied.",
    };
  }
  return { ok: true, url: target.toString() };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

/** The CORS preflight the browser sends before any call carrying our headers. */
export function jiraProxyPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": `authorization, content-type, x-atlassian-token, x-experimentalapi, ${JIRA_BASE_HEADER}`,
    "access-control-max-age": "600",
  });
  res.end();
}

/**
 * Handle one `/api/jira/...` request. `url` is the request's raw url.
 *
 * The response body is passed through as text and re-sent with the upstream
 * status, so the client sees Jira's own error payloads (which say far more
 * about a bad JQL than any message this proxy could invent).
 */
export async function handleJiraProxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  opts: JiraProxyOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") return jiraProxyPreflight(res);

  const base = req.headers[JIRA_BASE_HEADER];
  if (typeof base !== "string" || base.length === 0) {
    return send(res, 400, { error: `Missing ${JIRA_BASE_HEADER} header.` });
  }
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || auth.length === 0) {
    return send(res, 401, { error: "Missing Authorization header." });
  }

  const path = url.slice(JIRA_PROXY_PREFIX.length) || "/";
  const check = isAllowedJiraTarget(base, path, method, opts);
  if (!check.ok) return send(res, check.status, { error: check.message });

  let body: string | undefined;
  if (method !== "GET") {
    try {
      body = await readBody(req);
    } catch {
      return send(res, 413, { error: "Request body too large." });
    }
  }
  // The beta header only means something to the GraphQL gateway; anywhere
  // else, or with anything but plain program names, it is dropped.
  const rawExperimental = req.headers["x-experimentalapi"];
  const experimental =
    rawExperimental !== undefined &&
    new URL(check.url).pathname === GRAPHQL_PATH
      ? experimentalHeader(
          Array.isArray(rawExperimental)
            ? rawExperimental.join(",")
            : rawExperimental,
        )
      : null;
  if (!isAllowedJiraBody(base, path, body)) {
    return send(res, 403, {
      error: "Only the organization lookup query is proxied.",
    });
  }

  try {
    const upstream = await fetchImpl(check.url, {
      method,
      headers: {
        authorization: auth,
        accept: "application/json",
        // Atlassian's XSRF check rejects POST/PUT calls without this, even
        // for a plain server-to-server API client — required for e.g. the
        // JQL search endpoint refresh depends on.
        "x-atlassian-token": "no-check",
        ...(experimental ? { "x-experimentalapi": experimental } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      "access-control-allow-origin": "*",
      // Surfaced so the client can honour Jira's own backoff rather than
      // guessing at one.
      ...(upstream.headers.get("retry-after")
        ? { "retry-after": upstream.headers.get("retry-after") as string }
        : {}),
    });
    res.end(text);
  } catch (err) {
    // Deliberately not `String(err)` on the whole error: a fetch failure can
    // echo the request, and the request carries the token.
    const reason = err instanceof Error ? err.message : "unknown error";
    send(res, 502, { error: `Could not reach Jira: ${reason}` });
  }
}
