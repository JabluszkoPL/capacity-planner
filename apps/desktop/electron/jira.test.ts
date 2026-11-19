/**
 * The relay's guard rail.
 *
 * This is the only place in the Mac app that can reach an arbitrary URL on the
 * user's behalf, and the rule keeping it narrow is pure — so it is tested
 * directly rather than through a running Electron window, where a lookalike
 * hostname or a path climbing out of the REST namespace would be tedious to
 * provoke and easy to miss.
 */
import { describe, it, expect, vi } from "vitest";
import { teamMembersQuery, teamSearchQuery, tenantQuery } from "@planner/jira";
import { checkJiraBody, checkJiraTarget, relayJiraRequest } from "./jira";

const SITE = "https://acme.atlassian.net";
const SEARCH = "/rest/api/3/search/jql";
const AUTH = "Basic dXNlcjp0b2tlbg==";

describe("checkJiraTarget", () => {
  it("allows the REST and agile namespaces on an Atlassian site", () => {
    expect(checkJiraTarget(SITE, SEARCH, "POST")).toEqual({
      ok: true,
      url: `${SITE}${SEARCH}`,
    });
    expect(checkJiraTarget(SITE, "/rest/agile/1.0/board", "GET").ok).toBe(true);
  });

  it("keeps the query string intact", () => {
    const check = checkJiraTarget(
      SITE,
      "/rest/api/3/issue/ACME-1?fields=summary",
      "GET",
    );
    expect(check.ok && check.url).toBe(
      `${SITE}/rest/api/3/issue/ACME-1?fields=summary`,
    );
  });

  it("refuses hosts that are not Jira, including lookalikes", () => {
    for (const host of [
      "https://evil.example",
      "https://acme.atlassian.net.evil.example",
      "https://notatlassian.net",
    ]) {
      expect(checkJiraTarget(host, SEARCH, "GET").ok).toBe(false);
    }
  });

  it("accepts a deployer-named extra host", () => {
    expect(
      checkJiraTarget(
        "https://jira.internal.example",
        SEARCH,
        "GET",
        "jira.internal.example",
      ).ok,
    ).toBe(true);
  });

  it("refuses plain http", () => {
    expect(checkJiraTarget("http://acme.atlassian.net", SEARCH, "GET").ok).toBe(
      false,
    );
  });

  it("refuses paths outside the REST namespace", () => {
    for (const path of ["/", "/secrets", "/plugins/servlet/x"]) {
      expect(checkJiraTarget(SITE, path, "GET").ok).toBe(false);
    }
  });

  it("refuses a path that climbs out of the namespace", () => {
    expect(checkJiraTarget(SITE, "/rest/api/3/../../secret", "GET").ok).toBe(
      false,
    );
  });

  it("refuses an absolute path pointing at another host", () => {
    expect(
      checkJiraTarget(SITE, "https://evil.example/rest/api/3/x", "GET").ok,
    ).toBe(false);
  });

  it("refuses methods other than GET, POST and PUT", () => {
    expect(checkJiraTarget(SITE, SEARCH, "DELETE").ok).toBe(false);
    expect(checkJiraTarget(SITE, SEARCH, "PATCH").ok).toBe(false);
  });
});

