import { describe, expect, it } from "vitest";
import {
  claudeCodeCommand,
  codexCommands,
  mcpJsonConfig,
} from "./installCommands";

const URL = "http://127.0.0.1:5192/mcp";
const TOKEN = "abc_DEF-123";

describe("install commands", () => {
  it("adds Planner to Claude Code for every project, with the token header last", () => {
    // --header is variadic in `claude mcp add`; anything after it would be
    // swallowed as another header, so it has to come after name and URL.
    expect(claudeCodeCommand(URL, TOKEN)).toBe(
      `claude mcp add --scope user --transport http planner ${URL} --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it("writes an mcpServers block for JSON-configured clients", () => {
    expect(JSON.parse(mcpJsonConfig(URL, TOKEN))).toEqual({
      mcpServers: {
        planner: {
          type: "http",
          url: URL,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    });
  });

  it("gives Codex the token through an environment variable", () => {
    expect(codexCommands(URL, TOKEN).split("\n")).toEqual([
      `export PLANNER_MCP_TOKEN="${TOKEN}"`,
      `codex mcp add planner --url ${URL} --bearer-token-env-var PLANNER_MCP_TOKEN`,
    ]);
  });
});
