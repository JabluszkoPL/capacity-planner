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
 */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ShareInfo {
  /** WebSocket URL this app's renderer syncs with, or null for local-only. */
  syncUrl: string | null;
  /** Where a browser on this Mac can open the shared app, or null. */
  shareUrl: string | null;
}

const DEFAULT_PORT = 5191;

let child: ChildProcess | null = null;

async function isPlannerServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { protocol?: unknown };
    return typeof body.protocol === "number";
  } catch {
    return false;
  }
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

  // Something already answers there — a `pnpm dev:server`, or the standalone
  // server. Join it rather than fight it for the port.
  if (await isPlannerServer(port)) return info;

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
