import type {
  JiraFieldIds,
  JiraIssue,
  JiraSnapshot,
  SprintDraftItem,
} from "@planner/core";
import { isIssueKey } from "./link";
import { JiraError } from "./refresh";
import type { JiraResponse, JiraTransport } from "./transport";

/**
 * The one thing Planner writes back to Jira: start and due dates.
 *
 * Everything here is shaped by the fact that this is the only code in the app
 * that *changes somebody else's board*, so it is deliberately narrow and
 * deliberately slow:
 *
 * - **Dates only.** Never an assignee, never an estimate, never a sprint. A
 *   Planner draft is a proposal about *when*; who does the work and how big it
 *   is are decided in Jira, and silently overwriting either would make the two
 *   systems argue.
 * - **No-ops are not sent.** An issue whose Jira dates already equal the
 *   draft's is dropped by {@link dateChanges} rather than written and reported
 *   as "changed": a write that changes nothing still stamps `updated`, still
 *   pings watchers, and still lies to the person reading the preview.
 * - **One request at a time.** Jira Cloud rate-limits per account, and a burst
 *   of thirty PUTs is the reliable way to earn a 429 mid-run. Sequential is
 *   fast enough for a sprint's worth of issues and much easier to explain when
 *   it half-fails.
 * - **A failure is per issue, not per run.** One issue the account cannot edit
 *   must not abandon the other twenty-nine, so every issue produces a
 *   {@link WriteResult} and the loop carries on.
 * - **`canWrite` is checked before anything is sent.** The proxy transports
 *   refuse writes unless the deployer opted in; discovering that after eight
 *   successful PUTs would leave the board half-updated.
 *
 * Error wording and the auth scrubbing match refresh.ts on purpose — they are
 * the same vocabulary, seen by the same user, in the same panel. (The
 * classifier there is module-private and refresh.ts is not ours to change, so
 * the phrasing is mirrored rather than imported.)
 */

/**
 * Jira's default "Start date" field id on a Team-managed site.
 *
 * Used only when field discovery has not run, so a write still lands on the
 * field a read would most likely have found. A site that renamed or re-created
 * the field always resolves an id first; this is the fallback, not the answer.
 */
export const DEFAULT_START_DATE_FIELD_ID = "customfield_10015";

/**
 * The half of a scheduled span a write-back cares about: two ISO dates.
 *
 * Structurally the front of `DraftSpan` from @planner/core, so a caller can
 * hand one straight over; declared here so this module does not depend on how
 * the draft computed the span.
 */
export interface WriteSpan {
  /** ISO date, e.g. "2026-09-22". */
  start: string;
  /** ISO date, inclusive — becomes Jira's `duedate`. */
  end: string;
}

/** The body of one `PUT /rest/api/3/issue/{key}`. */
export interface DatePayload {
  fields: Record<string, string>;
}

/** One issue the draft would move, with both sides shown for review. */
export interface DateChange {
  issueKey: string;
  summary: string;
  /** What Jira holds today; absent when the field was never set. */
  currentStart?: string;
  currentDue?: string;
  nextStart: string;
  nextDue: string;
}

/** What happened to one issue. `error` is present exactly when `ok` is false. */
export interface WriteResult {
  issueKey: string;
  ok: boolean;
  error?: string;
}

export interface ApplyDatesOptions {
  /** Site origin, e.g. `https://acme.atlassian.net`. */
  baseUrl: string;
  /** `Authorization` header value from `basicAuth()`. */
  auth: string;
  /** Usually straight from {@link dateChanges}. */
  changes: readonly DateChange[];
  /** Ids resolved on this site, so the write sets the field the read read. */
  fieldIds: JiraFieldIds;
}

function scrub(message: string, auth: string): string {
  if (auth === "") return message;
  return message.split(auth).join("[redacted]");
}

/**
 * The human half of a Jira error body.
 *
 * Both shapes are read because a rejected *write* usually answers with
 * `errors` keyed by field id ("Field 'customfield_10015' cannot be set"),
 * which is the only clue that the discovered start-date field is wrong on this
 * site — while a rejected read answers with `errorMessages`.
 */
function jiraDetail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const row = body as Record<string, unknown>;
  const messages = row.errorMessages;
  if (Array.isArray(messages)) {
    const first = messages.find((m) => typeof m === "string" && m !== "");
    if (typeof first === "string") return first;
  }
  const errors = row.errors;
  if (typeof errors === "object" && errors !== null) {
    for (const [field, message] of Object.entries(
      errors as Record<string, unknown>,
    )) {
      if (typeof message === "string" && message !== "") {
        return `${field}: ${message}`;
      }
    }
  }
  return undefined;
}

