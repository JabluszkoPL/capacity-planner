/**
 * Turning whatever the user pasted into `{ baseUrl, key }`.
 *
 * People do not copy issue links from one place. They copy the browse URL, the
 * new-issue-view URL, a board URL with the issue selected in the side panel, a
 * plan/timeline URL, or they just type the key because they know it by heart.
 * All of those identify the same issue, so all of them are accepted rather
 * than making the user reshape the link by hand.
 *
 * The host check is the security-relevant part: the parsed origin is later
 * handed to a transport that attaches the user's Jira credentials, so an
 * arbitrary host in a pasted link would be a credential-exfiltration link.
 * Only `*.atlassian.net` is trusted by default; a deployer on a custom domain
 * must name that host explicitly via {@link ParseIssueLinkOptions.allowedHosts}
 * (exact hostnames, no wildcards, no "allow everything" escape hatch).
 */

/** `/\b([A-Z][A-Z0-9_]+-\d+)\b/` — a Jira issue key such as `ACME-1234`. */
const KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;
const BARE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const TRUSTED_SUFFIX = ".atlassian.net";

export type ParseIssueLinkResult =
  | { ok: true; baseUrl: string; key: string }
  | { ok: false; reason: ParseIssueLinkFailure };

/**
 * - `no-key` — nothing in the input looks like an issue key.
 * - `no-host` — a bare key with no `fallbackBaseUrl` to attach it to, or a
 *   fallback that is not a usable URL.
 * - `untrusted-host` — a real URL, but not on a Jira site we are willing to
 *   send credentials to.
 */
export type ParseIssueLinkFailure = "no-key" | "no-host" | "untrusted-host";

export interface ParseIssueLinkOptions {
  /**
   * Extra hostnames to trust besides `*.atlassian.net`, for a Jira Data Center
   * install on a company domain. Exact, case-insensitive hostnames
   * (`"jira.acme.com"`) — never patterns, so a typo can only ever *fail* to
   * match. In the app this comes from the device-local Jira settings, which
   * only the person using the device can edit.
   */
  allowedHosts?: string[];
}

function hostAllowed(hostname: string, options?: ParseIssueLinkOptions) {
  const host = hostname.toLowerCase();
  if (host.endsWith(TRUSTED_SUFFIX)) return true;
  return (options?.allowedHosts ?? []).some(
    (h) => h.trim().toLowerCase() === host,
  );
}

function keyFromUrl(url: URL): string | undefined {
  // Path first: `/browse/KEY`, `/jira/software/c/projects/X/issues/KEY`.
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape sequence: keep the raw path rather than giving up.
  }
  const inPath = KEY_RE.exec(path);
  if (inPath) return inPath[1];
  // Then the board/plan side panel: `?selectedIssue=KEY`.
  const selected = url.searchParams.get("selectedIssue");
  if (selected) {
    const inParam = KEY_RE.exec(selected);
    if (inParam) return inParam[1];
  }
  return undefined;
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * Parse a pasted issue link (or bare key) into the site origin and issue key.
 *
 * `fallbackBaseUrl` is the site from the user's Jira settings; it is used only
 * when the input carries no host of its own, and is itself host-checked.
 */
export function parseIssueLink(
  input: string,
  fallbackBaseUrl?: string,
  options?: ParseIssueLinkOptions,
): ParseIssueLinkResult {
  const trimmed = (input ?? "").trim();
  if (trimmed === "") return { ok: false, reason: "no-key" };

  // A bare key: everything depends on the configured site.
  if (BARE_KEY_RE.test(trimmed)) {
    const base = parseUrl((fallbackBaseUrl ?? "").trim());
    if (!base) return { ok: false, reason: "no-host" };
    if (!hostAllowed(base.hostname, options)) {
      return { ok: false, reason: "untrusted-host" };
    }
    return { ok: true, baseUrl: base.origin, key: trimmed };
  }

  // Anything else is treated as a URL. A pasted link without its scheme
  // ("acme.atlassian.net/browse/ACME-1") is common enough to be worth
  // rescuing, and only when it still looks like a host.
  const url =
    parseUrl(trimmed) ??
    (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)
      ? parseUrl(`https://${trimmed}`)
      : undefined);
  if (!url) return { ok: false, reason: "no-host" };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "no-host" };
  }
  // Host before key: a link to the wrong site is the more important thing to
  // tell the user about, whether or not it happens to contain a key.
  if (!hostAllowed(url.hostname, options)) {
    return { ok: false, reason: "untrusted-host" };
  }
  const key = keyFromUrl(url);
  if (!key) return { ok: false, reason: "no-key" };
  return { ok: true, baseUrl: url.origin, key };
}

/** True for a well-formed issue key. Exported for callers that validate input
 *  before building a query (see jql.ts). */
export function isIssueKey(value: unknown): value is string {
  return typeof value === "string" && BARE_KEY_RE.test(value);
}
