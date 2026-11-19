/**
 * What to do about whatever already answers on the share port — the pure half
 * of ./shareServer, kept apart so it can be tested without Electron.
 *
 * Three cases, and why they differ:
 *
 *  - **Nothing answers**: start the app's own server.
 *  - **A server a Planner app started** (its own leftover: an orphan after a
 *    crash, or the previous version still shutting down after an update):
 *    replace it. Joining it would leave the browser on the old version's web
 *    app, and the app without a server once that orphan notices its parent is
 *    gone and exits.
 *  - **A server the user runs** (`pnpm dev`, `pnpm serve`, a standalone box):
 *    join it, as before, but say so. It is not ours to kill, and by default it
 *    uses the same database file, so a second server beside it would be worse.
 *    The browser then shows *that* server's web app, which the About panel
 *    explains instead of leaving the user puzzled by an old version.
 */

/** The parts of `/health` this cares about. */
export interface ServerHealth {
  protocol: number;
  /** Null for servers built before they reported it. */
  version: string | null;
  /** Started by a Mac app (`PLANNER_EXIT_WITH_PARENT`). */
  managed: boolean;
  pid: number | null;
}

export type ShareStart =
  | { kind: "spawn" }
  /** Stop the server at this pid (when verified as a Planner app's own)
   *  and start ours. A null pid means "look up who holds the port". */
  | { kind: "replace"; pid: number | null }
  | { kind: "join"; foreignVersion: string | null };

/** Null when the body isn't a Planner sync server's health. */
export function parseHealth(body: unknown): ServerHealth | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.protocol !== "number") return null;
  return {
    protocol: b.protocol,
    version: typeof b.version === "string" ? b.version : null,
    managed: b.managed === true,
    pid:
      typeof b.pid === "number" && Number.isInteger(b.pid) && b.pid > 1
        ? b.pid
        : null,
  };
}

/**
 * Decide from `/health` alone, plus what the process holding the port turned
 * out to be when the server is too old to say (`holderIsAppServer`).
 */
export function decideShareStart(
  health: ServerHealth | null,
  holderIsAppServer: boolean,
): ShareStart {
  if (!health) return { kind: "spawn" };
  if (health.managed) return { kind: "replace", pid: health.pid };
  // Servers from before `managed` existed say nothing either way; the
  // process's command line settles it.
  if (health.version === null && holderIsAppServer) {
    return { kind: "replace", pid: null };
  }
  return { kind: "join", foreignVersion: health.version };
}

/**
 * True for a command line running a Planner app's bundled server. The Mac
 * app ships it as `sync-server.cjs`; `pnpm dev`/`pnpm serve` run
 * `dist/server.cjs`, so the two cannot be confused. This is the check made
 * before sending any signal, so a pid read from an HTTP response can never
 * aim it at an unrelated process.
 */
export function isAppServerCommand(command: string): boolean {
  return /[/\\]sync-server\.cjs(\s|$)/.test(command.trim());
}
