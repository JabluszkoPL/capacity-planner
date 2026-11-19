import { describe, expect, it } from "vitest";
import { checkMcpRequest, isLoopbackHost, tokenMatches } from "./mcpGuard";

const TOKEN = "a".repeat(43);

function req(
  headers: Record<string, string> = {},
  overrides: { method?: string; url?: string } = {},
) {
  return {
    method: overrides.method ?? "POST",
    url: overrides.url ?? "/mcp",
    headers: {
      host: "127.0.0.1:5192",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
  };
}

describe("checkMcpRequest", () => {
  it("lets a well-formed client request in", () => {
    expect(checkMcpRequest(req(), TOKEN)).toEqual({ ok: true });
    expect(checkMcpRequest(req({ host: "localhost:5192" }), TOKEN).ok).toBe(
      true,
    );
    expect(checkMcpRequest(req({ host: "[::1]:5192" }), TOKEN).ok).toBe(true);
  });

  it("serves /mcp only", () => {
    expect(
      checkMcpRequest(req({}, { url: "/api/state" }), TOKEN),
    ).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses a rebound hostname (DNS rebinding)", () => {
    expect(
      checkMcpRequest(req({ host: "evil.example:5192" }), TOKEN),
    ).toMatchObject({ ok: false, status: 403 });
    expect(checkMcpRequest(req({ host: "" }), TOKEN)).toMatchObject({
      status: 403,
    });
  });

  it("refuses anything a browser sends, even from localhost", () => {
    for (const headers of [
      { origin: "http://localhost:5190" },
      { origin: "file://" },
      { origin: "null" },
    ]) {
      expect(checkMcpRequest(req(headers), TOKEN)).toMatchObject({
        ok: false,
        status: 403,
      });
    }
  });

  it("lets Node's fetch in, which marks every request as cors", () => {
    expect(checkMcpRequest(req({ "sec-fetch-mode": "cors" }), TOKEN).ok).toBe(
      true,
    );
  });

  it("needs the right bearer token", () => {
    expect(checkMcpRequest(req({ authorization: "" }), TOKEN)).toMatchObject({
      status: 401,
    });
    expect(
      checkMcpRequest(
        req({ authorization: `Bearer ${"b".repeat(43)}` }),
        TOKEN,
      ),
    ).toMatchObject({ status: 401 });
    expect(
      checkMcpRequest(req({ authorization: `Basic ${TOKEN}` }), TOKEN),
    ).toMatchObject({ status: 401 });
  });

  it("checks the token before saying which methods exist", () => {
    expect(
      checkMcpRequest(req({ authorization: "" }, { method: "GET" }), TOKEN),
    ).toMatchObject({ status: 401 });
    expect(checkMcpRequest(req({}, { method: "GET" }), TOKEN)).toMatchObject({
      status: 405,
      headers: { allow: "POST" },
    });
  });
});

describe("helpers", () => {
  it("knows loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:1")).toBe(true);
    expect(isLoopbackHost("192.168.1.2:5192")).toBe(false);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  it("compares tokens of any length safely", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches("short", TOKEN)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
});
