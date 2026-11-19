/**
 * The MCP endpoint's life in the main process: its settings, starting and
 * stopping it, and relaying each tool call to the window.
 *
 * Tools run in the renderer, not here, because that is where the app's state
 * lives and where an edit has to start to persist and sync like any other: the
 * window's store dispatches the tool's actions through the same reducer as a
 * click. UI tools need the window anyway. The main process only holds the
 * socket, the token and the switches.
 *
 * The renderer never sees a request, only `{ name, args }`; it never answers
 * the client, only this process. And the window's Jira credentials stay in its
 * own storage: no tool asks for them and none of them could be relayed.
 */
import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { toolError, toolResult, type CallToolResult } from "@planner/mcp";
import { CHANNELS } from "./ipc";
import {
  loadMcpSettings,
  saveMcpSettings,
  generateToken,
  type McpSettings,
} from "./mcpSettings";
import { startMcpServer, type RunningMcpServer } from "./mcpServer";

/** A tool that takes longer than this has hung (the window froze or closed). */
const CALL_TIMEOUT_MS = 30_000;

export interface McpState {
  enabled: boolean;
  allowWrites: boolean;
  token: string;
  /** The endpoint URL, whether or not it is listening. */
  url: string;
  status: "off" | "starting" | "listening" | "error";
  error?: string;
}

interface Pending {
  resolve(result: CallToolResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createMcpHost(options: { dataDir: string; version: string }) {
  const file = join(options.dataDir, "mcp.json");
  let settings: McpSettings = loadMcpSettings(file);
  const envPort = Number(process.env.PLANNER_MCP_PORT);
  const port =
    Number.isInteger(envPort) && envPort > 0 ? envPort : settings.port;
  let server: RunningMcpServer | null = null;
  let status: McpState["status"] = "off";
  let error: string | undefined;
  /** webContents ids of windows whose bridge is listening for calls. */
  const ready = new Set<number>();
  const pending = new Map<string, Pending>();

  const state = (): McpState => ({
    enabled: settings.enabled,
    allowWrites: settings.allowWrites,
    token: settings.token,
    url: `http://127.0.0.1:${port}/mcp`,
    status,
    ...(error ? { error } : {}),
  });

  const broadcast = () => {
    const s = state();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(CHANNELS.mcpChanged, s);
    }
  };

  function callInWindow(
    name: string,
    args: Record<string, unknown>,
    opts: { allowWrites: boolean },
  ): Promise<CallToolResult> {
    const window = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && ready.has(w.webContents.id),
    );
    if (!window) {
      return Promise.resolve(
        toolError(
          "The Planner window is not open. Open Planner (or one of its windows) and try again.",
        ),
      );
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(toolError("Planner did not answer in time."));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      window.webContents.send(CHANNELS.mcpCall, {
        id,
        name,
        args,
        allowWrites: opts.allowWrites,
      });
    });
  }

  async function start(): Promise<void> {
    if (server) return;
    status = "starting";
    error = undefined;
    broadcast();
    try {
      server = await startMcpServer({
        port,
        version: options.version,
        settings: () => ({
          token: settings.token,
          allowWrites: settings.allowWrites,
        }),
        callTool: callInWindow,
        log: (line) => console.log(`[mcp] ${line}`),
      });
      status = "listening";
      console.log(`[planner] MCP server on ${state().url}`);
    } catch (err) {
      server = null;
      status = "error";
      const code = (err as NodeJS.ErrnoException).code;
      error =
        code === "EADDRINUSE"
          ? `Port ${port} is already in use (another Planner, perhaps a development build?).`
          : (err as Error).message;
      console.warn(`[planner] MCP server did not start: ${error}`);
    }
    broadcast();
  }

  async function stop(): Promise<void> {
    const s = server;
    server = null;
    status = "off";
    error = undefined;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve(toolError("Planner's MCP server was turned off."));
      pending.delete(id);
    }
    await s?.close();
    broadcast();
  }

  function register(): void {
    ipcMain.handle(CHANNELS.mcpState, () => state());
    ipcMain.handle(CHANNELS.mcpUpdate, async (_e, patch: unknown) => {
      const p =
        typeof patch === "object" && patch !== null
          ? (patch as Record<string, unknown>)
          : {};
      const next = { ...settings };
      if (typeof p.enabled === "boolean") next.enabled = p.enabled;
      if (typeof p.allowWrites === "boolean") next.allowWrites = p.allowWrites;
      settings = next;
      saveMcpSettings(file, settings);
      if (settings.enabled && !server) await start();
      else if (!settings.enabled && server) await stop();
      else broadcast();
      return state();
    });
    ipcMain.handle(CHANNELS.mcpRegenerateToken, () => {
      settings = { ...settings, token: generateToken() };
      saveMcpSettings(file, settings);
      broadcast();
      return state();
    });
    ipcMain.handle(CHANNELS.mcpReady, (e, on: unknown) => {
      if (on === true) ready.add(e.sender.id);
      else ready.delete(e.sender.id);
    });
    ipcMain.handle(CHANNELS.mcpResult, (_e, id: unknown, reply: unknown) => {
      if (typeof id !== "string") return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      const r =
        typeof reply === "object" && reply !== null
          ? (reply as { error?: unknown; result?: unknown })
          : {};
      p.resolve(
        typeof r.error === "string"
          ? toolError(r.error)
          : toolResult(r.result ?? null),
      );
    });
  }

  return {
    register,
    /** Called once at launch: starts the endpoint if the user left it on. */
    async boot(): Promise<void> {
      if (settings.enabled) await start();
    },
    /** A window went away: it can no longer take calls. */
    forget(webContentsId: number): void {
      ready.delete(webContentsId);
    },
    stop,
  };
}
