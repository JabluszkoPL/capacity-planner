/**
 * The Electron host, as seen from the renderer.
 *
 * Present only in the Mac app; in a browser tab `window.planner` is undefined
 * and the app falls back to its own storage. Keeping the detection in one typed
 * place means the rest of the app never reaches for `window` and never has to
 * ask which build it is running in.
 */
import type { LocalStoreBridge } from "@planner/client-runtime";
import type { UpdateState } from "@planner/core";
import type { JiraRequest, JiraResponse } from "@planner/jira";

/** The Mac app's self-updater. See apps/desktop/electron/updater.ts. */
export interface PlannerUpdatesBridge {
  state(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  /** Quits and relaunches the app on the new version. */
  install(): Promise<UpdateState>;
  onChange(fn: (state: UpdateState) => void): () => void;
}

/** The Mac app's built-in sync server, as far as the UI needs to know. */
export interface PlannerShareBridge {
  /** e.g. "http://localhost:5191", or null when sharing is off. */
  url: string | null;
  /**
   * Set when that URL belongs to a server the user runs (e.g. `pnpm dev`)
   * that the app joined instead of starting its own: its version, or
   * "unknown". The browser then shows that server's web app. Null or absent
   * when the app runs its own server (absent on older hosts).
   */
  foreignVersion?: string | null;
  /** Open that URL in the user's default browser. */
  open(): Promise<void>;
  stop?(): Promise<void>;
}

/**
 * Jira, as reachable from the Mac app.
 *
 * Present only in Electron, and the reason it exists at all is CORS: Jira
 * Cloud refuses browser cross-origin requests, but the main process is not a
 * browser. See apps/desktop/electron/jira.ts for what it will and won't relay.
 */
export interface PlannerJiraBridge {
  request(req: JiraRequest): Promise<JiraResponse>;
  canWrite: boolean;
}

/** The MCP endpoint's settings and status, as the main process reports them. */
export interface McpHostState {
  enabled: boolean;
  allowWrites: boolean;
  /** The bearer token clients must send. Shown so it can be copied. */
  token: string;
  /** e.g. "http://127.0.0.1:5192/mcp". */
  url: string;
  status: "off" | "starting" | "listening" | "error";
  error?: string;
}

/**
 * What the window sends back for one tool call: the result to show the
 * client, or a message saying why it could not be done.
 */
export type McpCallReply = { result: unknown } | { error: string };

/**
 * The Mac app's MCP endpoint (apps/desktop/electron/mcpHost.ts). The main
 * process holds the socket and the token; tool calls arrive here because the
 * store is here, and every edit has to go through it.
 */
export interface PlannerMcpBridge {
  state(): Promise<McpHostState>;
  update(patch: {
    enabled?: boolean;
    allowWrites?: boolean;
  }): Promise<McpHostState>;
  regenerateToken(): Promise<McpHostState>;
  onChange(fn: (state: McpHostState) => void): () => void;
  /** Start taking tool calls; returns the function that stops. */
  serve(
    handler: (
      name: string,
      args: unknown,
      allowWrites: boolean,
    ) => Promise<McpCallReply>,
  ): () => void;
}

export interface PlannerHost {
  db: LocalStoreBridge;
  /** Sync server URL configured by the host, if any. */
  syncUrl: string | null;
  /** Absent on a host that predates Jira tracking. */
  jira?: PlannerJiraBridge;
  /** Absent on a host that predates self-updating. */
  updates?: PlannerUpdatesBridge;
  share?: PlannerShareBridge;
  /** Absent on a host that predates MCP. */
  mcp?: PlannerMcpBridge;
  /** Planner's version as the host was built; null on older hosts. */
  appVersion?: string | null;
  platform: string;
  /** Electron's version. */
  version: string;
}

declare global {
  interface Window {
    planner?: PlannerHost;
  }
}

export function hostBridge(): PlannerHost | null {
  return typeof window !== "undefined" && window.planner
    ? window.planner
    : null;
}

/**
 * Record the host on the document element so stylesheets can respond to it.
 *
 * Window chrome is the one thing that genuinely differs between running in a
 * tab and running as a Mac app, and it is purely a layout concern — an
 * attribute CSS can select on beats threading a prop down the tree.
 */
export function applyHostAttributes(): void {
  const host = hostBridge();
  if (!host) return;
  document.documentElement.dataset.host = "electron";
  document.documentElement.dataset.platform = host.platform;
}
