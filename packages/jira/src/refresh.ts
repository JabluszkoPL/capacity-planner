import type { JiraFieldIds, JiraSnapshot } from "@planner/core";
import { resolveFieldIds } from "./fields";
import { isIssueKey } from "./link";
import {
  EPIC_CHUNK_SIZE,
  epicChildrenJql,
  initiativeEpicsJqlCandidates,
  issueFieldList,
} from "./jql";
import { buildSnapshot } from "./map";
import type { JiraResponse, JiraTransport } from "./transport";

/**
 * One refresh, as a sequence of transport calls.
 *
 * This is the only place that knows the shape of the whole conversation with
 * Jira — resolve field ids, read the initiative, find its epics, read their
 * children — and it stays pure by never calling `fetch` itself and never
 * reading the clock: `now` is passed in so a refresh is reproducible in tests
 * and the snapshot's `fetchedAt` is decided by the caller.
 *
 * Three behaviours here exist because of how Jira actually answers:
 *
 * - **Candidate queries may be rejected, not just empty.** `"Parent Link"` does
 *   not exist on a site without Advanced Roadmaps, and Jira answers an unknown
 *   JQL field with 400, not with zero rows. So a 400 from a candidate means
 *   "try the next one", and only a candidate that is *accepted* ends the search.
 * - **Every list is paginated by token.** `/search/jql` returns
 *   `nextPageToken`; there is no total and no `startAt`, so the loop runs until
 *   the token stops coming (with a hard page cap, because an endpoint that
 *   keeps handing back the same token must not become an infinite loop).
 * - **429 is normal under load.** One retry honouring `Retry-After` turns the
 *   common case (a burst of six requests brushing a limit) into a slower
 *   refresh rather than a failed one.
 *
 * Errors are typed ({@link JiraError}) because the UI reacts differently to
 * each: bad credentials open the settings panel, a 404 means the initiative was
 * moved or deleted, and an unreachable host is worth retrying later. No error
 * message ever contains the auth string — it is scrubbed even out of messages
 * that came from a transport we do not control.
 */

export type JiraErrorKind =
  /** 401/403 — credentials missing, wrong, or without permission. */
  | "auth"
  /** 404 — no such issue, or not visible to this account. */
  | "not-found"
  /** 429 that survived one retry. */
  | "rate-limited"
  /** The request never reached Jira (offline, DNS, no transport). */
  | "network"
  /** Reached Jira, but it is failing (5xx). */
  | "unavailable"
  /** A 4xx we cannot act on, or a body that is not the shape we expect. */
  | "bad-response";

export class JiraError extends Error {
  readonly kind: JiraErrorKind;
  readonly status?: number;
  /** REST path that failed, when a request had already been constructed. */
  readonly requestPath?: string;

  constructor(
    kind: JiraErrorKind,
    message: string,
    status?: number,
    /**
     * The original failure, when this error wraps one. A transport throws its
     * own error types — "this browser has no way to reach Jira" is a very
     * different thing from "the network is down" — and flattening them all to
     * `network` would leave the caller unable to tell the user which it was.
     */
    cause?: unknown,
    requestPath?: string,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JiraError";
    this.kind = kind;
    this.status = status;
    this.requestPath = requestPath;
  }
}

export interface FetchSnapshotOptions {
  /** Site origin, e.g. `https://acme.atlassian.net`. */
  baseUrl: string;
  /** `Authorization` header value from `basicAuth()`. */
  auth: string;
  /** Initiative issue key. */
  key: string;
  /** Skips the field-discovery request when the caller has cached ids. */
  fieldIds?: JiraFieldIds;
  /** ISO datetime stamped on the snapshot; no clock is read in here. */
  now: string;
  /** Injected so tests do not actually wait out a `Retry-After`. */
  sleep?: (ms: number) => Promise<void>;
  /** Cap on an honoured `Retry-After`, default 30s. */
  maxRetryDelayMs?: number;
}

const DEFAULT_MAX_RETRY_MS = 30_000;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function scrub(message: string, auth: string): string {
  if (auth === "") return message;
  return message.split(auth).join("[redacted]");
}

/**
 * The reason in an error body. Jira's REST API says `errorMessages: [...]`;
 * the Atlassian gateway APIs (Teams, GraphQL) say `{ code, message }` or
 * `errors: [{ message }]`; the two Planner relays say `{ error }`. Without
 * reading all of them a rejection from anything but Jira proper reads as a
 * bare status code, which tells the user nothing.
 */
function jiraMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const row = body as Record<string, unknown>;
  const nonEmpty = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  if (Array.isArray(row.errorMessages)) {
    const first = row.errorMessages.map(nonEmpty).find(Boolean);
    if (first) return first;
  }
  const message = nonEmpty(row.message);
  if (message) {
    const code = nonEmpty(row.code);
    return code && !message.includes(code) ? `${message} (${code})` : message;
  }
  if (Array.isArray(row.errors)) {
    for (const e of row.errors) {
      const m =
        typeof e === "object" && e !== null
          ? nonEmpty((e as Record<string, unknown>).message)
          : nonEmpty(e);
      if (m) return m;
    }
  }
  return nonEmpty(row.error) ?? nonEmpty(row.errorMessage);
}

function retryAfterMs(res: JiraResponse, cap: number): number {
  const raw = res.headers?.["retry-after"] ?? res.headers?.["Retry-After"];
  const seconds = Number(raw);
  // No usable header: Jira asks for a pause anyway, so take a short one.
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
  return Math.min(ms, cap);
}

function classify(
  res: JiraResponse,
  auth: string,
  path: string,
): JiraError | undefined {
  const { status } = res;
  if (status >= 200 && status < 300) return undefined;
  const detail = jiraMessage(res.body);
  const suffix = detail ? `: ${scrub(detail, auth)}` : "";
  if (status === 401 || status === 403) {
    return new JiraError(
      "auth",
      `Jira rejected the credentials (HTTP ${status})${suffix}`,
      status,
      undefined,
      path,
    );
  }
  if (status === 404) {
    return new JiraError(
      "not-found",
      `Not found in Jira${suffix}`,
      status,
      undefined,
      path,
    );
  }
  if (status === 429) {
    return new JiraError(
      "rate-limited",
      "Jira is rate limiting",
      status,
      undefined,
      path,
    );
  }
  if (status >= 500) {
    return new JiraError(
      "unavailable",
      `Jira is unavailable (HTTP ${status})${suffix}`,
      status,
      undefined,
      path,
    );
  }
  return new JiraError(
    "bad-response",
    `Jira rejected the request (HTTP ${status})${suffix}`,
    status,
    undefined,
    path,
  );
}

interface Ctx {
  transport: JiraTransport;
  baseUrl: string;
  auth: string;
  sleep: (ms: number) => Promise<void>;
  maxRetryDelayMs: number;
}

async function send(
  ctx: Ctx,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  experimental?: string[],
): Promise<unknown> {
  let res = await call(ctx, path, method, body, experimental);
  if (res.status === 429) {
    await ctx.sleep(retryAfterMs(res, ctx.maxRetryDelayMs));
    res = await call(ctx, path, method, body, experimental);
  }
  const err = classify(res, ctx.auth, path);
  if (err) throw err;
  return res.body;
}

