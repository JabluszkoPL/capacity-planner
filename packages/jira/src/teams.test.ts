import { describe, it, expect } from "vitest";
import type { JiraRequest, JiraResponse, JiraTransport } from "./transport";
import { basicAuth } from "./transport";
import { JiraError } from "./refresh";
import {
  fetchJiraTenant,
  fetchTeamDirectory,
  fetchTeamMembers,
  fetchTeamIssuePeople,
  parseOrgId,
  teamIssuesJql,
  teamMembersQuery,
  teamSearchQuery,
  tenantQuery,
} from "./teams";

const SITE = "https://acme.atlassian.net";
const auth = basicAuth("dana@example.com", "secret");
const ORG = "0a1b2c3d-org";

/** Answers by path, recording every request. */
function routed(route: (req: JiraRequest) => JiraResponse | undefined) {
  const calls: JiraRequest[] = [];
  const transport: JiraTransport = {
    canWrite: false,
    request(req) {
      calls.push(req);
      const res = route(req);
      return res
        ? Promise.resolve(res)
        : Promise.reject(new Error(`unrouted ${req.method} ${req.path}`));
    },
  };
  return { transport, calls };
}

const ok = (body: unknown): JiraResponse => ({ status: 200, body });

describe("parseOrgId", () => {
  it("accepts a bare id, an ARI and an admin URL", () => {
    expect(parseOrgId(" abc-123 ")).toBe("abc-123");
    expect(parseOrgId("ari:cloud:platform::org/abc-123")).toBe("abc-123");
    expect(parseOrgId("https://admin.atlassian.com/o/abc-123/overview")).toBe(
      "abc-123",
    );
  });

  it("rejects anything that could escape a path segment", () => {
    expect(parseOrgId("abc/../x")).toBeNull();
    expect(parseOrgId("")).toBeNull();
  });
});

describe("tenantQuery", () => {
  it("is fixed text around the host", () => {
    expect(tenantQuery("acme.atlassian.net")).toBe(
      'query PlannerTenant { tenantContexts(hostNames: ["acme.atlassian.net"]) { cloudId orgId } }',
    );
    expect(() => tenantQuery('x"]) { y } #')).toThrow(RangeError);
  });
});

describe("GraphQL Teams queries", () => {
  it("are fixed text around validated ids", () => {
    expect(teamSearchQuery("org-1", "cloud-1", "Y3Vy")).toBe(
      'query PlannerTeamSearch { team @optIn(to: "Team-search-v2") { teamSearchV2(organizationId: "ari:cloud:platform::org/org-1", siteId: "cloud-1", first: 100, after: "Y3Vy") { pageInfo { hasNextPage endCursor } edges { node { team { id displayName } } } } } }',
    );
    expect(teamMembersQuery("t-1", "cloud-1")).toBe(
      'query PlannerTeamMembers { team { teamV2(id: "ari:cloud:identity::team/t-1", siteId: "cloud-1") @optIn(to: "Team") { members(first: 50) { pageInfo { hasNextPage endCursor } edges { node { member { accountId } } } } } } }',
    );
  });

  it("refuse anything that could break out of a string literal", () => {
    expect(() => teamSearchQuery('x") { y }', "c")).toThrow(RangeError);
    expect(() => teamMembersQuery("t", "c", 'a" } }')).toThrow(RangeError);
  });
});

describe("fetchJiraTenant", () => {
  it("reads the org id and cloud id for the site's host", async () => {
    const { transport, calls } = routed(() =>
      ok({
        data: {
          tenantContexts: [
            { cloudId: "cloud-1", orgId: "ari:cloud:platform::org/org-9" },
          ],
        },
      }),
    );
    expect(await fetchJiraTenant(transport, { baseUrl: SITE, auth })).toEqual({
      orgId: "org-9",
      cloudId: "cloud-1",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/gateway/api/graphql",
      body: { query: tenantQuery("acme.atlassian.net") },
    });
  });

  it("returns null when the gateway knows no org", async () => {
    const { transport } = routed(() => ok({ data: { tenantContexts: [] } }));
    expect(
      await fetchJiraTenant(transport, { baseUrl: SITE, auth }),
    ).toBeNull();
  });
});

