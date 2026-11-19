import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * @planner/jira is bundled into a browser tab, into Electron's main process and
 * into the sync server, so — exactly like the scheduler in @planner/core — none
 * of its sources may reach for a platform. The transport is the only way out,
 * and it is injected. (This *test* is allowed `node:fs`; the sources are not.)
 */
const sources = readdirSync("src")
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, src: readFileSync(`src/${f}`, "utf8") }));

describe("package purity", () => {
  it("has sources to check", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "estimateUpdates.ts",
      "fields.ts",
      "importProject.ts",
      "index.ts",
      "jql.ts",
      "link.ts",
      "map.ts",
      "refresh.ts",
      "teams.ts",
      "trackerMapping.ts",
      "transport.ts",
      "writeback.ts",
    ]);
  });

  it.each(sources)("$file imports no React and no Node built-in", ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]react/);
    expect(src).not.toMatch(/from\s+['"]node:/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(\s*['"]node:/);
  });

  it.each(sources)("$file touches no DOM or host global", ({ src }) => {
    // Property access (window.x / document.x), not the English words that
    // appear in the comments.
    expect(src).not.toMatch(/\bdocument\.\w/);
    expect(src).not.toMatch(/\bwindow\.\w/);
    expect(src).not.toMatch(/\bnavigator\.\w/);
    expect(src).not.toMatch(/\blocalStorage\b/);
    expect(src).not.toMatch(/\bprocess\.\w/);
    expect(src).not.toMatch(/\bBuffer\s*\./);
  });

  it.each(sources)("$file makes no request of its own", ({ src }) => {
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bXMLHttpRequest\b/);
    expect(src).not.toMatch(/\bnew\s+WebSocket\b/);
  });

  it("reads no clock: the caller supplies `now`", () => {
    for (const { file, src } of sources) {
      expect(`${file}: ${src}`).not.toMatch(/Date\.now\s*\(/);
      expect(`${file}: ${src}`).not.toMatch(/new\s+Date\s*\(\s*\)/);
    }
  });
});
