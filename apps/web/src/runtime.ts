/**
 * Building the app's runtime, for whichever host it finds itself in.
 *
 * One bundle serves both targets. In the Mac app the Electron main process
 * exposes a real SQLite database over the context bridge and we use that; in a
 * browser tab we use the in-memory row index snapshotted to IndexedDB. The
 * choice is made here and nowhere else — every component above is identical.
 */
import {
  PlannerRuntime,
  createBridgeLocalStore,
  createMemoryLocalStore,
  webSocketFactory,
  type LocalStore,
} from "@planner/client-runtime";
import {
  createIndexedDbPersistence,
  indexedDbAvailable,
} from "./lib/indexedDb";
import { hostBridge } from "./lib/hostBridge";
import { markLegacyImported, readLegacyState } from "./lib/legacyImport";
import {
  readSyncUrlSetting,
  sameOriginSyncUrl,
  servedBySyncServer,
} from "./lib/syncSettings";

export type SyncSource = "host" | "setting" | "same-origin" | "build" | null;

/**
 * Where the sync server lives, or null for a purely local app. First match
 * wins:
 *
 *  1. the Mac app's choice (its built-in server, or PLANNER_SYNC_URL)
 *  2. a server picked in this browser's settings
 *  3. the server this page was loaded from, when that was a sync server
 *  4. VITE_SYNC_URL baked in at build time
 */
export function resolveSync(): { url: string | null; source: SyncSource } {
  const host = hostBridge();
  if (host) {
    const fromHost = host.syncUrl;
    return typeof fromHost === "string" && fromHost.length > 0
      ? { url: fromHost, source: "host" }
      : { url: null, source: null };
  }
  const setting = readSyncUrlSetting();
  if (setting) return { url: setting, source: "setting" };
  if (servedBySyncServer()) {
    return { url: sameOriginSyncUrl(), source: "same-origin" };
  }
  const configured = import.meta.env.VITE_SYNC_URL;
  if (typeof configured === "string" && configured.length > 0)
    return { url: configured, source: "build" };
  return { url: null, source: null };
}

export function syncUrl(): string | null {
  return resolveSync().url;
}

async function createLocalStore(): Promise<LocalStore> {
  const host = hostBridge();
  if (host) return createBridgeLocalStore(host.db);
  return createMemoryLocalStore({
    persistence: indexedDbAvailable()
      ? createIndexedDbPersistence()
      : undefined,
  });
}

export async function createAppRuntime(): Promise<PlannerRuntime> {
  const store = await createLocalStore();
  const url = syncUrl();

  const runtime = new PlannerRuntime({
    store,
    sync: url ? { url, socketFactory: webSocketFactory } : undefined,
    seedWhenEmpty: true,
  });

  // Adopt data from the original localStorage-only Planner before the runtime
  // decides whether to seed, so an existing user never gets the demo project
  // in place of their own work. Only relevant in a browser tab — the Mac app
  // has no such history.
  if (!hostBridge()) {
    const existing = await store.read();
    if (existing.projects.length === 0 && existing.teams.length === 0) {
      const legacy = readLegacyState();
      if (legacy) {
        await runtime.commit(existing, legacy);
        markLegacyImported();
      }
    }
  }

  return runtime;
}
