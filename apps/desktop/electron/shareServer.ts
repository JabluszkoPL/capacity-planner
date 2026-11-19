/**
 * The Mac app's built-in sync server — what lets a browser see the same data.
 *
 * On launch the app starts the ordinary sync server (apps/server, bundled to
 * dist/sync-server.cjs by build.mjs) as a child process on 127.0.0.1:5191 and
 * connects to it like any other device. The same server also serves the web
 * app, so opening http://localhost:5191 in Safari, Chrome or Firefox shows the
 * same projects, kept in step live.
 *
 * It is a child process rather than code in this one for two reasons: the
 * desktop app never imports another app (the server is shipped as a built
 * file), and a server problem can't take the window down with it.
 *
 * It listens on loopback only. There is no authentication, so sharing with
 * other machines is a deliberate step — run the standalone server for that
 * (docs/SYNC.md). If anything here fails the app simply stays local-only,
 * which is exactly how it behaved before this existed.
 *
 * When something already answers on the port, ./shareDecision says whether
 * it is this app's own leftover server (replaced, so an update never leaves
 * the browser on the old version) or one the user runs (joined, and reported
 * to the About panel through `foreign`).
 */
import { app } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  decideShareStart,
  isAppServerCommand,
  parseHealth,
  type ServerHealth,
} from "./shareDecision";

const run = promisify(execFile);

export interface ShareInfo {
  /** WebSocket URL this app's renderer syncs with, or null for local-only. */
  syncUrl: string | null;
  /** Where a browser on this Mac can open the shared app, or null. */
  shareUrl: string | null;
  /**
   * Set when the port was already held by a server the user runs (`pnpm dev`,
   * a standalone server) and the app joined it instead of starting its own.
   * The browser then shows that server's web app, whatever its version.
   */
  foreign?: { version: string | null } | null;
}

const DEFAULT_PORT = 5191;

let child: ChildProcess | null = null;

async function readHealth(port: number): Promise<ServerHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    return parseHealth(await res.json());
  } catch {
    return null;
  }
}

async function isPlannerServer(port: number): Promise<boolean> {
  return (await readHealth(port)) !== null;
}

/** The pid listening on `port`, via lsof (always present on macOS). */
async function portHolder(port: number): Promise<number | null> {
  try {
    const { stdout } = await run("/usr/sbin/lsof", [
      "-nP",
      "-t",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
    ]);
    const pid = Number(stdout.trim().split("\n")[0]);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

async function commandOf(pid: number): Promise<string> {
  try {
    const { stdout } = await run("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "command=",
    ]);
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Stop a Planner app's leftover server and wait for the port to free up.
 * The pid is only signalled after its command line proves it is one.
 */
async function replaceAppServer(
  port: number,
  pid: number | null,
): Promise<boolean> {
  const target = pid ?? (await portHolder(port));
  if (target === null || target === process.pid) return false;
  if (!isAppServerCommand(await commandOf(target))) return false;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await isPlannerServer(port))) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function waitForServer(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) return false;
    if (await isPlannerServer(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Packaged: unpacked from the asar so a plain Node process can read them. */
function resourcePaths(): { script: string; webDir: string | null } {
  if (app.isPackaged) {
    const base = join(process.resourcesPath, "app.asar.unpacked");
    return {
      script: join(base, "dist", "sync-server.cjs"),
      webDir: join(base, "renderer"),
    };
  }
  const webDir = resolve(__dirname, "../../web/dist");
  return {
    script: join(__dirname, "sync-server.cjs"),
    webDir: existsSync(join(webDir, "index.html")) ? webDir : null,
  };
}

export async function startShareServer(dataDir: string): Promise<ShareInfo> {
  // An explicit server wins: the user has their own (e.g. a team box).
  const explicit = process.env.PLANNER_SYNC_URL;
  if (explicit) return { syncUrl: explicit, shareUrl: null };
  if (process.env.PLANNER_SHARE === "0") {
    return { syncUrl: null, shareUrl: null };
  }

  const port = Number(process.env.PLANNER_SHARE_PORT ?? DEFAULT_PORT);
  const info: ShareInfo = {
    syncUrl: `ws://127.0.0.1:${port}/ws`,
    shareUrl: `http://localhost:${port}`,
  };

  const health = await readHealth(port);
  if (health) {
    // Only servers too old to report an owner need the process lookup.
    let holderIsAppServer = false;
    if (health.version === null && !health.managed) {
      const holder = await portHolder(port);
      holderIsAppServer =
        holder !== null && isAppServerCommand(await commandOf(holder));
    }
    const decision = decideShareStart(health, holderIsAppServer);
    if (decision.kind === "join") {
      console.warn(
        `[planner] port ${port} is held by another Planner server` +
          (decision.foreignVersion ? ` (v${decision.foreignVersion})` : "") +
          "; syncing with it",
      );
      return { ...info, foreign: { version: decision.foreignVersion } };
    }
    if (decision.kind === "replace") {
      console.log(`[planner] replacing a leftover Planner server on ${port}`);
      if (!(await replaceAppServer(port, decision.pid))) {
        // Couldn't clear it: joining is still better than local-only.
        return { ...info, foreign: { version: health.version } };
      }
    }
  }

  const { script, webDir } = resourcePaths();
  if (!existsSync(script)) {
    console.warn(`[planner] sync server not bundled at ${script}; local-only`);
    return { syncUrl: null, shareUrl: null };
  }

  child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      // Run Electron's own binary as plain Node: same Node, so node:sqlite is
      // there, and nothing extra ships with the app.
      ELECTRON_RUN_AS_NODE: "1",
      PLANNER_PORT: String(port),
      PLANNER_HOST: "127.0.0.1",
      PLANNER_DB: join(dataDir, "state.sqlite"),
      PLANNER_EXIT_WITH_PARENT: "1",
      ...(webDir ? { PLANNER_WEB_DIR: webDir } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  child.on("exit", (code) => {
    if (code) console.warn(`[planner] sync server exited with ${code}`);
    child = null;
  });

  if (await waitForServer(port, 5000)) return info;
  console.warn("[planner] sync server did not start; local-only");
  stopShareServer();
  return { syncUrl: null, shareUrl: null };
}

export function stopShareServer(): void {
  child?.kill("SIGTERM");
  child = null;
}
