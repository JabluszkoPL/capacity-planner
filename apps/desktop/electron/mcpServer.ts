/**
 * The MCP endpoint: Streamable HTTP on loopback, JSON responses only.
 *
 * One POST carries one JSON-RPC message and gets one JSON reply (or 202 for a
 * notification). There are no sessions and no server-sent events: Planner
 * never pushes anything to a client, so the stateless subset of the transport
 * is all it needs, and every request is checked on its own (./mcpGuard).
 *
 * The protocol itself is @planner/mcp's. This file only frames it: the main
 * process lists tools from the shared catalogue and hands each call to the
 * open window (see `callTool`), which runs it against the live store.
 *
 * Free of Electron so it can be stood up in a test.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  availableTools,
  handleMcpMessage,
  RPC_ERRORS,
  SERVER_INSTRUCTIONS,
  type CallToolResult,
} from "@planner/mcp";
import { checkMcpRequest } from "./mcpGuard";

/** A JSON-RPC message for this server is small; refuse anything large. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpServerOptions {
  port: number;
  /** Always loopback in the app; tests use port 0. */
  host?: string;
  version: string;
  /** Read per request, so a new token or toggle applies at once. */
  settings(): { token: string; allowWrites: boolean };
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { allowWrites: boolean },
  ): Promise<CallToolResult>;
  log?: (line: string) => void;
}

export interface RunningMcpServer {
  port: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createMcpHttpServer(options: McpServerOptions): Server {
  return createServer((req, res) => {
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      const payload = body === null ? "" : JSON.stringify(body);
      res.writeHead(status, {
        ...(payload ? { "content-type": "application/json" } : {}),
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
        ...headers,
      });
      res.end(payload);
    };

    const { token, allowWrites } = options.settings();
    const verdict = checkMcpRequest(req, token);
    if (!verdict.ok) {
      options.log?.(`refused ${req.method} ${req.url}: ${verdict.status}`);
      send(
        verdict.status,
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_ERRORS.invalidRequest, message: verdict.message },
        },
        verdict.headers,
      );
      return;
    }

    void (async () => {
      const body = await readBody(req).catch(() => null);
      if (body === null) {
        send(413, {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_ERRORS.invalidRequest, message: "Too large." },
        });
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        send(400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_ERRORS.parse, message: "Body is not JSON." },
        });
        return;
      }
      const reply = await handleMcpMessage(message, {
        serverInfo: {
          name: "planner",
          title: "Planner",
          version: options.version,
        },
        instructions: SERVER_INSTRUCTIONS,
        listTools: () => availableTools({ allowWrites }),
        callTool: (name, args) => {
          options.log?.(`tool ${name}`);
          return options.callTool(name, args, { allowWrites });
        },
      });
      if (reply === null) send(202, null);
      else send(200, reply);
    })().catch((err) => {
      options.log?.(`error: ${(err as Error).message}`);
      if (!res.headersSent) {
        send(500, {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_ERRORS.internal, message: "Server error." },
        });
      }
    });
  });
}

export function startMcpServer(
  options: McpServerOptions,
): Promise<RunningMcpServer> {
  const http = createMcpHttpServer(options);
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host ?? "127.0.0.1", () => {
      http.off("error", reject);
      const addr = http.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : options.port,
        close: () =>
          new Promise<void>((done) => {
            http.closeAllConnections();
            http.close(() => done());
          }),
      });
    });
  });
}
