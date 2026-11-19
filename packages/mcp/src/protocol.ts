/**
 * The Model Context Protocol, as much of it as Planner speaks.
 *
 * MCP is JSON-RPC 2.0 with a handshake (`initialize`) and a handful of
 * methods. Planner offers tools only (no resources, prompts or sampling), so
 * the whole server side is `initialize`, `ping`, `tools/list` and
 * `tools/call`, which is small enough to write out rather than pull in the
 * SDK and its schema library - the same trade the sync protocol makes.
 *
 * Nothing here knows about HTTP or sockets. The host (the Mac app's main
 * process) frames requests and passes each decoded body to
 * {@link handleMcpMessage}; what comes back is the body to send, or null for
 * a notification, which gets no reply.
 */
import type { ToolDefinition } from "./schema";

/** Newest first. A client asking for one of these gets it back. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC's own error codes. */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** What `tools/call` returns. Text only: every client renders it. */
export interface CallToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function toolResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * A tool that ran and failed. MCP reports these as a normal result with
 * `isError`, not as a protocol error, so the model reads the message and can
 * correct itself (a misspelt name, a missing date).
 */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export interface McpServerHooks {
  serverInfo: { name: string; title?: string; version: string };
  /** Shown to the model once, at the start of a session. */
  instructions?: string;
  /** The tools this client may see right now (settings can hide some). */
  listTools(): ToolDefinition[];
  /**
   * Run one tool. Only called for a name `listTools` returned. Throwing is a
   * host failure (window gone, timeout) and becomes an error result.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(
  id: JsonRpcId | null,
  code: number,
  message: string,
): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

/** The protocol version to answer an `initialize` with. */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/** The public part of a tool definition, as `tools/list` sends it. */
function describeTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, ...tool.annotations },
  };
}

/**
 * Handle one decoded JSON-RPC message. Returns the reply, or null when the
 * message was a notification (or a response, which a server never asked for).
 */
export async function handleMcpMessage(
  message: unknown,
  hooks: McpServerHooks,
): Promise<JsonRpcResponse | null> {
  if (Array.isArray(message)) {
    // Batching was dropped from MCP in 2025-06-18; nobody sends it now.
    return fail(null, RPC_ERRORS.invalidRequest, "Batches are not supported.");
  }
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    return fail(null, RPC_ERRORS.invalidRequest, "Not a JSON-RPC 2.0 message.");
  }

  const hasId =
    typeof message.id === "string" || typeof message.id === "number";
  const method = message.method;

  if (typeof method !== "string") {
    // A response needs no reply; anything else without a method is malformed.
    if ("result" in message || "error" in message) return null;
    return fail(
      hasId ? (message.id as JsonRpcId) : null,
      RPC_ERRORS.invalidRequest,
      "Missing method.",
    );
  }
  if (!hasId) return null; // notifications/initialized, notifications/cancelled…

  const id = message.id as JsonRpcId;
  const params = isObject(message.params) ? message.params : {};

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: hooks.serverInfo,
        ...(hooks.instructions ? { instructions: hooks.instructions } : {}),
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: hooks.listTools().map(describeTool) });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") {
        return fail(id, RPC_ERRORS.invalidParams, "tools/call needs a name.");
      }
      const tool = hooks.listTools().find((t) => t.name === name);
      if (!tool) {
        return fail(id, RPC_ERRORS.invalidParams, `Unknown tool: ${name}`);
      }
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isObject(args)) {
        return fail(
          id,
          RPC_ERRORS.invalidParams,
          "arguments must be an object.",
        );
      }
      try {
        return ok(id, await hooks.callTool(name, args));
      } catch (err) {
        return ok(
          id,
          toolError(err instanceof Error ? err.message : String(err)),
        );
      }
    }
    default:
      return fail(id, RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  }
}
