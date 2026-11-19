/**
 * What a user pastes to connect an AI client to Planner's MCP endpoint.
 *
 * The token is part of each snippet: it is the client's password for this
 * Mac's planner, so the snippets are built on demand from the live settings
 * and never stored anywhere else by the app.
 */

/** The name clients will show the server as (and prefix its tools with). */
export const MCP_SERVER_NAME = "planner";

/**
 * Claude Code: `claude mcp add`. User scope, so it works in every project
 * folder rather than only the one the command was run in.
 */
export function claudeCodeCommand(url: string, token: string): string {
  return `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
}

/**
 * The `mcpServers` block most clients read (Cursor, VS Code, Windsurf, Claude
 * Code's .mcp.json…). Streamable HTTP with a fixed header.
 */
export function mcpJsonConfig(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

/**
 * OpenAI's Codex CLI. It reads a bearer token from an environment variable
 * rather than its config file, so the token is exported separately (and
 * belongs in the shell profile to survive a new terminal).
 */
export function codexCommands(url: string, token: string): string {
  return [
    `export PLANNER_MCP_TOKEN="${token}"`,
    `codex mcp add ${MCP_SERVER_NAME} --url ${url} --bearer-token-env-var PLANNER_MCP_TOKEN`,
  ].join("\n");
}
