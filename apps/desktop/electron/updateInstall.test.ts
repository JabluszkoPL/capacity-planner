import { describe, expect, it } from "vitest";
import {
  installLocation,
  isTrustedAssetUrl,
  SWAP_SCRIPT,
} from "./updateInstall";

const writable = () => true;
const readOnly = () => false;

describe("installLocation", () => {
  it("finds the bundle in Applications", () => {
    expect(
      installLocation(
        "/Applications/Planner.app/Contents/MacOS/Planner",
        writable,
      ),
    ).toEqual({ appPath: "/Applications/Planner.app", blocker: null });
  });

  it("handles spaces in the path", () => {
    const loc = installLocation(
      "/Users/me/My Apps/Planner.app/Contents/MacOS/Planner",
      writable,
    );
    expect(loc.appPath).toBe("/Users/me/My Apps/Planner.app");
    expect(loc.blocker).toBeNull();
  });

  it("refuses the dev build, the disk image and a translocated copy", () => {
    expect(
      installLocation("/repo/node_modules/electron/dist/Electron", writable)
        .blocker,
    ).toMatch(/not running as an app bundle/);
    expect(
      installLocation(
        "/Volumes/Planner/Planner.app/Contents/MacOS/Planner",
        writable,
      ).blocker,
    ).toMatch(/disk image/);
    expect(
      installLocation(
        "/private/var/folders/x/AppTranslocation/ABC/d/Planner.app/Contents/MacOS/Planner",
        writable,
      ).blocker,
    ).toMatch(/temporary location/);
  });

  it("refuses a folder it cannot write to", () => {
    expect(
      installLocation(
        "/Applications/Planner.app/Contents/MacOS/Planner",
        readOnly,
      ).blocker,
    ).toMatch(/can't write to \/Applications/);
  });
});

describe("isTrustedAssetUrl", () => {
  const repo = "someone/capacity-planner";
  it("accepts this repository's release downloads only", () => {
    expect(
      isTrustedAssetUrl(
        `https://github.com/${repo}/releases/download/v1.0.0/Planner-1.0.0-universal-mac.zip`,
        repo,
      ),
    ).toBe(true);
    expect(
      isTrustedAssetUrl(
        "https://github.com/other/repo/releases/download/v1.0.0/x.zip",
        repo,
      ),
    ).toBe(false);
    expect(
      isTrustedAssetUrl(
        `http://github.com/${repo}/releases/download/v1.0.0/x.zip`,
        repo,
      ),
    ).toBe(false);
    expect(
      isTrustedAssetUrl(
        `https://github.com.evil.example/${repo}/releases/download/v1/x.zip`,
        repo,
      ),
    ).toBe(false);
    expect(isTrustedAssetUrl("not a url", repo)).toBe(false);
  });
});

describe("SWAP_SCRIPT", () => {
  it("takes every path as a quoted positional argument", () => {
    expect(SWAP_SCRIPT).toContain('TARGET="$2"');
    expect(SWAP_SCRIPT).toContain('NEW="$3"');
    expect(SWAP_SCRIPT).toMatch(/mv "\$BACKUP" "\$TARGET"/);
  });
});
