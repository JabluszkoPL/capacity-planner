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

export interface PlannerHost {
  db: LocalStoreBridge;
  /** Sync server URL configured by the host, if any. */
  syncUrl: string | null;
  /** Absent on a host that predates Jira tracking. */
  jira?: PlannerJiraBridge;
  /** Absent on a host that predates self-updating. */
  updates?: PlannerUpdatesBridge;
  share?: PlannerShareBridge;
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
