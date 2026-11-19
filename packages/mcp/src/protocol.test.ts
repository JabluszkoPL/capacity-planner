import { describe, expect, it, vi } from "vitest";
import {
  handleMcpMessage,
  LATEST_PROTOCOL_VERSION,
  negotiateVersion,
  RPC_ERRORS,
  toolResult,
  type McpServerHooks,
} from "./protocol";
import { availableTools, SERVER_INSTRUCTIONS } from "./catalog";

function hooks(overrides: Partial<McpServerHooks> = {}): McpServerHooks {
  return {
    serverInfo: { name: "planner", version: "9.9.9" },
    instructions: SERVER_INSTRUCTIONS,
    listTools: () => availableTools({ allowWrites: false }),
    callTool: vi.fn(async () => toolResult({ ok: true })),
    ...overrides,
  };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("handleMcpMessage", () => {
  it("answers initialize with the requested version, tools and instructions", async () => {
    const reply = await handleMcpMessage(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
      hooks(),
    );
    expect(reply).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "planner", version: "9.9.9" },
      },
    });
    expect(
      (reply as { result: { instructions: string } }).result.instructions,
    ).toContain("Planner");
  });

  it("offers its latest version to a client asking for one it doesn't know", () => {
    expect(negotiateVersion("1999-01-01")).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateVersion("2025-03-26")).toBe("2025-03-26");
  });

  it("sends nothing back for notifications and responses", async () => {
    expect(
      await handleMcpMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        hooks(),
      ),
    ).toBeNull();
    expect(
      await handleMcpMessage({ jsonrpc: "2.0", id: 4, result: {} }, hooks()),
    ).toBeNull();
  });

  it("answers ping", async () => {
    expect(
      await handleMcpMessage(rpc("ping", undefined, "p"), hooks()),
    ).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  it("lists only the tools the hooks allow, with schemas and hints", async () => {
    const reply = (await handleMcpMessage(rpc("tools/list"), hooks())) as {
      result: {
        tools: {
          name: string;
          inputSchema: unknown;
          annotations: { readOnlyHint: boolean };
        }[];
      };
    };
    const names = reply.result.tools.map((t) => t.name);
    expect(names).toContain("get_project");
    expect(names).toContain("open_project");
    expect(names).not.toContain("run_plan");
    const getProject = reply.result.tools.find(
      (t) => t.name === "get_project",
    )!;
    expect(getProject.annotations.readOnlyHint).toBe(true);
    expect(getProject.inputSchema).toMatchObject({
      type: "object",
      required: ["project"],
    });
    // The access level is the host's business, not the client's.
    expect(JSON.stringify(reply)).not.toContain('"access"');
  });

  it("calls a listed tool with its arguments", async () => {
    const callTool = vi.fn(async () => toolResult({ hello: "world" }));
    const reply = await handleMcpMessage(
      rpc("tools/call", { name: "list_projects", arguments: { x: 1 } }),
      hooks({ callTool }),
    );
    expect(callTool).toHaveBeenCalledWith("list_projects", { x: 1 });
    expect(reply).toMatchObject({
      result: {
        content: [{ type: "text", text: expect.stringContaining("world") }],
      },
    });
  });

  it("refuses a tool that is not listed (a write while writes are off)", async () => {
    const callTool = vi.fn();
    const reply = await handleMcpMessage(
      rpc("tools/call", { name: "run_plan", arguments: { project: "x" } }),
      hooks({ callTool }),
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(reply).toMatchObject({
      error: { code: RPC_ERRORS.invalidParams },
    });
  });

  it("turns a failing host into an error result the model can read", async () => {
    const reply = await handleMcpMessage(
      rpc("tools/call", { name: "list_projects" }),
      hooks({
        callTool: async () => {
          throw new Error("window closed");
        },
      }),
    );
    expect(reply).toMatchObject({
      result: { isError: true, content: [{ text: "window closed" }] },
    });
  });

  it("rejects malformed messages, batches and unknown methods", async () => {
    expect(
      await handleMcpMessage({ id: 1, method: "ping" }, hooks()),
    ).toMatchObject({ error: { code: RPC_ERRORS.invalidRequest } });
    expect(await handleMcpMessage([rpc("ping")], hooks())).toMatchObject({
      error: { code: RPC_ERRORS.invalidRequest },
    });
    expect(
      await handleMcpMessage(rpc("resources/list"), hooks()),
    ).toMatchObject({ error: { code: RPC_ERRORS.methodNotFound } });
    expect(
      await handleMcpMessage(
        rpc("tools/call", { name: "list_projects", arguments: [1] }),
        hooks(),
      ),
    ).toMatchObject({ error: { code: RPC_ERRORS.invalidParams } });
  });
});
