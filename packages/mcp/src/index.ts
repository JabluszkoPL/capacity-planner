/**
 * @planner/mcp - Planner's Model Context Protocol server, minus the socket.
 *
 * The protocol (JSON-RPC: initialize, tools/list, tools/call), the tool
 * catalogue and every tool's implementation. Pure like @planner/core: no
 * React, no DOM, no Node built-ins, no fetch. Tools read an AppState and
 * return the typed store actions for any change, which the open window
 * dispatches like a click.
 *
 * Two hosts use it: the Mac app's main process speaks the protocol over
 * loopback HTTP (apps/desktop/electron/mcpServer.ts), and the window runs the
 * tools against its live store (apps/web/src/mcp/McpBridge.tsx). See
 * docs/MCP.md.
 */
export * from "./protocol";
export * from "./schema";
export * from "./context";
export * from "./catalog";
export { parseViewPath, type ParsedView } from "./ui";
export { expandDates } from "./write";
export { issueLink } from "./tracker";