describe("fetchTeamDirectory", () => {
  it("asks site-scoped first, pages it and skips archived teams", async () => {
    const { transport, calls } = routed((req) => {
      if (req.path.includes("cursor=c2")) {
        return ok({
          entities: [
            { teamId: "t-old", displayName: "Old", state: "ARCHIVED" },
            { teamId: "t-b", displayName: "Bravo", state: "ACTIVE" },
          ],
          cursor: null,
        });
      }
      return ok({
        entities: [
          { teamId: "t-a", displayName: "Alpha", description: "Core" },
        ],
        cursor: "c2",
      });
    });
    const teams = await fetchTeamDirectory(transport, {
      baseUrl: SITE,
      auth,
      orgId: ORG,
      siteId: "cloud-1",
    });
    expect(teams).toEqual([
      { id: "t-a", name: "Alpha", description: "Core" },
      { id: "t-b", name: "Bravo" },
    ]);
    // siteId is mandatory now, so the org-wide list is never needed here.
    expect(calls.map((c) => c.path)).toEqual([
      `/gateway/api/public/teams/v1/org/${ORG}/teams?size=100&siteId=cloud-1`,
      `/gateway/api/public/teams/v1/org/${ORG}/teams?size=100&siteId=cloud-1&cursor=c2`,
    ]);
  });

  it("falls back to the org-wide list when the site-scoped one is refused", async () => {
    for (const status of [400, 403]) {
      const { transport, calls } = routed((req) =>
        req.path.includes("siteId=")
          ? { status, body: { code: "NOPE", message: "Not here" } }
          : ok({ entities: [{ teamId: "t-a", displayName: "Alpha" }] }),
      );
      const teams = await fetchTeamDirectory(transport, {
        baseUrl: SITE,
        auth,
        orgId: ORG,
        siteId: "cloud-1",
      });
      expect(teams).toEqual([{ id: "t-a", name: "Alpha" }]);
      expect(calls).toHaveLength(2);
    }
  });

  it("refuses an org id that is not a plain path segment", async () => {
    const { transport } = routed(() => ok({}));
    await expect(
      fetchTeamDirectory(transport, { baseUrl: SITE, auth, orgId: "../x" }),
    ).rejects.toThrow(RangeError);
  });

  it("says why, in Atlassian's words, when every way is refused", async () => {
    const { transport } = routed((req) =>
      req.path === "/gateway/api/graphql"
        ? ok({ errors: [{ message: "Field 'teamSearchV2' undefined" }] })
        : {
            status: 400,
            body: { code: "INVALID_ORG", message: "Organization is invalid" },
          },
    );
    const err = await fetchTeamDirectory(transport, {
      baseUrl: SITE,
      auth,
      orgId: ORG,
      siteId: "cloud-1",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).message).toBe(
      "Jira rejected the request (HTTP 400): Organization is invalid (INVALID_ORG); " +
        "Organization is invalid (INVALID_ORG); Field 'teamSearchV2' undefined",
    );
  });

  it("falls back to GraphQL team search when the Teams API is closed", async () => {
    const { transport, calls } = routed((req) => {
      if (req.path !== "/gateway/api/graphql") {
        return { status: 403, body: { code: "FORBIDDEN", message: "No" } };
      }
      return ok({
        data: {
          team: {
            teamSearchV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  node: {
                    team: {
                      id: "ari:cloud:identity::team/t-a",
                      displayName: "Alpha",
                    },
                  },
                },
              ],
            },
          },
        },
      });
    });
    const teams = await fetchTeamDirectory(transport, {
      baseUrl: SITE,
      auth,
      orgId: ORG,
      siteId: "cloud-1",
    });
    expect(teams).toEqual([{ id: "t-a", name: "Alpha" }]);
    const gql = calls[2];
    expect(gql.experimental).toEqual(["teams-beta", "team-members-beta"]);
    expect(gql.body).toEqual({
      operationName: "PlannerTeamSearch",
      query: teamSearchQuery(ORG, "cloud-1"),
    });
  });

  it("keeps a team's Jira group from the directory", async () => {
    const { transport } = routed(() =>
      ok({
        entities: [
          {
            teamId: "t-g",
            displayName: "Grouped",
            externalReference: { id: "grp-1", source: "ATLASSIAN_GROUP" },
          },
        ],
      }),
    );
    expect(
      await fetchTeamDirectory(transport, {
        baseUrl: SITE,
        auth,
        orgId: ORG,
        siteId: "cloud-1",
      }),
    ).toEqual([{ id: "t-g", name: "Grouped", groupId: "grp-1" }]);
  });

  it("surfaces a refusal as a typed error", async () => {
    const { transport } = routed(() => ({ status: 403, body: null }));
    const err = await fetchTeamDirectory(transport, {
      baseUrl: SITE,
      auth,
      orgId: ORG,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).kind).toBe("auth");
  });
});

