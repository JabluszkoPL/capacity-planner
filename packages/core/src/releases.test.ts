import { describe, expect, it } from "vitest";
import {
  compareVersions,
  githubRepoSlug,
  isNewerVersion,
  parseLatestRelease,
  parseVersion,
} from "./releases";

const REPO = "someone/capacity-planner";

function asset(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    size: 1234,
    browser_download_url: `https://github.com/${REPO}/releases/download/v0.2.0/${name}`,
    ...extra,
  };
}

describe("versions", () => {
  it("parses plain, v-prefixed and prerelease versions", () => {
    expect(parseVersion("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: [],
    });
    expect(parseVersion("v0.10.0-beta.2")?.pre).toEqual(["beta", "2"]);
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
  });

  it("orders numerically, not lexically", () => {
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("v1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.0.9", "0.1.0")).toBe(false);
  });

  it("ranks a release above its own prereleases", () => {
    expect(isNewerVersion("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewerVersion("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0-rc.10", "1.0.0-rc.9")).toBe(true);
    const a = parseVersion("1.0.0-alpha")!;
    const b = parseVersion("1.0.0-alpha.1")!;
    expect(compareVersions(a, b)).toBeLessThan(0);
  });

  it("never claims an unparseable version is newer", () => {
    expect(isNewerVersion("nightly", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "dev")).toBe(false);
  });
});

describe("githubRepoSlug", () => {
  it.each([
    ["https://github.com/someone/capacity-planner", REPO],
    ["https://github.com/someone/capacity-planner.git", REPO],
    ["git+https://github.com/someone/capacity-planner.git", REPO],
    ["git@github.com:someone/capacity-planner.git", REPO],
    ["github:someone/capacity-planner", REPO],
    ["someone/capacity-planner", REPO],
  ])("reads %s", (input, expected) => {
    expect(githubRepoSlug(input)).toBe(expected);
    expect(githubRepoSlug({ type: "git", url: input })).toBe(expected);
  });

  it("rejects other hosts and garbage", () => {
    expect(githubRepoSlug("https://gitlab.com/a/b")).toBeNull();
    expect(githubRepoSlug(undefined)).toBeNull();
    expect(githubRepoSlug({})).toBeNull();
  });
});

describe("parseLatestRelease", () => {
  const body = {
    tag_name: "v0.2.0",
    html_url: `https://github.com/${REPO}/releases/tag/v0.2.0`,
    body: "Notes",
    published_at: "2026-11-19T10:00:00Z",
    draft: false,
    prerelease: false,
    assets: [
      asset("Planner-0.2.0-universal.dmg"),
      asset("Planner-0.2.0-universal-mac.zip", {
        digest: "sha256:" + "AB".repeat(32),
      }),
      asset("Planner-0.2.0-universal-mac.zip.blockmap"),
    ],
  };

  it("picks the mac zip and dmg and normalises the digest", () => {
    const r = parseLatestRelease(body, REPO)!;
    expect(r.version).toBe("0.2.0");
    expect(r.macZip?.name).toBe("Planner-0.2.0-universal-mac.zip");
    expect(r.macZip?.sha256).toBe("ab".repeat(32));
    expect(r.macDmg?.name).toBe("Planner-0.2.0-universal.dmg");
    expect(r.pageUrl).toBe(body.html_url);
  });

  it("ignores assets hosted anywhere but this repository's downloads", () => {
    const r = parseLatestRelease(
      {
        ...body,
        assets: [
          {
            ...asset("Planner-0.2.0-universal-mac.zip"),
            browser_download_url:
              "https://github.com/attacker/x/releases/download/v0.2.0/Planner-0.2.0-universal-mac.zip",
          },
        ],
      },
      REPO,
    )!;
    expect(r.macZip).toBeNull();
  });

  it("refuses drafts, prereleases and unversioned tags", () => {
    expect(parseLatestRelease({ ...body, draft: true }, REPO)).toBeNull();
    expect(parseLatestRelease({ ...body, prerelease: true }, REPO)).toBeNull();
    expect(
      parseLatestRelease({ ...body, tag_name: "latest" }, REPO),
    ).toBeNull();
    expect(parseLatestRelease("nope", REPO)).toBeNull();
  });

  it("falls back to the releases page for a foreign html_url", () => {
    const r = parseLatestRelease(
      { ...body, html_url: "https://evil.example/x" },
      REPO,
    )!;
    expect(r.pageUrl).toBe(`https://github.com/${REPO}/releases`);
  });
});