describe("relayJiraRequest", () => {
  const request = {
    baseUrl: SITE,
    path: SEARCH,
    method: "POST" as const,
    auth: AUTH,
    body: { jql: "parent = ACME-1" },
  };

  it("forwards the request and returns Jira's status and parsed body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ issues: [] }), { status: 200 }),
      );
    const res = await relayJiraRequest(request, undefined, fetchImpl as never);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issues: [] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${SITE}${SEARCH}`);
    expect(init.headers.authorization).toBe(AUTH);
    expect(init.body).toBe(JSON.stringify(request.body));
    // Without this, Atlassian's XSRF check rejects this POST even with valid
    // credentials.
    expect(init.headers["x-atlassian-token"]).toBe("no-check");
    // The relay runs on Chromium's stack, whose default UA is a browser's —
    // and Atlassian fails the XSRF check for a browser UA despite no-check.
    expect(init.headers["user-agent"]).not.toMatch(/Mozilla|Chrome|Electron/);
    expect(init.credentials).toBe("omit");
  });

  it("names the underlying cause when Node reports only 'fetch failed'", async () => {
    const cause = Object.assign(
      new Error("unable to get local issuer certificate"),
      { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
    );
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed", { cause }));
    const res = await relayJiraRequest(request, undefined, fetchImpl as never);
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toContain(
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    );
  });

  it("surfaces Retry-After so the caller can honour Jira's own backoff", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
      );
    const res = await relayJiraRequest(request, undefined, fetchImpl as never);
    expect(res.status).toBe(429);
    expect(res.headers?.["retry-after"]).toBe("30");
  });

  it("refuses a disallowed host without making any request", async () => {
    const fetchImpl = vi.fn();
    const res = await relayJiraRequest(
      { ...request, baseUrl: "https://evil.example" },
      undefined,
      fetchImpl as never,
    );
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload from the renderer", async () => {
    const fetchImpl = vi.fn();
    for (const bad of [null, "nope", {}, { baseUrl: SITE }]) {
      const res = await relayJiraRequest(bad, undefined, fetchImpl as never);
      expect(res.status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never echoes the token when the call fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const res = await relayJiraRequest(request, undefined, fetchImpl as never);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("dXNlcjp0b2tlbg==");
  });

  it("does not send a body on a GET", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await relayJiraRequest(
      { ...request, method: "GET", path: "/rest/api/3/myself" },
      undefined,
      fetchImpl as never,
    );
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });
});

describe("the Teams directory", () => {
  const ORG = "/gateway/api/public/teams/v1/org/org-1";
  const LOOKUP = {
    operationName: "PlannerTenant",
    query: tenantQuery("acme.atlassian.net"),
  };

  it("allows the team list, a team's members and the org lookup", () => {
    expect(checkJiraTarget(SITE, `${ORG}/teams?size=100`, "GET").ok).toBe(true);
    expect(checkJiraTarget(SITE, `${ORG}/teams/t-1/members`, "POST").ok).toBe(
      true,
    );
    expect(checkJiraTarget(SITE, "/gateway/api/graphql", "POST").ok).toBe(true);
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
      [`${ORG}/teams/../../../../../admin`, "GET"],
    ] as const) {
      expect(checkJiraTarget(SITE, path, method).ok).toBe(false);
    }
  });

  it("lets only the exact org lookup for this site through GraphQL", () => {
    const path = "/gateway/api/graphql";
    expect(checkJiraBody(SITE, path, LOOKUP)).toBe(true);
    expect(checkJiraBody(SITE, path, { query: LOOKUP.query })).toBe(true);
    expect(
      checkJiraBody(SITE, path, {
        query: tenantQuery("other.atlassian.net"),
      }),
    ).toBe(false);
    expect(
      checkJiraBody(SITE, path, { query: "mutation { deleteTeam }" }),
    ).toBe(false);
    expect(checkJiraBody(SITE, path, { ...LOOKUP, variables: {} })).toBe(false);
    expect(checkJiraBody(SITE, path, undefined)).toBe(false);
    // Other paths are not body-checked.
    expect(checkJiraBody(SITE, SEARCH, { jql: "x" })).toBe(true);
  });

  it("refuses a GraphQL mutation without making any request", async () => {
    const fetchImpl = vi.fn();
    const res = await relayJiraRequest(
      {
        baseUrl: SITE,
        path: "/gateway/api/graphql",
        method: "POST",
        auth: AUTH,
        body: { query: "mutation { x }" },
      },
      undefined,
      fetchImpl as never,
    );
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the Teams GraphQL fallbacks", () => {
  const path = "/gateway/api/graphql";

  it("lets the package's team search and member queries through", () => {
    for (const [operationName, query] of [
      ["PlannerTeamSearch", teamSearchQuery("org-1", "cloud-1")],
      ["PlannerTeamSearch", teamSearchQuery("org-1", "None", "Y3Vy+/=")],
      ["PlannerTeamMembers", teamMembersQuery("t-1", "cloud-1")],
      ["PlannerTeamMembers", teamMembersQuery("t-1", "cloud-1", "abc")],
    ]) {
      expect(checkJiraBody(SITE, path, { operationName, query })).toBe(true);
    }
  });

  it("refuses edited queries, mismatched names and mutations", () => {
    const search = teamSearchQuery("org-1", "cloud-1");
    for (const body of [
      { operationName: "PlannerTeamMembers", query: search },
      { query: search.replace("displayName", "displayName members") },
      { query: `${search} mutation { x }` },
      { query: search.replace("org-1", 'org-1") { y } #') },
      { query: "mutation PlannerTeamSearch { deleteTeam }" },
    ]) {
      expect(checkJiraBody(SITE, path, body)).toBe(false);
    }
  });

  it("forwards the beta header to GraphQL only, and only plain names", async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["x-experimentalapi"]);
      return new Response("{}", { status: 200 });
    });
    const query = teamSearchQuery("org-1", "c-1");
    const base = { baseUrl: SITE, auth: AUTH, method: "POST" as const };
    await relayJiraRequest(
      { ...base, path, body: { query }, experimental: ["teams-beta"] },
      undefined,
      fetchImpl as never,
    );
    await relayJiraRequest(
      { ...base, path, body: { query }, experimental: ["a\r\nb: c"] },
      undefined,
      fetchImpl as never,
    );
    await relayJiraRequest(
      { ...base, path: SEARCH, body: {}, experimental: ["teams-beta"] },
      undefined,
      fetchImpl as never,
    );
    expect(seen).toEqual(["teams-beta", undefined, undefined]);
  });
});
