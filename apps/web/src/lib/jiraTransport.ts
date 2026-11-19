/**
 * Picking a way to reach Jira, for whichever host the app finds itself in.
 *
 * This mirrors `runtime.ts`, which picks a LocalStore the same way and for the
 * same reason: one bundle serves the browser and the Mac app, and the choice
 * is made here so that no component above ever asks which build it is running
 * in. What differs is only *whether a cross-origin request to Atlassian is
 * possible at all* — Jira Cloud sends no CORS headers, so:
 *
 *  - the Mac app calls from Electron's main process, where CORS does not exist;
 *  - a browser goes through the sync server's `/api/jira` proxy;
 *  - a browser with no sync server cannot refresh, and says so rather than
 *    failing at the moment somebody presses the button.
 *
 * The last case is a real configuration, not an error: trackers and their last
 * synced snapshot stay perfectly readable without it.
 */
import type { JiraRequest, JiraResponse, JiraTransport } from "@planner/jira";
import { hostBridge } from "./hostBridge";
import { syncUrl } from "../runtime";

/** Why a transport cannot run, in words a user can act on. */
export class JiraUnavailableError extends Error {
  readonly kind = "unavailable";
  constructor(message: string) {
    super(message);
    this.name = "JiraUnavailableError";
  }
}

/** Where a transport sends its requests — surfaced so the UI can explain. */
export type JiraTransportKind = "electron" | "proxy" | "dev-proxy" | "none";

export interface AppJiraTransport extends JiraTransport {
  readonly kind: JiraTransportKind;
  /**
   * A short phrase that completes "Refresh runs …", e.g. "via the Planner sync
   * server". Deliberately not a sentence: it is always rendered inside one, and
   * a sentence here reads as a stutter wherever it is embedded.
   */
  readonly description: string;
  /**
   * The full explanation, set only when there is no way to reach Jira. The UI
   * shows this instead of the description, because at that point the user needs
   * the reason and the remedy, not a phrase.
   */
  readonly unavailableReason?: string;
}

/* ------------------------------ the browser ------------------------------ */

/** Path prefix the Vite dev server proxies when VITE_JIRA_DEV_TARGET is set. */
const DEV_PREFIX = "/jira-dev";
/** Path prefix served by the sync server (see apps/server/src/jiraProxy). */
const PROXY_PREFIX = "/api/jira";
const BASE_HEADER = "x-planner-jira-base";

/**
 * Turn the sync server's WebSocket URL into the http(s) origin its REST routes
 * live on. They are the same server, reached over the same host and port.
 */
export function proxyOriginFromSyncUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function httpTransport(
  origin: string,
  prefix: string,
  kind: JiraTransportKind,
  description: string,
  canWrite: boolean,
  fetchImpl: typeof fetch,
): AppJiraTransport {
  return {
    kind,
    description,
    canWrite,
    async request(req: JiraRequest): Promise<JiraResponse> {
      let response: Response;
      try {
        response = await fetchImpl(`${origin}${prefix}${req.path}`, {
          method: req.method,
          headers: {
            authorization: req.auth,
            accept: "application/json",
            [BASE_HEADER]: req.baseUrl,
            // Atlassian's XSRF check rejects POST/PUT calls without this,
            // even for plain API clients with no cookie/session involved —
            // required for e.g. the JQL search endpoint refresh depends on.
            "x-atlassian-token": "no-check",
            ...(req.experimental && req.experimental.length > 0
              ? { "x-experimentalapi": req.experimental.join(",") }
              : {}),
            ...(req.body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        });
      } catch (err) {
        // A network-level failure here is the proxy being unreachable, not
        // Jira refusing — worth distinguishing, because the fix is different.
        const reason = err instanceof Error ? err.message : "unknown error";
        throw new JiraUnavailableError(
          `Could not reach the Planner server: ${reason}`,
        );
      }
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const retryAfter = response.headers.get("retry-after");
      return {
        status: response.status,
        body,
        ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
      };
    },
  };
}

/* ------------------------------- the Mac app ----------------------------- */

function electronTransport(
  bridge: NonNullable<ReturnType<typeof hostBridge>>["jira"],
): AppJiraTransport | null {
  if (!bridge) return null;
  return {
    kind: "electron",
    description: "directly from the Planner app",
    canWrite: bridge.canWrite,
    request: (req) => bridge.request(req),
  };
}

/* -------------------------------- nothing -------------------------------- */

export function unavailableJiraTransport(reason: string): AppJiraTransport {
  return {
    kind: "none",
    description: "nowhere — Jira is out of reach from here",
    unavailableReason: reason,
    canWrite: false,
    request() {
      return Promise.reject(new JiraUnavailableError(reason));
    },
  };
}

/* -------------------------------- the pick ------------------------------- */

export interface TransportDeps {
  host?: ReturnType<typeof hostBridge>;
  sync?: string | null;
  devTarget?: string | undefined;
  fetchImpl?: typeof fetch;
}

/**
 * Choose a transport. Dependencies are injectable so the choice itself can be
 * tested without standing up Electron or a server.
 *
 * Each dependency is detected with `in` rather than by comparing to
 * `undefined`, so passing `devTarget: undefined` means "there is no dev target"
 * instead of "go and read the ambient one". The difference is not academic: a
 * developer with VITE_JIRA_DEV_TARGET set in their own `.env` would otherwise
 * see a test asserting "no way to reach Jira" quietly pick up their proxy and
 * pass for the wrong reason.
 */
export function createJiraTransport(
  deps: TransportDeps = {},
): AppJiraTransport {
  const host = "host" in deps ? deps.host : hostBridge();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const viaElectron = electronTransport(host?.jira);
  if (viaElectron) return viaElectron;

  const sync = "sync" in deps ? deps.sync : syncUrl();
  if (sync) {
    const origin = proxyOriginFromSyncUrl(sync);
    if (origin) {
      return httpTransport(
        origin,
        PROXY_PREFIX,
        "proxy",
        "via the Planner sync server",
        // Whether the server will actually accept a write is its decision; the
        // UI confirms it from /health before offering write-back.
        true,
        fetchImpl,
      );
    }
  }

  const devTarget =
    "devTarget" in deps ? deps.devTarget : import.meta.env.VITE_JIRA_DEV_TARGET;
  if (devTarget) {
    return httpTransport(
      "",
      DEV_PREFIX,
      "dev-proxy",
      "via the Vite dev proxy",
      true,
      fetchImpl,
    );
  }

  return unavailableJiraTransport(
    "Refreshing needs the Planner Mac app or a sync server — a browser cannot call Jira directly.",
  );
}
