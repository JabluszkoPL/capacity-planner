import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
  /** The web build to serve at `/`, or null to serve only the API. */
  webDir: string | null;
}

/**
 * PLANNER_WEB_DIR when set; otherwise the repository's own web build if it
 * has been built (`pnpm build:web`), so `pnpm serve` needs no configuration.
 * The bundle lives at apps/server/dist/server.cjs, hence two levels up.
 */
function resolveWebDir(): string | null {
  const explicit = process.env.PLANNER_WEB_DIR;
  if (explicit) return explicit;
  const local = join(__dirname, "..", "..", "web", "dist");
  return existsSync(join(local, "index.html")) ? local : null;
}

/** Where the server keeps `state.sqlite` when nothing overrides it. */
export function defaultDataDir(): string {
  const dir =
    process.env.PLANNER_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "Planner");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(): ServerConfig {
  const port = Number(process.env.PLANNER_PORT ?? 5191);
  return {
    port: Number.isFinite(port) ? port : 5180,
    // Bind to all interfaces by default: the whole point of the sync server is
    // that another device on the same network can reach it.
    host: process.env.PLANNER_HOST ?? "0.0.0.0",
    dbPath: process.env.PLANNER_DB ?? join(defaultDataDir(), "state.sqlite"),
    webDir: resolveWebDir(),
  };
}
