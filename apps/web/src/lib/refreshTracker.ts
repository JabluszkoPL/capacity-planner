/**
 * One press of Refresh, end to end.
 *
 * Pulling this out of the components keeps two things honest. The list page's
 * "Refresh all" and a single tracker's Refresh button run exactly the same
 * code, so they cannot drift; and the failure vocabulary lives in one place,
 * which matters because "Jira rejected the token" and "this browser cannot
 * reach Jira at all" need very different words and very different fixes.
 *
 * Nothing here throws. A refresh that fails returns a result the caller shows
 * as a toast, and the tracker keeps the snapshot it already had — a stale
 * snapshot is far more useful than an empty panel.
 */
import {
  JiraError,
  basicAuth,
  fetchInitiativeSnapshot,
  type JiraTransport,
} from "@planner/jira";
import {
  autoTaskMap,
  sampleFromStatus,
  trackerStatus,
  type AppState,
  type Tracker,
  type TrackerSample,
  type JiraSnapshot,
} from "@planner/core";
import { isJiraConfigured, type JiraSettings } from "./jiraSettings";
import { JiraUnavailableError } from "./jiraTransport";

export type RefreshOutcome =
  | {
      ok: true;
      snapshot: JiraSnapshot;
      sample: TrackerSample | null;
      taskMap: NonNullable<Tracker["taskMap"]> | null;
    }
  | { ok: false; message: string; kind: RefreshFailure };

export type RefreshFailure =
  | "not-configured"
  | "unavailable"
  | "auth"
  | "not-found"
  | "rate-limited"
  | "network"
  | "unknown";

/** Turn a failure into something the user can act on. */
function describe(err: unknown, trackerKey: string): RefreshOutcome {
  // A transport that cannot reach Jira at all throws its own error, which the
  // Jira client wraps as `network`. Unwrap it first: "open the Mac app" and
  // "check your connection" are different instructions.
  const unavailable =
    err instanceof JiraUnavailableError
      ? err
      : err instanceof JiraError && err.cause instanceof JiraUnavailableError
        ? err.cause
        : null;
  if (unavailable) {
    return { ok: false, kind: "unavailable", message: unavailable.message };
  }
  if (err instanceof JiraError) {
    switch (err.kind) {
      case "auth":
        return {
          ok: false,
          kind: "auth",
          // Jira answers both with 401/403, but they mean different things: a
          // 401 means the credentials themselves were rejected. A 403 can
          // happen at any later request, so name that request rather than
          // incorrectly blaming the issue's Browse Projects permission.
          message:
            err.status === 403
              ? err.requestPath?.startsWith("/rest/api/3/issue/")
                ? "Jira accepted your email and token, but denied access to this issue. Ask a Jira admin for permission to browse this project."
                : err.requestPath === "/rest/api/3/field"
                  ? "Jira accepted your email and token, but denied access to Jira field metadata."
                  : err.requestPath === "/rest/api/3/search/jql"
                    ? "Jira accepted your email and token, but denied the JQL search used to download this initiative."
                    : "Jira accepted your email and token, but denied a data request."
              : "Jira rejected your email and token. Check them in Jira settings.",
        };
      case "not-found":
        return {
          ok: false,
          kind: "not-found",
          message: `${trackerKey} does not exist, or your account cannot see it.`,
        };
      case "rate-limited":
        return {
          ok: false,
          kind: "rate-limited",
          message: "Jira is rate-limiting this account. Try again in a minute.",
        };
      case "network":
        return {
          ok: false,
          kind: "network",
          message: "Could not reach Jira. Check your connection.",
        };
      case "unavailable":
        return {
          ok: false,
          kind: "network",
          message: "Jira is returning errors right now. Try again shortly.",
        };
      default:
        return { ok: false, kind: "unknown", message: err.message };
    }
  }
  return {
    ok: false,
    kind: "unknown",
    message: err instanceof Error ? err.message : "Refresh failed.",
  };
}

export interface RefreshDeps {
  tracker: Tracker;
  settings: JiraSettings;
  transport: JiraTransport;
  /** Needed to compute the sample; the tracker's baseline lives in here. */
  state: AppState;
  /** ISO date "today", so the caller controls the clock. */
  today: string;
  /** ISO datetime stamped on the snapshot. */
  now: string;
}

/**
 * Fetch a fresh snapshot and, when the tracker has a usable baseline, the
 * sample that goes with it.
 *
 * The sample is computed here rather than in the reducer because it depends on
 * re-running the scheduler, which is far too much work to do inside a
 * dispatch — and because a refresh without a baseline plan is still perfectly
 * useful, it just has no variance to record.
 */
export async function refreshTracker(
  deps: RefreshDeps,
): Promise<RefreshOutcome> {
  const { tracker, settings, transport, state, today, now } = deps;

  if (!isJiraConfigured(settings)) {
    return {
      ok: false,
      kind: "not-configured",
      message: "Connect Jira first — add your site, email and API token.",
    };
  }

  let snapshot: JiraSnapshot;
  try {
    snapshot = await fetchInitiativeSnapshot(transport, {
      // The tracker remembers the site its link came from, so two trackers on
      // two different Jira sites both work even though the credentials in
      // settings name only one.
      baseUrl: tracker.baseUrl || settings.baseUrl,
      auth: basicAuth(settings.email, settings.apiToken),
      key: tracker.initiativeKey,
      now,
    });
  } catch (err) {
    return describe(err, tracker.initiativeKey);
  }

  const project = tracker.projectId
    ? state.projects.find((p) => p.id === tracker.projectId)
    : undefined;
  const taskMap = project
    ? autoTaskMap(project, snapshot, tracker.taskMap)
    : null;
  const status = trackerStatus(
    { ...tracker, snapshot, ...(taskMap ? { taskMap } : {}) },
    project,
    state.teams,
    today,
  );
  const sample =
    status.kind === "no-baseline" ? null : sampleFromStatus(status);

  return { ok: true, snapshot, sample, taskMap };
}

/** Whole days since a snapshot was taken, or null when there is none. */
export function snapshotAgeDays(tracker: Tracker, now: string): number | null {
  const at = tracker.snapshot?.fetchedAt;
  if (!at) return null;
  const then = Date.parse(at);
  const current = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return null;
  return Math.floor((current - then) / 86_400_000);
}

/** A snapshot older than this is worth a visible nudge. */
export const STALE_AFTER_DAYS = 3;
