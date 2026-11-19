/**
 * The context bridge.
 *
 * The renderer runs with `contextIsolation` on and `nodeIntegration` off, so
 * this is the only surface it has into the host: eight database calls, the
 * narrow Jira relay (see ./jira for what it refuses), the updater's verbs (see
 * ./updater), the MCP endpoint's settings and its tool calls (see ./mcpHost),
 * opening the shared app in a browser, and a few read-only facts.
 * No filesystem, no shell, no arbitrary IPC.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS } from "./ipc";

const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args);

/** `--planner-<name>=<value>` from the main process's additionalArguments. */
function arg(name: string): string | null {
  const prefix = `--planner-${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

contextBridge.exposeInMainWorld("planner", {
  db: {
    deviceId: () => invoke(CHANNELS.deviceId),
    read: () => invoke(CHANNELS.read),
    applyLocal: (ops: unknown) => invoke(CHANNELS.applyLocal, ops),
    applyRemote: (ops: unknown, cursor: number) =>
      invoke(CHANNELS.applyRemote, ops, cursor),
    pending: () => invoke(CHANNELS.pending),
    ackThrough: (seq: number) => invoke(CHANNELS.ackThrough, seq),
    cursor: () => invoke(CHANNELS.cursor),
    resetCursor: () => invoke(CHANNELS.resetCursor),
  },
  jira: {
    request: (req: unknown) => invoke(CHANNELS.jiraRequest, req),
    // The Mac app can write; whether the user wants it to is a setting in the
    // app itself, and the request still has to pass the main process's guard.
    canWrite: true,
  },
  updates: {
    state: () => invoke(CHANNELS.updateState),
    check: () => invoke(CHANNELS.updateCheck),
    download: () => invoke(CHANNELS.updateDownload),
    install: () => invoke(CHANNELS.updateInstall),
    onChange: (fn: (state: unknown) => void) => {
      const listener = (_e: IpcRendererEvent, state: unknown) => fn(state);
      ipcRenderer.on(CHANNELS.updateChanged, listener);
      return () => {
        ipcRenderer.removeListener(CHANNELS.updateChanged, listener);
      };
    },
  },
  mcp: {
    state: () => invoke(CHANNELS.mcpState),
    update: (patch: unknown) => invoke(CHANNELS.mcpUpdate, patch),
    regenerateToken: () => invoke(CHANNELS.mcpRegenerateToken),
    onChange: (fn: (state: unknown) => void) => {
      const listener = (_e: IpcRendererEvent, state: unknown) => fn(state);
      ipcRenderer.on(CHANNELS.mcpChanged, listener);
      return () => {
        ipcRenderer.removeListener(CHANNELS.mcpChanged, listener);
      };
    },
    /**
     * Take tool calls: the window runs each one against its store and the
     * reply goes back to the main process, never straight to a client.
     */
    serve: (
      handler: (
        name: string,
        args: unknown,
        allowWrites: boolean,
      ) => Promise<unknown>,
    ) => {
      const listener = (_e: IpcRendererEvent, call: unknown) => {
        const c = (call ?? {}) as {
          id?: unknown;
          name?: unknown;
          args?: unknown;
          allowWrites?: unknown;
        };
        if (typeof c.id !== "string" || typeof c.name !== "string") return;
        const id = c.id;
        Promise.resolve()
          .then(() =>
            handler(c.name as string, c.args ?? {}, c.allowWrites === true),
          )
          .then(
            (reply) => invoke(CHANNELS.mcpResult, id, reply),
            (err: unknown) =>
              invoke(CHANNELS.mcpResult, id, {
                error: err instanceof Error ? err.message : String(err),
              }),
          );
      };
      ipcRenderer.on(CHANNELS.mcpCall, listener);
      void invoke(CHANNELS.mcpReady, true);
      return () => {
        ipcRenderer.removeListener(CHANNELS.mcpCall, listener);
        void invoke(CHANNELS.mcpReady, false);
      };
    },
  },
  share: {
    url: arg("share-url"),
    foreignVersion: arg("share-foreign"),
    open: () => invoke(CHANNELS.openShared),
  },
  syncUrl: arg("sync-url"),
  appVersion: arg("version"),
  platform: process.platform,
  version: process.versions.electron,
});