/** Same phrasing as refresh.ts's classifier, for the same reader. */
function describeFailure(res: JiraResponse, auth: string): string {
  const detail = jiraDetail(res.body);
  const suffix = detail ? `: ${scrub(detail, auth)}` : "";
  const { status } = res;
  if (status === 401 || status === 403) {
    return `Jira rejected the credentials (HTTP ${status})${suffix}`;
  }
  if (status === 404) return `Not found in Jira${suffix}`;
  if (status === 429) return "Jira is rate limiting";
  if (status >= 500) return `Jira is unavailable (HTTP ${status})${suffix}`;
  return `Jira rejected the request (HTTP ${status})${suffix}`;
}

/**
 * The body for one issue's date write.
 *
 * `duedate` is a system field and identical everywhere; the start date is a
 * custom field whose id differs per site, which is the whole reason a snapshot
 * carries `fieldIds`. The key is validated here rather than at the call site
 * because it is about to be interpolated into a URL path.
 */
export function buildDatePayload(
  issueKey: string,
  span: WriteSpan,
  fieldIds: JiraFieldIds,
): DatePayload {
  if (!isIssueKey(issueKey)) {
    throw new JiraError("bad-response", `Not a Jira issue key: ${issueKey}`);
  }
  const startField = fieldIds.startDate ?? DEFAULT_START_DATE_FIELD_ID;
  return { fields: { [startField]: span.start, duedate: span.end } };
}

/** Every issue in a snapshot, by key: initiative, epics and their children. */
function issuesByKey(snapshot: JiraSnapshot): Map<string, JiraIssue> {
  const out = new Map<string, JiraIssue>();
  out.set(snapshot.initiative.key, snapshot.initiative);
  for (const epic of snapshot.epics) {
    out.set(epic.key, epic);
    for (const child of epic.children) out.set(child.key, child);
  }
  return out;
}

/**
 * What the draft would actually change in Jira — the preview, and the request
 * list, computed once so the two can never disagree.
 *
 * Items with no span are skipped (nothing to say about a row the draft could
 * not schedule), and so is every item whose Jira dates already match: those
 * are not "applied", they were never different, and sending them would be a
 * write with no content. An item the snapshot has never heard of is kept with
 * no current dates — it is a genuine change, and the summary falls back to the
 * key so the preview still names the row.
 */
export function dateChanges(
  items: readonly SprintDraftItem[],
  spans: ReadonlyMap<string, WriteSpan>,
  snapshot: JiraSnapshot,
): DateChange[] {
  const known = issuesByKey(snapshot);
  const out: DateChange[] = [];
  for (const item of items) {
    const span = spans.get(item.issueKey);
    if (!span) continue;
    const issue = known.get(item.issueKey);
    const currentStart = issue?.startDate;
    const currentDue = issue?.dueDate;
    if (currentStart === span.start && currentDue === span.end) continue;
    out.push({
      issueKey: item.issueKey,
      summary: issue?.summary ?? item.issueKey,
      currentStart,
      currentDue,
      nextStart: span.start,
      nextDue: span.end,
    });
  }
  return out;
}

/**
 * Write the dates, one issue at a time, reporting each outcome.
 *
 * Never throws for an individual issue: a rejected PUT, a malformed key and a
 * transport that blew up all come back as `ok: false` with a message the user
 * can act on, and the run continues. The single exception is a transport that
 * cannot write at all, which is a configuration mistake rather than a result,
 * and is refused before the first request leaves.
 */
export async function applyDates(
  transport: JiraTransport,
  options: ApplyDatesOptions,
): Promise<WriteResult[]> {
  const { baseUrl, auth, changes, fieldIds } = options;
  if (!transport.canWrite) {
    throw new JiraError(
      "network",
      "This device is not allowed to write to Jira.",
    );
  }

  const results: WriteResult[] = [];
  for (const change of changes) {
    const { issueKey } = change;
    let payload: DatePayload;
    try {
      payload = buildDatePayload(
        issueKey,
        { start: change.nextStart, end: change.nextDue },
        fieldIds,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ issueKey, ok: false, error: scrub(detail, auth) });
      continue;
    }

    let res: JiraResponse;
    try {
      res = await transport.request({
        baseUrl,
        path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
        method: "PUT",
        auth,
        body: payload,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      results.push({
        issueKey,
        ok: false,
        error: `Could not reach Jira: ${scrub(detail, auth)}`,
      });
      continue;
    }

    // A successful edit is a 204 with no body; 200 happens with
    // `returnIssue=true`, which we never ask for.
    if (res.status >= 200 && res.status < 300) {
      results.push({ issueKey, ok: true });
    } else {
      results.push({
        issueKey,
        ok: false,
        error: describeFailure(res, auth),
      });
    }
  }
  return results;
}
