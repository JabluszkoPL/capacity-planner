/**
 * The IPC channel names, shared by main and preload.
 *
 * One namespaced constant per LocalStore method, plus the Jira relay and the
 * updater —
 * listing them explicitly rather than forwarding arbitrary strings means the
 * preload script can only ever invoke calls that exist, which is the point of
 * having a preload script.
 */
export const CHANNELS = {
  deviceId: "planner:deviceId",
  read: "planner:read",
  applyLocal: "planner:applyLocal",
  applyRemote: "planner:applyRemote",
  pending: "planner:pending",
  ackThrough: "planner:ackThrough",
  cursor: "planner:cursor",
  resetCursor: "planner:resetCursor",
  /** Not a database call: the Jira relay. See ./jira. */
  jiraRequest: "planner:jira:request",
  /** The self-updater. See ./updater. */
  updateState: "planner:update:state",
  updateCheck: "planner:update:check",
  updateDownload: "planner:update:download",
  updateInstall: "planner:update:install",
  /** Main -> renderer: the update state changed. */
  updateChanged: "planner:update:changed",
  /** Open the shared app in the user's default browser. */
  stopShared: "planner:share:stop",
  openShared: "planner:share:open",
  /** The MCP endpoint's settings. See ./mcpHost. */
  mcpState: "planner:mcp:state",
  mcpUpdate: "planner:mcp:update",
  mcpRegenerateToken: "planner:mcp:regenerate-token",
  /** Main -> renderer: the MCP settings or status changed. */
  mcpChanged: "planner:mcp:changed",
  /** Main -> renderer: run one tool call. */
  mcpCall: "planner:mcp:call",
  /** Renderer -> main: a tool call's outcome. */
  mcpResult: "planner:mcp:result",
  /** Renderer -> main: this window can (true) or can no longer take calls. */
  mcpReady: "planner:mcp:ready",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
