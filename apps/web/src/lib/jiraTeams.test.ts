import { describe, it, expect } from "vitest";
import type { AppState } from "@planner/core";
import type { JiraRequest, JiraResponse, JiraTransport } from "@planner/jira";
import {
  importInput,
  importedTeamFor,
  loadTeamPeople,
  loadTeamsDirectory,
  previewTeam,
} from "./jiraTeams";
import type { JiraSettings } from "./jiraSettings";

const SITE = "https://acme.atlassian.net";
const settings: JiraSettings = {
  baseUrl: SITE,
  email: "dana@example.com",
  apiToken: "token",
  hoursPerDay: 8,
  allowWrites: false,
};

const stars = { id: "uuid-stars", name: "Stars" };
const people = [
  { accountId: "ada", displayName: "Ada Lovelace" },
  { accountId: "cy", displayName: "Cy Twombly" },
  { accountId: "zed", displayName: "Zed Renamed-in-Jira" },
];

function state(): AppState {
  return {
    projects: [],
    teams: [
      {
        id: "manual",
        name: "Hand made",
        members: [{ id: "m1", name: "Cy  Twombly", specialization: "QA" }],
        offDays: {},
      },
      {
        id: "old-import",
        name: "Stars (EU)",
        jira: {
          baseUrl: `${SITE}/`,
          teamId: "uuid-stars",
          teamName: "Stars",
          syncedAt: "",
        },
        members: [
          {
            id: "m2",
            name: "Zed",
            specialization: "Frontend",
            jiraAccountId: "zed",
          },
        ],
        offDays: {},
      },
    ],
  };
}

/** The GraphQL team search, as opposed to the org lookup. */
function isSearch(req: JiraRequest): boolean {
  return (
    (req.body as { operationName?: string } | undefined)?.operationName ===
    "PlannerTeamSearch"
  );
}

function transport(route: (req: JiraRequest) => JiraResponse) {
  const calls: JiraRequest[] = [];
  const t: JiraTransport = {
    canWrite: false,
    request(req) {
      calls.push(req);
      return Promise.resolve(route(req));
    },
  };
  return { t, calls };
}

describe("loadTeamsDirectory", () => {
  it("finds the organization by itself, then lists its teams", async () => {
    const { t, calls } = transport((req) =>
      req.path === "/gateway/api/graphql"
        ? {
            status: 200,
            body: {
              data: { tenantContexts: [{ orgId: "org-1", cloudId: "c-1" }] },
            },
          }
        : {
            status: 200,
            body: { entities: [{ teamId: "t1", displayName: "Stars" }] },
          },
    );
    const result = await loadTeamsDirectory({ settings, transport: t });
    expect(result).toEqual({
      ok: true,
      orgId: "org-1",
      siteId: "c-1",
      teams: [{ id: "t1", name: "Stars" }],
    });
    expect(calls[1].path).toBe(
      "/gateway/api/public/teams/v1/org/org-1/teams?size=100&siteId=c-1",
    );
  });

  it("asks for the organization ID when the lookup is not allowed", async () => {
    const { t } = transport(() => ({ status: 403, body: null }));
    const result = await loadTeamsDirectory({ settings, transport: t });
    expect(result).toMatchObject({ ok: false, needsOrgId: true });
  });

  it("uses a pasted organization ID when the lookup fails", async () => {
    const { t, calls } = transport((req) =>
      req.path === "/gateway/api/graphql"
        ? { status: 403, body: null }
        : { status: 200, body: { entities: [] } },
    );
    const result = await loadTeamsDirectory({
      settings,
      transport: t,
      orgId: "org-typed",
    });
    expect(result).toMatchObject({ ok: true, orgId: "org-typed", teams: [] });
    expect(calls[1].path).toContain("/org/org-typed/teams");
  });

  it("says which step was refused, in Atlassian's words", async () => {
    const { t } = transport((req) =>
      isSearch(req)
        ? { status: 200, body: { errors: [{ message: "Search closed" }] } }
        : req.path === "/gateway/api/graphql"
          ? {
              status: 200,
              body: { data: { tenantContexts: [{ orgId: "org-1" }] } },
            }
          : { status: 403, body: { code: "FORBIDDEN", message: "No access" } },
    );
    const result = await loadTeamsDirectory({ settings, transport: t });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(
      // No site id came back, so: one Teams API refusal, then GraphQL's.
      /would not list the teams of this organization — No access \(FORBIDDEN\); Search closed/,
    );
  });

  it("names the organization it tried and Atlassian's reason", async () => {
    const { t } = transport((req) =>
      isSearch(req)
        ? { status: 200, body: { errors: [{ message: "Search closed" }] } }
        : req.path === "/gateway/api/graphql"
          ? {
              status: 200,
              body: { data: { tenantContexts: [{ orgId: "org-1" }] } },
            }
          : { status: 400, body: { code: "X", message: "Bad org" } },
    );
    const result = await loadTeamsDirectory({ settings, transport: t });
    expect(result).toMatchObject({
      ok: false,
      needsOrgId: true,
      triedOrgId: "org-1",
    });
    expect(!result.ok && result.message).toMatch(
      /organization org-1 \(found automatically\).*Bad org \(X\)/,
    );
  });

  it("needs a connection first", async () => {
    const { t, calls } = transport(() => ({ status: 200, body: null }));
    const result = await loadTeamsDirectory({
      settings: { ...settings, apiToken: "" },
      transport: t,
    });
    expect(result).toMatchObject({ ok: false, needsOrgId: false });
    expect(calls).toHaveLength(0);
  });
});

