import { describe, it, expect, vi } from "vitest";
import {
  JiraUnavailableError,
  createJiraTransport,
  proxyOriginFromSyncUrl,
  unavailableJiraTransport,
} from "./jiraTransport";
import type { PlannerHost } from "./hostBridge";

const request = {
  baseUrl: "https://acme.atlassian.net",
  path: "/rest/api/3/myself",
  method: "GET" as const,
  auth: "Basic dXNlcjp0b2tlbg==",
};

function fakeHost(jira?: PlannerHost["jira"]): PlannerHost {
  return {
    db: {} as PlannerHost["db"],
    syncUrl: null,
    jira,
    platform: "darwin",
    version: "38.0.0",
  };
}

describe("proxyOriginFromSyncUrl", () => {
  it("maps a websocket url onto the http origin of the same server", () => {
    expect(proxyOriginFromSyncUrl("ws://192.168.1.5:5191/ws")).toBe(
      "http://192.168.1.5:5191",
    );
    expect(proxyOriginFromSyncUrl("wss://planner.example.com/ws")).toBe(
      "https://planner.example.com",
    );
  });

  it("returns null for something that is not a url", () => {
    expect(proxyOriginFromSyncUrl("not a url")).toBeNull();
  });
});

describe("createJiraTransport", () => {
  it("prefers the Electron bridge when the Mac app provides one", async () => {
    const bridgeRequest = vi
      .fn()
      .mockResolvedValue({ status: 200, body: { displayName: "Sam" } });
    const transport = createJiraTransport({
      host: fakeHost({ request: bridgeRequest, canWrite: true }),
      sync: "ws://localhost:5191/ws",
    });

    expect(transport.kind).toBe("electron");
    expect(transport.canWrite).toBe(true);
    await transport.request(request);
    expect(bridgeRequest).toHaveBeenCalledWith(request);
  });

  it("gives reachable transports a phrase, not a sentence", () => {
    const viaProxy = createJiraTransport({
      host: null,
      sync: "ws://localhost:5191/ws",
    });
    expect(viaProxy.description).toBe("via the Planner sync server");
    expect(viaProxy.unavailableReason).toBeUndefined();
  });

  it("falls back to the sync server proxy in a browser", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    const transport = createJiraTransport({
      host: null,
      sync: "ws://localhost:5191/ws",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(transport.kind).toBe("proxy");
    const res = await transport.request(request);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:5191/api/jira/rest/api/3/myself");
    // The site being queried travels in a header, so the path stays a verbatim
    // Jira path the server can validate.
    expect(init.headers["x-planner-jira-base"]).toBe(request.baseUrl);
    expect(init.headers.authorization).toBe(request.auth);
    // Without this, Atlassian's XSRF check rejects POST/PUT calls (e.g. the
    // JQL search endpoint refresh depends on) even with valid credentials.
    expect(init.headers["x-atlassian-token"]).toBe("no-check");
  });

  it("sends beta program names as X-ExperimentalApi, and nothing otherwise", async () => {
    const sent: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response("{}", { status: 200 });
    });
    const transport = createJiraTransport({
      host: null,
      sync: "ws://localhost:5191/ws",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await transport.request({
      ...request,
      path: "/gateway/api/graphql",
      method: "POST",
      body: { query: "q" },
      experimental: ["teams-beta", "team-members-beta"],
    });
    await transport.request(request);
    expect(sent[0]["x-experimentalapi"]).toBe("teams-beta,team-members-beta");
    expect(sent[1]["x-experimentalapi"]).toBeUndefined();
  });

  it("passes Retry-After through from the proxy", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { status: 429, headers: { "retry-after": "12" } }),
      );
    const transport = createJiraTransport({
      host: null,
      sync: "ws://localhost:5191/ws",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await transport.request(request);
    expect(res.headers?.["retry-after"]).toBe("12");
  });

  it("reports the proxy being unreachable as unavailable, not as a Jira error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const transport = createJiraTransport({
      host: null,
      sync: "ws://localhost:5191/ws",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport.request(request)).rejects.toBeInstanceOf(
      JiraUnavailableError,
    );
  });

  it("uses the dev proxy when one is configured and there is no server", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const transport = createJiraTransport({
      host: null,
      sync: null,
      devTarget: "https://acme.atlassian.net",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(transport.kind).toBe("dev-proxy");
    await transport.request(request);
    expect(fetchImpl.mock.calls[0][0]).toBe("/jira-dev/rest/api/3/myself");
  });

  it("refuses, with a reason, when there is no way to reach Jira", async () => {
    const transport = createJiraTransport({
      host: null,
      sync: null,
      devTarget: undefined,
    });
    expect(transport.kind).toBe("none");
    expect(transport.canWrite).toBe(false);
    // The description is a phrase that slots into "Refresh runs …"; the full
    // explanation lives in unavailableReason so neither reads as a stutter.
    expect(transport.description).not.toMatch(/\.$/);
    expect(transport.unavailableReason).toMatch(/Mac app or a sync server/);
    await expect(transport.request(request)).rejects.toBeInstanceOf(
      JiraUnavailableError,
    );
  });

  it("honours an explicitly absent dev target over the ambient one", () => {
    // Pinned because it silently broke once: a developer with this set in their
    // own .env made "there is no way to reach Jira" quietly become "use my
    // proxy", and the test passed for the wrong reason.
    vi.stubEnv("VITE_JIRA_DEV_TARGET", "https://acme.atlassian.net");
    try {
      expect(
        createJiraTransport({ host: null, sync: null, devTarget: undefined })
          .kind,
      ).toBe("none");
      // With the key absent, the ambient value is what should be picked up.
      expect(createJiraTransport({ host: null, sync: null }).kind).toBe(
        "dev-proxy",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("treats a host with no jira bridge as a plain browser", () => {
    const transport = createJiraTransport({
      host: fakeHost(undefined),
      sync: null,
      devTarget: undefined,
    });
    expect(transport.kind).toBe("none");
  });
});

describe("unavailableJiraTransport", () => {
  it("rejects every request with the reason it was given", async () => {
    const transport = unavailableJiraTransport("no network here");
    await expect(transport.request(request)).rejects.toThrow("no network here");
  });
});