describe("fetchTeamMembers", () => {
  it("pages member ids, then names them, skipping apps and leavers", async () => {
    const { transport, calls } = routed((req) => {
      if (req.path.includes("/members")) {
        const after = (req.body as { after?: string }).after;
        return after
          ? ok({
              results: [{ accountId: "bot" }, { accountId: "gone" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            })
          : ok({
              results: [{ accountId: "ada" }, { accountId: "bo" }],
              pageInfo: { hasNextPage: true, endCursor: "p2" },
            });
      }
      if (req.path.startsWith("/rest/api/3/user/bulk")) {
        return ok({
          values: [
            { accountId: "bo", displayName: "Bo Diddley", active: true },
            { accountId: "ada", displayName: "Ada Lovelace", active: true },
            { accountId: "bot", displayName: "CI", accountType: "app" },
            { accountId: "gone", displayName: "Left", active: false },
          ],
        });
      }
      return undefined;
    });
    const members = await fetchTeamMembers(transport, {
      baseUrl: SITE,
      auth,
      orgId: ORG,
      teamId: "team-1",
    });
    expect(members).toEqual([
      { accountId: "ada", displayName: "Ada Lovelace" },
      { accountId: "bo", displayName: "Bo Diddley" },
    ]);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", `/gateway/api/public/teams/v1/org/${ORG}/teams/team-1/members`],
      ["POST", `/gateway/api/public/teams/v1/org/${ORG}/teams/team-1/members`],
      [
        "GET",
        "/rest/api/3/user/bulk?accountId=ada&accountId=bo&accountId=bot&accountId=gone&maxResults=50",
      ],
    ]);
    expect(calls[1].body).toEqual({ first: 50, after: "p2" });
  });

  it("reads a group-synced team's members from its Jira group", async () => {
    const { transport, calls } = routed((req) => {
      if (req.path.includes("/members")) {
        return { status: 403, body: { code: "FORBIDDEN", message: "No" } };
      }
      if (req.path.startsWith("/rest/api/3/group/member")) {
        return ok({
          isLast: true,
          values: [
            { accountId: "ada", displayName: "Ada Lovelace", active: true },
            { accountId: "bot", displayName: "CI", accountType: "app" },
          ],
        });
      }
      return undefined;
    });
    const members = await fetchTeamMembers(transport, {
      baseUrl: SITE,
      auth,
      orgId: ORG,
      siteId: "cloud-1",
      teamId: "team-1",
      groupId: "grp-1",
    });
    expect(members).toEqual([
      { accountId: "ada", displayName: "Ada Lovelace" },
    ]);
    expect(calls[1].path).toBe(
      "/rest/api/3/group/member?groupId=grp-1&includeInactiveUsers=false&startAt=0&maxResults=50",
    );
  });

  it("falls back to GraphQL members, then names them", async () => {
    const { transport, calls } = routed((req) => {
      if (req.path.includes("/members")) {
        return { status: 403, body: { code: "FORBIDDEN", message: "No" } };
      }
      if (req.path === "/gateway/api/graphql") {
        return ok({
          data: {
            team: {
              teamV2: {
                members: {
                  pageInfo: { hasNextPage: false },
                  edges: [{ node: { member: { accountId: "ada" } } }],
                },
              },
            },
          },
        });
      }
      return ok({
        values: [{ accountId: "ada", displayName: "Ada Lovelace" }],
      });
    });
    const members = await fetchTeamMembers(transport, {
      baseUrl: SITE,
      auth,
      orgId: ORG,
      siteId: "cloud-1",
      teamId: "team-1",
    });
    expect(members).toEqual([
      { accountId: "ada", displayName: "Ada Lovelace" },
    ]);
    expect(calls[1].body).toEqual({
      operationName: "PlannerTeamMembers",
      query: teamMembersQuery("team-1", "cloud-1"),
    });
  });

  it("reports every refusal when no route gives the members", async () => {
    const { transport } = routed((req) =>
      req.path === "/gateway/api/graphql"
        ? ok({
            data: { team: { teamV2: null } },
            errors: [
              {
                message: "Not allowed",
                extensions: { statusCode: 403 },
              },
            ],
          })
        : { status: 403, body: { code: "FORBIDDEN", message: "No access" } },
    );
    const err = await fetchTeamMembers(transport, {
      baseUrl: SITE,
      auth,
      orgId: ORG,
      siteId: "cloud-1",
      teamId: "team-1",
      groupId: "grp-1",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).kind).toBe("auth");
    expect((err as JiraError).message).toBe(
      "Jira rejected the request (HTTP 403): No access (FORBIDDEN); No access (FORBIDDEN); Not allowed",
    );
  });

  it("asks for no names when the team is empty", async () => {
    const { transport, calls } = routed(() =>
      ok({ results: [], pageInfo: { hasNextPage: false } }),
    );
    expect(
      await fetchTeamMembers(transport, {
        baseUrl: SITE,
        auth,
        orgId: ORG,
        teamId: "team-1",
      }),
    ).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("fetchTeamIssuePeople", () => {
  it("lists the assignees of the team's issues, most issues first", async () => {
    const { transport, calls } = routed((req) => {
      if (req.path === "/rest/api/3/field") {
        return ok([{ id: "customfield_10001", name: "Team", custom: true }]);
      }
      const a = (accountId: string, displayName: string, extra = {}) => ({
        fields: { assignee: { accountId, displayName, ...extra } },
      });
      return ok({
        issues: [
          a("bo", "Bo Diddley"),
          a("ada", "Ada Lovelace"),
          a("ada", "Ada Lovelace"),
          a("gone", "Left", { active: false }),
          a("bot", "CI", { accountType: "app" }),
          { fields: { assignee: null } },
        ],
      });
    });
    const people = await fetchTeamIssuePeople(transport, {
      baseUrl: SITE,
      auth,
      teamId: "team-1",
    });
    expect(people).toEqual([
      { accountId: "ada", displayName: "Ada Lovelace", issueCount: 2 },
      { accountId: "bo", displayName: "Bo Diddley", issueCount: 1 },
    ]);
    expect(calls[1].body).toMatchObject({
      jql: 'cf[10001] = "team-1" AND updated >= -180d ORDER BY updated DESC',
      fields: ["assignee"],
    });
  });

  it("refuses a team id that could break out of the JQL string", () => {
    expect(() => teamIssuesJql("customfield_10001", 'x" OR 1=1')).toThrow(
      RangeError,
    );
  });
});