async function call(
  ctx: Ctx,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  experimental?: string[],
): Promise<JiraResponse> {
  try {
    return await ctx.transport.request({
      baseUrl: ctx.baseUrl,
      path,
      method,
      auth: ctx.auth,
      body,
      ...(experimental && experimental.length > 0 ? { experimental } : {}),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new JiraError(
      "network",
      `Could not reach Jira: ${scrub(detail, ctx.auth)}`,
      undefined,
      cause,
      path,
    );
  }
}

function rowsOf(body: unknown): { issues: unknown[]; nextPageToken?: string } {
  if (typeof body !== "object" || body === null) {
    throw new JiraError("bad-response", "Jira returned an unreadable response");
  }
  const row = body as Record<string, unknown>;
  const issues = Array.isArray(row.issues) ? row.issues : [];
  const token =
    typeof row.nextPageToken === "string" && row.nextPageToken !== ""
      ? row.nextPageToken
      : undefined;
  return { issues, nextPageToken: token };
}

/** Every page of one JQL search, following `nextPageToken`. */
async function searchAll(
  ctx: Ctx,
  jql: string,
  fields: string[],
): Promise<unknown[]> {
  const out: unknown[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      jql,
      fields,
      maxResults: PAGE_SIZE,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    let response: unknown;
    try {
      response = await send(ctx, "/rest/api/3/search/jql", "POST", body);
    } catch (err) {
      // Some Jira gateways accept authenticated GETs but reject browser-routed
      // POST searches with 403 because of their XSRF policy. Enhanced search
      // officially supports both verbs, so retry that one rejection as GET.
      // Keep POST first because large child queries fit comfortably in a JSON
      // body but can approach proxy URL limits.
      if (!(err instanceof JiraError) || err.status !== 403) throw err;
      const params = [
        `jql=${encodeURIComponent(jql)}`,
        `fields=${encodeURIComponent(fields.join(","))}`,
        `maxResults=${PAGE_SIZE}`,
        ...(nextPageToken
          ? [`nextPageToken=${encodeURIComponent(nextPageToken)}`]
          : []),
      ].join("&");
      response = await send(ctx, `/rest/api/3/search/jql?${params}`, "GET");
    }
    const res = rowsOf(response);
    out.push(...res.issues);
    if (!res.nextPageToken || res.issues.length === 0) break;
    nextPageToken = res.nextPageToken;
  }
  return out;
}

function isEpic(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const fields = (raw as Record<string, unknown>).fields;
  if (typeof fields !== "object" || fields === null) return false;
  const type = (fields as Record<string, unknown>).issuetype;
  if (typeof type !== "object" || type === null) return false;
  const name = (type as Record<string, unknown>).name;
  return typeof name === "string" && name.trim().toLowerCase() === "epic";
}

/**
 * Try each hierarchy query until one is accepted, and keep its rows.
 *
 * "Accepted" rather than "non-empty" for the last candidate only: a query that
 * Jira answers with zero rows after every candidate has been tried means the
 * initiative genuinely has no epics, which is a valid (if dull) snapshot.
 */
async function findEpics(
  ctx: Ctx,
  key: string,
  fields: string[],
): Promise<unknown[]> {
  let accepted = false;
  let lastError: JiraError | undefined;
  for (const jql of initiativeEpicsJqlCandidates(key)) {
    let rows: unknown[];
    try {
      rows = await searchAll(ctx, jql, fields);
    } catch (err) {
      // An unknown field or link type is a 400 — this site does not model the
      // hierarchy that way, so move on. Anything else (including a body we
      // could not read at all) is a real failure.
      if (err instanceof JiraError && err.status === 400) {
        lastError = err;
        continue;
      }
      throw err;
    }
    accepted = true;
    if (rows.length === 0) continue;
    // Sub-tasks and stray links can ride along on a `parent =` query; keep only
    // epics unless that would throw away everything we found, in which case the
    // site evidently calls its epics something else.
    const epics = rows.filter(isEpic);
    return epics.length > 0 ? epics : rows;
  }
  if (!accepted && lastError) throw lastError;
  return [];
}

/** What every standalone Jira read needs besides the transport. */
export interface JiraReadOptions {
  /** Site origin, e.g. `https://acme.atlassian.net`. */
  baseUrl: string;
  /** `Authorization` header value from `basicAuth()`. */
  auth: string;
  /** Injected so tests do not actually wait out a `Retry-After`. */
  sleep?: (ms: number) => Promise<void>;
  /** Cap on an honoured `Retry-After`, default 30s. */
  maxRetryDelayMs?: number;
}

function contextOf(transport: JiraTransport, options: JiraReadOptions): Ctx {
  return {
    transport,
    baseUrl: options.baseUrl,
    auth: options.auth,
    sleep: options.sleep ?? defaultSleep,
    maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_MS,
  };
}

/**
 * One request with the same retry and typed-error rules as a refresh, for
 * readers other than the tracker (the Teams directory, user lookups).
 */
export async function jiraCall(
  transport: JiraTransport,
  options: JiraReadOptions,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  experimental?: string[],
): Promise<unknown> {
  return send(contextOf(transport, options), path, method, body, experimental);
}

/**
 * Every page of one JQL search, raw, with the same paging, retry and error
 * rules as a refresh — for readers other than the tracker.
 */
export async function searchIssues(
  transport: JiraTransport,
  options: JiraReadOptions & { jql: string; fields: string[] },
): Promise<unknown[]> {
  return searchAll(contextOf(transport, options), options.jql, options.fields);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Read one initiative and everything under it, and assemble a snapshot.
 *
 * Roughly `1 + 1 + candidates + ceil(epics / 50)` requests; an initiative with
 * fifteen epics and four hundred children is about six.
 */
export async function fetchInitiativeSnapshot(
  transport: JiraTransport,
  options: FetchSnapshotOptions,
): Promise<JiraSnapshot> {
  const { baseUrl, auth, key, now } = options;
  if (!isIssueKey(key)) {
    throw new JiraError("bad-response", `Not a Jira issue key: ${key}`);
  }
  const ctx: Ctx = {
    transport,
    baseUrl,
    auth,
    sleep: options.sleep ?? defaultSleep,
    maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_MS,
  };

  const fieldIds =
    options.fieldIds ??
    resolveFieldIds(await send(ctx, "/rest/api/3/field", "GET"));
  const fields = issueFieldList(fieldIds);

  const initiative = await send(
    ctx,
    `/rest/api/3/issue/${encodeURIComponent(key)}` +
      `?fields=${encodeURIComponent(fields.join(","))}`,
    "GET",
  );

  const epics = await findEpics(ctx, key, fields);
  const epicKeys = epics
    .map((raw) =>
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).key
        : undefined,
    )
    .filter(isIssueKey);

  const children: unknown[] = [];
  for (const group of chunk(epicKeys, EPIC_CHUNK_SIZE)) {
    children.push(...(await searchAll(ctx, epicChildrenJql(group), fields)));
  }

  return buildSnapshot(initiative, epics, children, fieldIds, now);
}
