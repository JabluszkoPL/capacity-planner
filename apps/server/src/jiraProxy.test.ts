/**
 * The proxy's guard rail, tested directly.
 *
 * `isAllowedJiraTarget` is the only thing standing between this server and
 * being an open relay, and its interesting cases — a lookalike hostname, a
 * path that escapes the REST namespace — are awkward to provoke over a real
 * socket. So the rule is tested as the pure function it is, and the request
 * plumbing is tested separately against a stubbed fetch.
 */
import { describe, it, expect, vi } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

// The guard spells these queries out itself; importing the package's builders
// here (a dev-only dependency) pins the two together.
import { teamMembersQuery, teamSearchQuery, tenantQuery } from "@planner/jira";
import {
  JIRA_BASE_HEADER,
  JIRA_PROXY_PREFIX,
  handleJiraProxy,
  isAllowedJiraBody,
  isAllowedJiraTarget,
  type JiraProxyOptions,
} from "./jiraProxy";

const readOnly: JiraProxyOptions = { allowWrites: false };
const writable: JiraProxyOptions = { allowWrites: true };
const SITE = "https://acme.atlassian.net";
const SEARCH = "/rest/api/3/search/jql";

describe("isAllowedJiraTarget", () => {
  it("allows a read against an Atlassian site", () => {
    const check = isAllowedJiraTarget(SITE, SEARCH, "POST", readOnly);
    expect(check).toEqual({ ok: true, url: `${SITE}${SEARCH}` });
  });

  it("keeps the query string", () => {
    const check = isAllowedJiraTarget(
      SITE,
      "/rest/api/3/issue/ACME-1?fields=summary",
      "GET",
      readOnly,
    );
    expect(check.ok && check.url).toBe(
      `${SITE}/rest/api/3/issue/ACME-1?fields=summary`,
    );
  });

  it("allows the agile namespace too", () => {
    expect(
      isAllowedJiraTarget(SITE, "/rest/agile/1.0/board", "GET", readOnly).ok,
    ).toBe(true);
  });

  it("refuses a non-Atlassian host", () => {
    const check = isAllowedJiraTarget(
      "https://evil.example",
      SEARCH,
      "GET",
      readOnly,
    );
    expect(check).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a lookalike host", () => {
    for (const host of [
      "https://acme.atlassian.net.evil.example",
      "https://notatlassian.net",
      "https://atlassian.net.co",
    ]) {
      expect(isAllowedJiraTarget(host, SEARCH, "GET", readOnly).ok).toBe(false);
    }
  });

  it("accepts a deployer-named extra host", () => {
    const opts = { allowWrites: false, extraHost: "jira.internal.example" };
    expect(
      isAllowedJiraTarget("https://jira.internal.example", SEARCH, "GET", opts)
        .ok,
    ).toBe(true);
  });

  it("refuses plain http", () => {
    expect(
      isAllowedJiraTarget("http://acme.atlassian.net", SEARCH, "GET", readOnly)
        .ok,
    ).toBe(false);
  });

  it("refuses a path outside the REST namespace", () => {
    for (const path of ["/", "/secrets", "/plugins/servlet/x"]) {
      expect(isAllowedJiraTarget(SITE, path, "GET", readOnly).ok).toBe(false);
    }
  });

  it("refuses a path that climbs out of the namespace", () => {
    expect(
      isAllowedJiraTarget(SITE, "/rest/api/3/../../secret", "GET", readOnly).ok,
    ).toBe(false);
  });

  it("refuses an absolute path pointing at another host", () => {
    expect(
      isAllowedJiraTarget(
        SITE,
        "https://evil.example/rest/api/3/x",
        "GET",
        readOnly,
      ).ok,
    ).toBe(false);
  });

  it("refuses PUT unless writes are enabled", () => {
    expect(isAllowedJiraTarget(SITE, SEARCH, "PUT", readOnly)).toMatchObject({
      ok: false,
      status: 405,
    });
    expect(isAllowedJiraTarget(SITE, SEARCH, "PUT", writable).ok).toBe(true);
  });

  it("refuses DELETE outright", () => {
    expect(isAllowedJiraTarget(SITE, SEARCH, "DELETE", writable).ok).toBe(
      false,
    );
  });
});

/* ------------------------------ the plumbing ----------------------------- */

interface Captured {
  status: number;
  body: string;
  headers: Record<string, unknown>;
}

