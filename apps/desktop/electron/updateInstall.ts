/**
 * The pure half of the Mac app's self-updater: where the running app lives,
 * whether it may be replaced, and the script that replaces it.
 *
 * Why not electron-updater / Squirrel.Mac: Squirrel refuses any update whose
 * code signature doesn't match the running app's designated requirement, and
 * an ad-hoc signed app (see afterPack.mjs) has no stable requirement to match.
 * Until Planner ships with a Developer ID, the update is installed the way a
 * person would do it by hand — unzip the new Planner.app and put it where the
 * old one was — just done by a tiny script that waits for the app to quit.
 *
 * Everything here is free of Electron so it can be tested; ./updater does the
 * network and process work.
 */

export interface InstallLocation {
  /** Absolute path to the running `Planner.app` bundle, if it is one. */
  appPath: string | null;
  /** Null when the bundle can be replaced in place; otherwise why not. */
  blocker: string | null;
}

/**
 * Locate the running bundle from `process.execPath`
 * (`/Applications/Planner.app/Contents/MacOS/Planner`) and decide whether an
 * in-place update is possible. `isWritable` checks the bundle's parent folder.
 */
export function installLocation(
  execPath: string,
  isWritable: (dir: string) => boolean,
): InstallLocation {
  const m = /^(.*\/[^/]+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  if (!m) {
    return {
      appPath: null,
      blocker: "Planner is not running as an app bundle.",
    };
  }
  const appPath = m[1]!;
  if (appPath.startsWith("/Volumes/")) {
    return {
      appPath,
      blocker:
        "Planner is running from the disk image. Drag it into Applications first, then updates can install themselves.",
    };
  }
  // macOS runs a quarantined app that was never moved from a randomised,
  // read-only copy. Replacing that copy would change nothing.
  if (appPath.includes("/AppTranslocation/")) {
    return {
      appPath,
      blocker:
        "macOS is running Planner from a temporary location. Move Planner.app into Applications and open it from there.",
    };
  }
  const parent = appPath.slice(0, appPath.lastIndexOf("/")) || "/";
  if (!isWritable(parent)) {
    return {
      appPath,
      blocker: `Planner can't write to ${parent}. Download the update from GitHub instead.`,
    };
  }
  return { appPath, blocker: null };
}

/**
 * The only URLs the updater downloads from: this repository's own release
 * assets. GitHub then redirects to its asset CDN, which fetch follows.
 */
export function isTrustedAssetUrl(url: string, repoSlug: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    parsed.pathname.startsWith(`/${repoSlug}/releases/download/`)
  );
}

/**
 * The swap script. It runs detached after the app quits:
 *
 *   1. wait for the old process to exit (so nothing holds the bundle open)
 *   2. move the old bundle aside, move the new one into place
 *   3. on failure put the old one back, so a failed update never leaves the
 *      user with no app at all
 *   4. relaunch whichever bundle ended up in place
 *
 * Arguments arrive as positional parameters, never interpolated, so a path
 * with spaces or quotes in it is still just a path.
 */
export const SWAP_SCRIPT = `#!/bin/bash
# Planner self-update: $1 = pid to wait for, $2 = installed app, $3 = new app
PID="$1"; TARGET="$2"; NEW="$3"
for _ in $(seq 1 300); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done
BACKUP="$TARGET.previous"
rm -rf "$BACKUP"
if mv "$TARGET" "$BACKUP"; then
  if mv "$NEW" "$TARGET"; then
    rm -rf "$BACKUP"
  else
    mv "$BACKUP" "$TARGET"
  fi
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
open "$TARGET"
`;
