/**
 * Jira credentials and connection preferences, kept on this device only.
 *
 * These deliberately do NOT live in `AppState`. Everything in AppState is
 * diffed into ops, pushed to the sync server, replicated to every other device
 * and included in the JSON export — all of which are the wrong places for an
 * API token. Keeping them in localStorage means the token stays where it was
 * typed, and the worst case of losing it is retyping it on that one machine.
 *
 * Every accessor swallows its errors: Safari in private mode throws on the
 * first `localStorage` read, and an app that cannot show a project because it
 * could not read a Jira token would be absurd.
 */

export const JIRA_SETTINGS_KEY = "planner_jira_v1";

/** Hours of Jira time tracking that make one Planner day, when unset. */
export const DEFAULT_HOURS_PER_DAY = 8;

export interface JiraSettings {
  /** Site origin, e.g. "https://acme.atlassian.net". */
  baseUrl: string;
  /** Atlassian account email — the username half of Basic auth. */
  email: string;
  /** API token from id.atlassian.com. Never leaves this device except as an
   *  Authorization header on a request to `baseUrl`. */
  apiToken: string;
  /** Conversion used for every Jira duration shown as days. */
  hoursPerDay: number;
  /**
   * Whether this device may write to Jira at all. Off by default: reading is
   * harmless, and a stray click that rewrites due dates on somebody else's
   * board is not. The transport can also refuse writes independently.
   */
  allowWrites: boolean;
  /**
   * Atlassian organization id, for reading the Teams directory. Found
   * automatically the first time and remembered here; blank = not known yet.
   * Not a secret, but it is per-site device configuration like the rest.
   */
  orgId?: string;
}

export const EMPTY_SETTINGS: JiraSettings = {
  baseUrl: "",
  email: "",
  apiToken: "",
  hoursPerDay: DEFAULT_HOURS_PER_DAY,
  allowWrites: false,
};

/** True when there is enough here to attempt an authenticated request. */
export function isJiraConfigured(s: JiraSettings): boolean {
  return (
    s.baseUrl.trim().length > 0 &&
    s.email.trim().length > 0 &&
    s.apiToken.trim().length > 0
  );
}

function coerce(value: unknown): JiraSettings {
  if (typeof value !== "object" || value === null) return { ...EMPTY_SETTINGS };
  const v = value as Record<string, unknown>;
  const hours = Number(v.hoursPerDay);
  return {
    baseUrl: typeof v.baseUrl === "string" ? v.baseUrl : "",
    email: typeof v.email === "string" ? v.email : "",
    apiToken: typeof v.apiToken === "string" ? v.apiToken : "",
    hoursPerDay:
      Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS_PER_DAY,
    allowWrites: v.allowWrites === true,
    ...(typeof v.orgId === "string" && v.orgId.trim() !== ""
      ? { orgId: v.orgId.trim() }
      : {}),
  };
}

export function readJiraSettings(): JiraSettings {
  try {
    const raw = localStorage.getItem(JIRA_SETTINGS_KEY);
    if (!raw) return { ...EMPTY_SETTINGS };
    return coerce(JSON.parse(raw));
  } catch {
    return { ...EMPTY_SETTINGS };
  }
}

export function writeJiraSettings(next: JiraSettings): void {
  try {
    localStorage.setItem(JIRA_SETTINGS_KEY, JSON.stringify(coerce(next)));
  } catch {
    // Storage full or blocked. The settings still apply to this session —
    // they are held in React state by the panel that just wrote them.
  }
  notify();
}

export function clearJiraSettings(): void {
  try {
    localStorage.removeItem(JIRA_SETTINGS_KEY);
  } catch {
    // Nothing to do: the key is either already gone or unreachable.
  }
  notify();
}

/* ------------------------------ subscription ----------------------------- */

/**
 * Settings are read by panels that are not in the same React tree (the header
 * summary, the settings modal, every tracker's refresh button), and there is
 * exactly one writer. A two-line emitter beats threading context through the
 * app for a value that changes a handful of times per session.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

export function subscribeJiraSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
