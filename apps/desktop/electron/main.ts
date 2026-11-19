/**
 * Electron main process — the Mac app's host.
 *
 * It owns exactly one thing the renderer cannot: the SQLite database at
 * ~/Library/Application Support/Planner/planner.sqlite. That file is a normal,
 * queryable database — open it in any SQLite tool and the projects, epics and
 * tasks are right there as tables.
 *
 * Everything the user actually sees is the same web build that runs in a
 * browser. The window points at it, the preload script hands it a database, and
 * the app never learns which host it is in.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type Session,
} from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  createSqliteLocalStore,
  type LocalStore,
} from "@planner/client-runtime/sqlite";
import { openNodeDatabase } from "@planner/db/node";
import type { SqliteDriver } from "@planner/db";
import { githubRepoSlug } from "@planner/core";
import { CHANNELS } from "./ipc";
import { relayJiraRequest } from "./jira";
import { createUpdater, type Updater } from "./updater";
import {
  startShareServer,
  stopShareServer,
  type ShareInfo,
} from "./shareServer";

/** Injected by build.mjs from the workspace root package.json. */
declare const __PLANNER_VERSION__: string;
declare const __PLANNER_REPOSITORY__: unknown;

/** Set when running against the Vite dev server instead of the built bundle. */
const DEV_URL = process.env.PLANNER_DEV_URL;

// Pin the name before anything asks for a path. Left to itself, Electron
// derives userData from package.json's `name` — which is the scoped workspace
// name `@planner/desktop`, and would put the database in a nested
// "Application Support/@planner/desktop" folder that differs between the dev
// and packaged builds.
app.setName("Planner");

let driver: SqliteDriver | null = null;
let store: LocalStore | null = null;
let updater: Updater | null = null;
let share: ShareInfo = { syncUrl: null, shareUrl: null };

function dataDir(): string {
  const dir = process.env.PLANNER_DATA_DIR ?? app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function openStore(): LocalStore {
  const path = join(dataDir(), "planner.sqlite");
  driver = openNodeDatabase(path);
  console.log(`[planner] database ${path}`);
  return createSqliteLocalStore(driver, {
    generateDeviceId: () => randomUUID(),
  });
}

/** Wire the LocalStore methods onto IPC. */
function registerDatabaseChannels(local: LocalStore): void {
  ipcMain.handle(CHANNELS.deviceId, () => local.deviceId);
  ipcMain.handle(CHANNELS.read, () => local.read());
  ipcMain.handle(CHANNELS.applyLocal, (_e, ops) => local.applyLocal(ops));
  ipcMain.handle(CHANNELS.applyRemote, (_e, ops, cursor) =>
    local.applyRemote(ops, cursor),
  );
  ipcMain.handle(CHANNELS.pending, () => local.pending());
  ipcMain.handle(CHANNELS.ackThrough, (_e, seq) => local.ackThrough(seq));
  ipcMain.handle(CHANNELS.cursor, () => local.cursor());
  ipcMain.handle(CHANNELS.resetCursor, () => local.resetCursor());
}

/**
 * The Jira relay. Registered next to the database channels because it is the
 * same kind of thing — a capability the renderer cannot have on its own — but
 * kept in its own function because it is the only one that touches the network.
 */
function registerJiraChannel(): void {
  ipcMain.handle(CHANNELS.jiraRequest, (_e, req) =>
    relayJiraRequest(req, undefined, jiraFetch),
  );
}

/**
 * The updater's verbs, plus a push channel so every window hears about
 * progress without polling.
 */
function registerUpdateChannels(u: Updater): void {
  ipcMain.handle(CHANNELS.updateState, () => u.state());
  ipcMain.handle(CHANNELS.updateCheck, () => u.check());
  ipcMain.handle(CHANNELS.updateDownload, () => u.download());
  ipcMain.handle(CHANNELS.updateInstall, () => u.install());
  u.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(CHANNELS.updateChanged, state);
    }
  });
  // Only ever opens the share URL this process chose, never one from the
  // renderer.
  ipcMain.handle(CHANNELS.openShared, () => {
    if (share.shareUrl) void shell.openExternal(share.shareUrl);
  });
}

let jiraSession: Session | null = null;

/**
 * Jira calls go through Chromium's network stack, not Node's `fetch`. Node
 * ignores the system proxy settings (PAC files included) and the macOS
 * keychain, so on a managed Mac — a corporate proxy, or TLS inspection with a
 * company root certificate — it fails with a bare "fetch failed" while the
 * same Jira opens fine in the browser. Chromium honours both, as a browser
 * does.
 *
 * The session is in-memory and used for nothing else, so no Jira cookie is
 * ever written to disk or mixed with the window's own session.
 */
const jiraFetch: typeof fetch = (input, init) => {
  jiraSession ??= session.fromPartition("planner-jira");
  return jiraSession.fetch(input as string, init);
};

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Planner",
    // macOS only: drop the system title bar so the app's own header reads as
    // the top of the window. The renderer draws a 34px draggable strip above
    // that header (components/layout/TitleBar) and these coordinates put the
    // traffic lights in the middle of it — the buttons are 12px tall, so y = 11
    // centres them in the band and x = 14 matches the header's own inset.
    //
    // Elsewhere the frame stays: Windows and Linux draw their controls in the
    // title bar itself, and hiding it would leave a window with no way to close
    // it. The strip is harmless there — it just adds 34px of draggable space.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 14, y: 11 },
        }
      : {}),
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      // Facts the preload exposes. Passed as arguments because the preload
      // runs synchronously and these are decided before the window exists.
      additionalArguments: [
        `--planner-version=${__PLANNER_VERSION__}`,
        ...(share.syncUrl ? [`--planner-sync-url=${share.syncUrl}`] : []),
        ...(share.shareUrl ? [`--planner-share-url=${share.shareUrl}`] : []),
        ...(share.foreign
          ? [`--planner-share-foreign=${share.foreign.version ?? "unknown"}`]
          : []),
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Anything that isn't the app itself belongs in the user's browser, not in a
  // chrome-less Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_URL) {
    void window.loadURL(DEV_URL);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

app.whenReady().then(async () => {
  try {
    store = openStore();
  } catch (err) {
    // Without a database there is no app. Failing here used to mean an
    // invisible dead process (this is exactly how an Electron build too old for
    // node:sqlite presents itself), so say so on screen and exit.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[planner] could not open the database:", err);
    dialog.showErrorBox(
      "Planner could not start",
      `The local database could not be opened.\n\n${message}\n\n` +
        `Node ${process.versions.node} / Electron ${process.versions.electron}`,
    );
    app.exit(1);
    return;
  }

  registerDatabaseChannels(store);
  registerJiraChannel();

  updater = createUpdater({
    currentVersion: __PLANNER_VERSION__,
    repoSlug: githubRepoSlug(__PLANNER_REPOSITORY__),
  });
  registerUpdateChannels(updater);

  // Before the window, because the renderer reads its sync URL once at start.
  // Bounded: if the server can't come up the app opens local-only.
  share = await startShareServer(dataDir());

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The database lives as long as the app does, not as long as a window does.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  updater?.dispose();
  stopShareServer();
  driver?.close();
  driver = null;
  store = null;
});