function exchange(
  method: string,
  headers: Record<string, string>,
  body: string,
): { req: IncomingMessage; res: ServerResponse; done: Promise<Captured> } {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.headers = headers;
  const res = new ServerResponse(req);
  const chunks: string[] = [];
  let status = 0;
  let sent: Record<string, unknown> = {};
  res.writeHead = ((code: number, h?: Record<string, unknown>) => {
    status = code;
    sent = h ?? {};
    return res;
  }) as typeof res.writeHead;
  const done = new Promise<Captured>((resolve) => {
    res.end = ((chunk?: string) => {
      if (chunk) chunks.push(chunk);
      resolve({ status, body: chunks.join(""), headers: sent });
      return res;
    }) as typeof res.end;
  });
  if (body) {
    req.push(body);
    req.push(null);
  } else {
    req.push(null);
  }
  return { req, res, done };
}

describe("handleJiraProxy", () => {
  const auth = "Basic dXNlcjp0b2tlbg==";

  it("forwards the Authorization header and returns Jira's status and body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ issues: [] }), { status: 200 }),
      );
    const { req, res, done } = exchange(
      "POST",
      { authorization: auth, [JIRA_BASE_HEADER]: SITE },
      JSON.stringify({ jql: "parent = ACME-1" }),
    );
    await handleJiraProxy(
      req,
      res,
      `${JIRA_PROXY_PREFIX}${SEARCH}`,
      readOnly,
      fetchImpl as unknown as typeof fetch,
    );
    const out = await done;

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ issues: [] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${SITE}${SEARCH}`);
    expect((init.headers as Record<string, string>).authorization).toBe(auth);
    expect(init.body).toBe(JSON.stringify({ jql: "parent = ACME-1" }));
    // Without this, Atlassian's XSRF check rejects this POST even with valid
    // credentials.
    expect((init.headers as Record<string, string>)["x-atlassian-token"]).toBe(
      "no-check",
    );
  });

  it("passes an upstream 429's Retry-After through", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
      );
    const { req, res, done } = exchange(
      "GET",
      { authorization: auth, [JIRA_BASE_HEADER]: SITE },
      "",
    );
    await handleJiraProxy(
      req,
      res,
      `${JIRA_PROXY_PREFIX}/rest/api/3/issue/ACME-1`,
      readOnly,
      fetchImpl as unknown as typeof fetch,
    );
    const out = await done;
    expect(out.status).toBe(429);
    expect(out.headers["retry-after"]).toBe("30");
  });

  it("refuses a request with no Authorization header, without calling out", async () => {
    const fetchImpl = vi.fn();
    const { req, res, done } = exchange(
      "GET",
      { [JIRA_BASE_HEADER]: SITE },
      "",
    );
    await handleJiraProxy(
      req,
      res,
      `${JIRA_PROXY_PREFIX}${SEARCH}`,
      readOnly,
      fetchImpl as unknown as typeof fetch,
    );
    expect((await done).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a disallowed host before making any request", async () => {
    const fetchImpl = vi.fn();
    const { req, res, done } = exchange(
      "GET",
      { authorization: auth, [JIRA_BASE_HEADER]: "https://evil.example" },
      "",
    );
    await handleJiraProxy(
      req,
      res,
      `${JIRA_PROXY_PREFIX}${SEARCH}`,
      readOnly,
      fetchImpl as unknown as typeof fetch,
    );
    expect((await done).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a PUT when writes are disabled", async () => {
    const fetchImpl = vi.fn();
    const { req, res, done } = exchange(
      "PUT",
      { authorization: auth, [JIRA_BASE_HEADER]: SITE },
      "{}",
    );
    await handleJiraProxy(
      req,
      res,
      `${JIRA_PROXY_PREFIX}/rest/api/3/issue/ACME-1`,
      readOnly,
      fetchImpl as unknown as typeof fetch,
    );
    expect((await done).status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never echoes the token when the upstream call fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const { req, res, done } = exchange(
      "GET",
      { authorization: auth, [JIRA_BASE_HEADER]: SITE },
      "",
    );
    await handleJiraProxy(
      req,
      res,
      `${JIRA_PROXY_PREFIX}${SEARCH}`,
      readOnly,
      fetchImpl as unknown as typeof fetch,
    );
    const out = await done;
    expect(out.status).toBe(502);
    expect(out.body).not.toContain("dXNlcjp0b2tlbg==");
  });

  it("answers the CORS preflight without touching Jira", async () => {
    const fetchImpl = vi.fn();
    const { req, res, done } = exchange("OPTIONS", {}, "");
    await handleJiraProxy(
      req,
      res,
      `${JIRA_PROXY_PREFIX}${SEARCH}`,
      readOnly,
      fetchImpl as unknown as typeof fetch,
    );
    const out = await done;
    expect(out.status).toBe(204);
    expect(String(out.headers["access-control-allow-headers"])).toContain(
      JIRA_BASE_HEADER,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the Teams directory", () => {
  const ORG = "/gateway/api/public/teams/v1/org/org-1";
  const LOOKUP = JSON.stringify({
    operationName: "PlannerTenant",
    query: tenantQuery("acme.atlassian.net"),
  });

  it("allows the team list, a team's members and the org lookup", () => {
    expect(
      isAllowedJiraTarget(SITE, `${ORG}/teams?size=100`, "GET", readOnly).ok,
    ).toBe(true);
    expect(
      isAllowedJiraTarget(SITE, `${ORG}/teams/t-1/members`, "POST", readOnly)
        .ok,
    ).toBe(true);
    expect(
      isAllowedJiraTarget(SITE, "/gateway/api/graphql", "POST", readOnly).ok,
    ).toBe(true);
  });

  it("refuses membership changes, team edits and other gateway paths", () => {
    for (const [path, method] of [
      [`${ORG}/teams/t-1/members/add`, "POST"],
      [`${ORG}/teams/t-1/members/remove`, "POST"],
      [`${ORG}/teams`, "POST"],
      [`${ORG}/teams/t-1`, "PUT"],
      [`${ORG}/teams/t-1/members`, "GET"],
      ["/gateway/api/graphql", "GET"],
      ["/gateway/api/other", "GET"],
    ] as const) {
      expect(isAllowedJiraTarget(SITE, path, method, writable).ok).toBe(false);
    }
  });

  it("lets only the exact org lookup for this site through GraphQL", () => {
    const path = "/gateway/api/graphql";
    expect(isAllowedJiraBody(SITE, path, LOOKUP)).toBe(true);
    expect(
      isAllowedJiraBody(
        SITE,
        path,
        JSON.stringify({ query: tenantQuery("other.atlassian.net") }),
      ),
    ).toBe(false);
    expect(
      isAllowedJiraBody(
        SITE,
        path,
        JSON.stringify({ query: "mutation { x }" }),
      ),
    ).toBe(false);
    expect(isAllowedJiraBody(SITE, path, "not json")).toBe(false);
    expect(isAllowedJiraBody(SITE, SEARCH, '{"jql":"x"}')).toBe(true);
  });
});

describe("the Teams GraphQL fallbacks", () => {
  const path = "/gateway/api/graphql";
  const body = (operationName: string, query: string) =>
    JSON.stringify({ operationName, query });

  it("lets the package's team search and member queries through", () => {
    for (const q of [
      body("PlannerTeamSearch", teamSearchQuery("org-1", "cloud-1")),
      body("PlannerTeamSearch", teamSearchQuery("org-1", "None", "Y3Vy+/=")),
      body("PlannerTeamMembers", teamMembersQuery("t-1", "cloud-1")),
      body("PlannerTeamMembers", teamMembersQuery("t-1", "cloud-1", "abc")),
    ]) {
      expect(isAllowedJiraBody(SITE, path, q)).toBe(true);
    }
  });

  it("refuses edited queries, mismatched names and mutations", () => {
    const search = teamSearchQuery("org-1", "cloud-1");
    for (const q of [
      body("PlannerTeamMembers", search),
      body(
        "PlannerTeamSearch",
        search.replace("displayName", "displayName members"),
      ),
      body("PlannerTeamSearch", `${search} mutation { x }`),
      body("PlannerTeamSearch", search.replace("org-1", 'org-1") { y } #')),
      body("X", "mutation PlannerTeamSearch { deleteTeam }"),
    ]) {
      expect(isAllowedJiraBody(SITE, path, q)).toBe(false);
    }
  });

  it("forwards the beta header to GraphQL only, and only plain names", async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["x-experimentalapi"]);
      return new Response("{}", { status: 200 });
    });
    const run = async (url: string, header: string, payload?: string) => {
      const socket = new Socket();
      const req = new IncomingMessage(socket);
      req.method = payload === undefined ? "GET" : "POST";
      req.headers = {
        [JIRA_BASE_HEADER]: SITE,
        authorization: "Basic x",
        "x-experimentalapi": header,
      };
      const res = new ServerResponse(req);
      const done = handleJiraProxy(
        req,
        res,
        `${JIRA_PROXY_PREFIX}${url}`,
        readOnly,
        fetchImpl as never,
      );
      if (payload !== undefined) req.push(payload);
      req.push(null);
      await done;
    };
    const search = body("PlannerTeamSearch", teamSearchQuery("org-1", "c-1"));
    await run(path, "teams-beta,team-members-beta", search);
    await run(path, "teams-beta\r\nx-evil: 1", search);
    await run("/rest/api/3/myself", "teams-beta");
    expect(seen).toEqual([
      "teams-beta,team-members-beta",
      undefined,
      undefined,
    ]);
  });
});
