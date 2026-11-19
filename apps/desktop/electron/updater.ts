/**
 * The Mac app's self-updater.
 *
 * Checks the GitHub releases of the repository named in the root package.json,
 * and when a newer version is published it can download the universal .zip,
 * verify it, and swap it in on restart. The renderer only sees an
 * {@link UpdateState} and three verbs (check, download, install); everything
 * that touches the network or the filesystem stays here.
 *
 * Network reach is fixed: `api.github.com/repos/<repo>/releases/latest` and
 * that repository's own release assets (see {@link isTrustedAssetUrl}). The
 * requests go through Chromium's stack (`net.fetch`) so a corporate proxy that
 * works in the browser works here too.
 *
 * A downloaded build is installed only after it passes, in order: the size
 * GitHub reported, the SHA-256 digest GitHub reported (when it reports one),
 * `codesign --verify`, and a version check against its own Info.plist.
 */
import { app, net } from "electron";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  initialUpdateState,
  isNewerVersion,
  latestReleaseApiUrl,
  parseLatestRelease,
  type LatestRelease,
  type UpdateState,
} from "@planner/core";
import {
  installLocation,
  isTrustedAssetUrl,
  SWAP_SCRIPT,
} from "./updateInstall";

const run = promisify(execFile);

/** First check shortly after launch, then this often while the app is open. */
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface Updater {
  state(): UpdateState;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  /** Quits the app; the swap script relaunches it. */
  install(): Promise<UpdateState>;
  onChange(fn: (s: UpdateState) => void): () => void;
  dispose(): void;
}

export function createUpdater(options: {
  currentVersion: string;
  repoSlug: string | null;
}): Updater {
  const { currentVersion, repoSlug } = options;
  let state = initialUpdateState(currentVersion);
  let release: LatestRelease | null = null;
  let downloadedApp: string | null = null;
  let busy: Promise<UpdateState> | null = null;
  const listeners = new Set<(s: UpdateState) => void>();

  const set = (patch: Partial<UpdateState>): UpdateState => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn(state);
    return state;
  };

  const location = () =>
    installLocation(process.execPath, (dir) => {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });

  /** Why this copy cannot install by itself, or null if it can. */
  const installBlocker = (r: LatestRelease): string | null => {
    if (process.platform !== "darwin")
      return "Updates install themselves on macOS only.";
    if (!app.isPackaged)
      return "This is a development build; pull the repository to update.";
    if (!r.macZip) return "This release has no macOS download.";
    return location().blocker;
  };

  async function doCheck(): Promise<UpdateState> {
    if (!repoSlug) {
      return set({
        status: "error",
        message: "No release repository is configured for this build.",
      });
    }
    set({ status: "checking", message: null });
    try {
      const res = await net.fetch(latestReleaseApiUrl(repoSlug), {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "Planner-Updater",
        },
      });
      const checkedAt = new Date().toISOString();
      if (res.status === 404) {
        // No release published yet: nothing newer by definition.
        return set({ status: "up-to-date", latest: null, checkedAt });
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const parsed = parseLatestRelease(await res.json(), repoSlug);
      if (!parsed || !isNewerVersion(parsed.version, currentVersion)) {
        return set({ status: "up-to-date", latest: null, checkedAt });
      }
      const sameAsBefore = release?.version === parsed.version;
      release = parsed;
      const blocker = installBlocker(parsed);
      return set({
        // Don't throw away a finished download because a timer re-checked.
        status: sameAsBefore && downloadedApp ? "ready" : "available",
        latest: {
          version: parsed.version,
          pageUrl: parsed.pageUrl,
          notes: parsed.notes,
        },
        canInstall: blocker === null,
        message: blocker,
        checkedAt,
      });
    } catch (err) {
      return set({
        status: "error",
        message: `Couldn't check for updates: ${(err as Error).message}`,
      });
    }
  }

  async function doDownload(): Promise<UpdateState> {
    const r = release;
    if (!r || !r.macZip || !repoSlug) return state;
    const blocker = installBlocker(r);
    if (blocker) return set({ canInstall: false, message: blocker });
    const asset = r.macZip;
    if (!isTrustedAssetUrl(asset.url, repoSlug)) {
      return set({
        status: "error",
        message: "The download link is not from this project's releases.",
      });
    }

    const dir = join(app.getPath("temp"), `planner-update-${r.version}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const zipPath = join(dir, asset.name);

    set({ status: "downloading", progress: 0, message: null });
    try {
      const res = await net.fetch(asset.url, {
        headers: { "user-agent": "Planner-Updater" },
      });
      if (!res.ok || !res.body)
        throw new Error(`download failed (${res.status})`);
      const hash = createHash("sha256");
      const out = createWriteStream(zipPath);
      let received = 0;
      let lastReported = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        hash.update(value);
        if (!out.write(value)) {
          await new Promise<void>((resolve) => out.once("drain", resolve));
        }
        const progress = Math.min(1, received / asset.size);
        if (progress - lastReported >= 0.02) {
          lastReported = progress;
          set({ progress });
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );

      if (received !== asset.size) {
        throw new Error(`expected ${asset.size} bytes, got ${received}`);
      }
      if (asset.sha256 && hash.digest("hex") !== asset.sha256) {
        throw new Error("the download's checksum does not match the release");
      }

      const unpacked = join(dir, "unpacked");
      mkdirSync(unpacked);
      // ditto, not unzip: it preserves the bundle's symlinks, extended
      // attributes and code signature exactly as electron-builder zipped them.
      await run("/usr/bin/ditto", ["-x", "-k", zipPath, unpacked]);
      const bundle = readdirSync(unpacked).find((n) => n.endsWith(".app"));
      if (!bundle) throw new Error("the download contains no app");
      const appPath = join(unpacked, bundle);

      await run("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        appPath,
      ]);
      const { stdout } = await run("/usr/bin/plutil", [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        join(appPath, "Contents", "Info.plist"),
      ]);
      if (stdout.trim() !== r.version) {
        throw new Error(
          `the download is version ${stdout.trim()}, expected ${r.version}`,
        );
      }

      rmSync(zipPath, { force: true });
      downloadedApp = appPath;
      return set({ status: "ready", progress: 1 });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      downloadedApp = null;
      return set({
        status: "error",
        progress: null,
        message: `The update couldn't be downloaded: ${(err as Error).message}`,
      });
    }
  }

  async function doInstall(): Promise<UpdateState> {
    const loc = location();
    if (
      !downloadedApp ||
      !existsSync(downloadedApp) ||
      !loc.appPath ||
      loc.blocker
    ) {
      return set({
        status: "error",
        message: loc.blocker ?? "Download the update first.",
      });
    }
    const script = join(app.getPath("temp"), "planner-swap.sh");
    writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
    const child = spawn(
      "/bin/bash",
      [script, String(process.pid), loc.appPath, downloadedApp],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    app.quit();
    return state;
  }

  /** One operation at a time; a second request joins the first. */
  const serial =
    (fn: () => Promise<UpdateState>) => (): Promise<UpdateState> => {
      busy ??= fn().finally(() => {
        busy = null;
      });
      return busy;
    };

  const check = serial(doCheck);
  const first = setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  const timer = setInterval(() => {
    if (state.status !== "downloading" && state.status !== "ready")
      void check();
  }, CHECK_INTERVAL_MS);

  return {
    state: () => state,
    check,
    download: serial(doDownload),
    install: serial(doInstall),
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    dispose() {
      clearTimeout(first);
      clearInterval(timer);
      listeners.clear();
    },
  };
}
