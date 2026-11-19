import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MCP_PORT,
  generateToken,
  loadMcpSettings,
  normalizeMcpSettings,
} from "./mcpSettings";

describe("normalizeMcpSettings", () => {
  it("defaults to off, with a fresh token", () => {
    expect(normalizeMcpSettings(null, () => "t".repeat(40))).toEqual({
      enabled: false,
      allowWrites: false,
      token: "t".repeat(40),
      port: DEFAULT_MCP_PORT,
    });
  });

  it("only turns a switch on for a literal true", () => {
    const s = normalizeMcpSettings({ enabled: "yes", allowWrites: 1 });
    expect(s.enabled).toBe(false);
    expect(s.allowWrites).toBe(false);
  });

  it("replaces a weak or malformed token", () => {
    const fresh = () => "f".repeat(43);
    expect(normalizeMcpSettings({ token: "short" }, fresh).token).toBe(
      "f".repeat(43),
    );
    expect(normalizeMcpSettings({ token: "x y".repeat(20) }, fresh).token).toBe(
      "f".repeat(43),
    );
  });
});

describe("generateToken", () => {
  it("is long, URL-safe and different each time", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });
});

describe("loadMcpSettings", () => {
  it("creates the file owner-only and keeps the token across loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "planner-mcp-"));
    const file = join(dir, "mcp.json");
    const first = loadMcpSettings(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadMcpSettings(file).token).toBe(first.token);
    expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
  });

  it("survives a corrupt file by starting over, switched off", () => {
    const dir = mkdtempSync(join(tmpdir(), "planner-mcp-"));
    const file = join(dir, "mcp.json");
    writeFileSync(file, "{not json");
    const s = loadMcpSettings(file);
    expect(s.enabled).toBe(false);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
