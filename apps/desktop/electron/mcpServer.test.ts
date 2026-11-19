import { afterEach, describe, expect, it, vi } from "vitest";
import { toolResult } from "@planner/mcp";
import { startMcpServer, type RunningMcpServer } from "./mcpServer";

const TOKEN = "k".repeat(43);

let running: RunningMcpServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(allowWrites = false) {
  const callTool = vi.fn(async (name: string) => toolResult({ ran: name }));
  running = await startMcpServer({
    port: 0,
    version: "1.2.3",
    settings: () => ({ token: TOKEN, allowWrites }),
    callTool,
  });
  return { callTool, url: `http://127.0.0.1:${running.port}/mcp` };
}

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("the MCP endpoint", () => {
  it("speaks MCP over POST: initialize, list, call", async () => {
    const { url, callTool } = await start();
    const init = await post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toBe("application/json");
    expect(await init.json()).toMatchObject({
      result: { serverInfo: { name: "planner", version: "1.2.3" } },
    });

    const note = await post(url, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(note.status).toBe(202);

    const list = await (
      await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_tracker_scope_changes");
    expect(names).not.toContain("set_member_off_days");

    const call = await (
      await post(url, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      })
    ).json();
    expect(callTool).toHaveBeenCalledWith(
      "list_projects",
      {},
      {
        allowWrites: false,
      },
    );
    expect(call.result.content[0].text).toContain("list_projects");
  });

  it("lists and relays write tools only when changes are allowed", async () => {
    const { url, callTool } = await start(true);
    const list = await (
      await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain(
      "set_member_off_days",
    );
    await post(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "run_plan", arguments: { project: "x" } },
    });
    expect(callTool).toHaveBeenCalledWith(
      "run_plan",
      { project: "x" },
      { allowWrites: true },
    );
  });

  it("refuses a browser, a wrong token and a GET before reading anything", async () => {
    const { url, callTool } = await start();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect(
      (await post(url, ping, { origin: "http://localhost:5190" })).status,
    ).toBe(403);
    expect(
      (await post(url, ping, { authorization: "Bearer nope" })).status,
    ).toBe(401);
    const get = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(405);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("answers a body that is not JSON with a parse error", async () => {
    const { url } = await start();
    const res = await post(url, "{oops");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
  });
});