describe("loadTeamPeople", () => {
  it("says it was the member list that was refused", async () => {
    const { t, calls } = transport(() => ({
      status: 403,
      body: { code: "FORBIDDEN", message: "No access" },
    }));
    const result = await loadTeamPeople({
      settings,
      transport: t,
      directory: { orgId: "org-1", siteId: "c-1", teams: [] },
      teamId: "t1",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(
      /would not show this team's members — No access \(FORBIDDEN\)/,
    );
    expect(calls[0].path).toBe(
      "/gateway/api/public/teams/v1/org/org-1/teams/t1/members?siteId=c-1",
    );
  });
});

describe("loadTeamPeople fallbacks", () => {
  it("reads a group-synced team as its Jira group when refused", async () => {
    const { t, calls } = transport((req) =>
      req.path.startsWith("/rest/api/3/group/member")
        ? {
            status: 200,
            body: {
              isLast: true,
              values: [{ accountId: "ada", displayName: "Ada Lovelace" }],
            },
          }
        : { status: 403, body: { code: "FORBIDDEN", message: "No access" } },
    );
    const result = await loadTeamPeople({
      settings,
      transport: t,
      directory: {
        orgId: "org-1",
        siteId: "c-1",
        teams: [{ id: "t1", name: "Stars", groupId: "grp-9" }],
      },
      teamId: "t1",
    });
    expect(result).toEqual({
      ok: true,
      people: [{ accountId: "ada", displayName: "Ada Lovelace" }],
      source: { kind: "roster" },
    });
    expect(calls[1].path).toContain("groupId=grp-9");
  });

  it("falls back to the people on the team's Jira issues, and says so", async () => {
    const { t, calls } = transport((req) => {
      if (req.path === "/rest/api/3/field") {
        return {
          status: 200,
          body: [{ id: "customfield_10001", name: "Team", custom: true }],
        };
      }
      if (req.path.startsWith("/rest/api/3/search/jql")) {
        return {
          status: 200,
          body: {
            issues: [
              {
                fields: {
                  assignee: { accountId: "ada", displayName: "Ada Lovelace" },
                },
              },
            ],
          },
        };
      }
      if (req.path === "/gateway/api/graphql") {
        return {
          status: 200,
          body: {
            errors: [
              {
                message: "The underlying service teamsV2 status code is: 403",
                extensions: { statusCode: 403 },
              },
            ],
          },
        };
      }
      return { status: 403, body: { message: "Forbidden" } };
    });
    const result = await loadTeamPeople({
      settings,
      transport: t,
      directory: {
        orgId: "org-1",
        siteId: "c-1",
        teams: [{ id: "t1", name: "Stars" }],
      },
      teamId: "t1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.people).toEqual([
      { accountId: "ada", displayName: "Ada Lovelace", issueCount: 1 },
    ]);
    expect(result.source).toMatchObject({ kind: "issues", sinceDays: 180 });
    expect(result.source.kind === "issues" && result.source.refusal).toMatch(
      /^Jira wouldn't share this team's roster \(Forbidden; The underlying service teamsV2 status code is: 403\)\.$/,
    );
    const search = calls.find((c) => c.path.startsWith("/rest/api/3/search"));
    expect(search?.body).toMatchObject({
      jql: 'cf[10001] = "t1" AND updated >= -180d ORDER BY updated DESC',
    });
  });

  it("does not fall back when the token itself is rejected", async () => {
    const { t, calls } = transport(() => ({ status: 401, body: null }));
    const result = await loadTeamPeople({
      settings,
      transport: t,
      directory: { orgId: "org-1", siteId: "c-1", teams: [] },
      teamId: "t1",
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toMatch(
      /rejected your email and token/,
    );
    expect(calls.some((c) => c.path.startsWith("/rest/api/3/search"))).toBe(
      false,
    );
  });
});

describe("previewTeam", () => {
  const row = previewTeam(stars, people, state(), SITE);
  const by = (id: string) => row.people.find((p) => p.person.accountId === id)!;

  it("finds the team imported before, matching the site loosely", () => {
    expect(row.existing?.id).toBe("old-import");
  });

  it("ticks newcomers and skips people already in Planner", () => {
    expect(by("ada").selected).toBe(true);
    expect(by("cy").alreadyIn?.id).toBe("manual"); // by name
    expect(by("zed").alreadyIn?.id).toBe("old-import"); // by account id
    expect(by("cy").selected).toBe(false);
  });

  it("takes a specialization from a same-named person", () => {
    expect(by("cy").specialization).toBe("QA");
    expect(by("ada").specialization).toBe("");
  });
});

describe("importedTeamFor", () => {
  it("ignores a team from another site", () => {
    expect(
      importedTeamFor(stars, state().teams, "https://other.atlassian.net"),
    ).toBeUndefined();
  });
});

describe("importInput", () => {
  it("carries only ticked newcomers, and the Jira origin", () => {
    const row = previewTeam(stars, people, state(), SITE);
    const input = importInput(
      row,
      "  ",
      `${SITE}/`,
      "org-1",
      "2026-11-10T09:00:00.000Z",
    );
    expect(input).toEqual({
      teamId: "old-import",
      name: "Stars",
      jira: {
        baseUrl: SITE,
        orgId: "org-1",
        teamId: "uuid-stars",
        teamName: "Stars",
        syncedAt: "2026-11-10T09:00:00.000Z",
      },
      members: [
        { name: "Ada Lovelace", specialization: "", jiraAccountId: "ada" },
      ],
    });
  });
});
