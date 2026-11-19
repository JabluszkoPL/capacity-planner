/**
 * "Is there a newer Planner?", for whichever host the app is running in.
 *
 * In the Mac app the main process does the work — it can download and install
 * — and this module only mirrors its state. In a browser tab this module asks
 * GitHub itself and can only point at the release: a web build is updated by
 * whoever serves it (pull the repository, or update the Mac app that is
 * sharing it).
 *
 * The browser check is throttled to one request per {@link CHECK_EVERY_MS}
 * per device: GitHub allows 60 unauthenticated API calls an hour per address,
 * and a team sharing an office NAT would spend that quickly on page loads.
 */
import { useSyncExternalStore } from "react";
import {
  initialUpdateState,
  isNewerVersion,
  latestReleaseApiUrl,
  parseLatestRelease,
  type UpdateState,
} from "@planner/core";
import { hostBridge } from "./hostBridge";
import { APP_VERSION, RELEASES_REPO } from "./appInfo";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = "planner_update_check_v1";

interface CachedCheck {
  checkedAt: string;
  latest: UpdateState["latest"];
}

let state: UpdateState = initialUpdateState(APP_VERSION);
const listeners = new Set<() => void>();
let started = false;

function set(next: UpdateState): void {
  state = next;
  for (const fn of listeners) fn();
}

function readCache(): CachedCheck | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedCheck) : null;
  } catch {
    return null;
  }
}

function writeCache(c: CachedCheck): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    // private mode: we just check again next time
  }
}

const BROWSER_HINT =
  "A browser can't update itself: update the Mac app that shares this page, or pull the repository and restart it.";

function fromCache(c: CachedCheck): UpdateState {
  const newer = c.latest && isNewerVersion(c.latest.version, APP_VERSION);
  return {
    ...state,
    status: newer ? "available" : "up-to-date",
    latest: newer ? c.latest : null,
    checkedAt: c.checkedAt,
    canInstall: false,
    message: newer ? BROWSER_HINT : null,
  };
}

async function browserCheck(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!RELEASES_REPO) {
    set({
      ...state,
      status: "error",
      message: "This build has no release repository.",
    });
    return;
  }
  set({ ...state, status: "checking", message: null });
  try {
    const res = await fetchImpl(latestReleaseApiUrl(RELEASES_REPO), {
      headers: { accept: "application/vnd.github+json" },
    });
    const checkedAt = new Date().toISOString();
    let latest: UpdateState["latest"] = null;
    if (res.ok) {
      const r = parseLatestRelease(await res.json(), RELEASES_REPO);
      if (r)
        latest = { version: r.version, pageUrl: r.pageUrl, notes: r.notes };
    } else if (res.status !== 404) {
      throw new Error(`GitHub answered ${res.status}`);
    }
    const cached = { checkedAt, latest };
    writeCache(cached);
    set(fromCache(cached));
  } catch (err) {
    set({
      ...state,
      status: "error",
      message: `Couldn't check for updates: ${(err as Error).message}`,
    });
  }
}

/** Start mirroring or checking. Idempotent; called by the first subscriber. */
function start(): void {
  if (started) return;
  started = true;
  const updates = hostBridge()?.updates;
  if (updates) {
    // The initial read can resolve after a pushed change; a push is newer.
    let pushed = false;
    updates.onChange((s) => {
      pushed = true;
      set(s);
    });
    void updates.state().then(
      (s) => {
        if (!pushed) set(s);
      },
      () => {},
    );
    return;
  }
  const cached = readCache();
  if (cached) set(fromCache(cached));
  // Never from a test run: it would be a real network call.
  if (import.meta.env.MODE === "test") return;
  const stale =
    !cached || Date.now() - Date.parse(cached.checkedAt) > CHECK_EVERY_MS;
  if (stale) void browserCheck();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  start();
  return () => void listeners.delete(fn);
}

export interface UpdateActions {
  check(): void;
  download(): void;
  install(): void;
}

const actions: UpdateActions = {
  check() {
    const updates = hostBridge()?.updates;
    if (updates) void updates.check().then(set, () => {});
    else void browserCheck();
  },
  download() {
    void hostBridge()
      ?.updates?.download()
      .then(set, () => {});
  },
  install() {
    void hostBridge()?.updates?.install();
  },
};

export function useUpdates(): { state: UpdateState } & UpdateActions {
  const current = useSyncExternalStore(subscribe, () => state);
  return { state: current, ...actions };
}

/** For tests: forget everything and check with a stub. */
export const __testing = {
  reset() {
    state = initialUpdateState(APP_VERSION);
    started = false;
    listeners.clear();
  },
  browserCheck,
  get state() {
    return state;
  },
};
