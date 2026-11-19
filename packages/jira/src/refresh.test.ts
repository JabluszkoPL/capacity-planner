import { describe, it, expect } from "vitest";
import type { JiraFieldIds } from "@planner/core";
import childrenPage1 from "./__fixtures__/children-page1.json";
import childrenPage2 from "./__fixtures__/children-page2.json";
import epicsEmpty from "./__fixtures__/epics-empty.json";
import epicsFixture from "./__fixtures__/epics.json";
import fieldList from "./__fixtures__/field-list.json";
import initiativeFixture from "./__fixtures__/initiative.json";
import { JiraError, fetchInitiativeSnapshot } from "./refresh";
import type { JiraRequest, JiraResponse, JiraTransport } from "./transport";
import { basicAuth } from "./transport";

const BASE_URL = "https://acme.atlassian.net";
const AUTH = basicAuth("dana@example.com", "super-secret-token");
const NOW = "2026-09-15T08:00:00.000Z";

type Scripted = JiraResponse | Error;

function ok(body: unknown): JiraResponse {
  return { status: 200, body };
}

/**
 * A transport that replays a script. Every request is recorded so a test can
 * assert not just the answer but the conversation that produced it.
 */
function scripted(script: Scripted[]) {
  const calls: JiraRequest[] = [];
  const queue = [...script];
  const transport: JiraTransport = {
    canWrite: false,
    request(req) {
      calls.push(req);
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error(`unscripted request: ${req.method} ${req.path}`),
        );
      }
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  };
  return { transport, calls };
}

/** field discovery, initiative, empty `parent =`, `"Parent Link" =`, 2 pages. */
function happyScript(): Scripted[] {
  return [
    ok(fieldList),
    ok(initiativeFixture),
    ok(epicsEmpty),
    ok(epicsFixture),
    ok(childrenPage1),
    ok(childrenPage2),
  ];
}

function run(
  script: Scripted[],
  extra: {
    fieldIds?: JiraFieldIds;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const { transport, calls } = scripted(script);
  const promise = fetchInitiativeSnapshot(transport, {
    baseUrl: BASE_URL,
    auth: AUTH,
    key: "ACME-1",
    now: NOW,
    sleep: extra.sleep ?? (() => Promise.resolve()),
    fieldIds: extra.fieldIds,
  });
  return { promise, calls };
}

function jqlOf(req: JiraRequest): string {
  return (req.body as { jql: string }).jql;
}

describe("fetchInitiativeSnapshot", () => {
  it("reads an initiative, its epics and their children", async () => {
    const { promise, calls } = run(happyScript());
    const snap = await promise;

    expect(snap.fetchedAt).toBe(NOW);
    expect(snap.initiative.key).toBe("ACME-1");
    expect(snap.epics.map((e) => e.key)).toEqual(["ACME-10", "ACME-11"]);
    expect(snap.epics[0].totals).toEqual({
      originalSec: 100800,
      spentSec: 57600,
      remainingSec: 43200,
      done: 1,
      all: 3,
    });
    expect(snap.epics[0].children.map((c) => c.statusCategory)).toEqual([
      "done",
      "indeterminate",
      "new",
    ]);
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.baseUrl === BASE_URL && c.auth === AUTH)).toBe(
      true,
    );
  });

  it("discovers field ids and asks for them on every issue", async () => {
    const { promise, calls } = run(happyScript());
    const snap = await promise;

    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/rest/api/3/field",
    });
    expect(snap.fieldIds).toEqual({
      startDate: "customfield_10015",
      sprint: "customfield_10020",
      storyPoints: "customfield_10041",
      // Not in this field list: Atlassian's own id.
      team: "customfield_10001",
    });
    expect(calls[1].path).toContain("/rest/api/3/issue/ACME-1?fields=");
    expect(decodeURIComponent(calls[1].path)).toContain("customfield_10041");
    expect((calls[3].body as { fields: string[] }).fields).toContain(
      "customfield_10015",
    );
  });

  it("skips field discovery when the caller cached the ids", async () => {
    const script = happyScript();
    script.shift();
    const { promise, calls } = run(script, {
      fieldIds: { startDate: "customfield_10015" },
    });
    const snap = await promise;

    expect(calls[0].path).toContain("/rest/api/3/issue/ACME-1");
    expect(snap.fieldIds).toEqual({ startDate: "customfield_10015" });
  });

  it("tries the next hierarchy query when the first returns no epics", async () => {
    const { promise, calls } = run(happyScript());
    await promise;

    expect(calls[2].path).toBe("/rest/api/3/search/jql");
    expect(jqlOf(calls[2])).toBe("parent = ACME-1");
    expect(jqlOf(calls[3])).toBe('"Parent Link" = ACME-1');
  });

  it("treats a rejected query as 'this site does not work that way'", async () => {
    // A site without Advanced Roadmaps answers `"Parent Link"` with a 400.
    const { promise, calls } = run([
      ok(fieldList),
      ok(initiativeFixture),
      ok(epicsEmpty),
      {
        status: 400,
        body: { errorMessages: ["Field 'Parent Link' does not exist."] },
      },
      ok(epicsFixture),
      ok(childrenPage1),
      ok(childrenPage2),
    ]);
    const snap = await promise;

    expect(jqlOf(calls[4])).toBe(
      'issue in linkedIssues("ACME-1", "initiates")',
    );
    expect(snap.epics).toHaveLength(2);
  });

  it("retries a 403 POST search using Jira's GET variant", async () => {
    const { promise, calls } = run([
      ok(fieldList),
      ok(initiativeFixture),
      { status: 403, body: { errorMessages: ["XSRF check failed"] } },
      ok(epicsFixture),
      ok(childrenPage1),
      ok(childrenPage2),
    ]);
    const snap = await promise;

    expect(calls[2]).toMatchObject({
      method: "POST",
      path: "/rest/api/3/search/jql",
    });
    expect(calls[3].method).toBe("GET");
    const fallback = new URL(calls[3].path, BASE_URL);
    expect(fallback.pathname).toBe("/rest/api/3/search/jql");
    expect(fallback.searchParams.get("jql")).toBe("parent = ACME-1");
    expect(fallback.searchParams.get("maxResults")).toBe("100");
    expect(snap.epics).toHaveLength(2);
  });

  it("keeps only epics unless that would leave nothing", async () => {
    const snap = await run(happyScript()).promise;
    // ACME-99 is a Task that rode along on the hierarchy query.
    expect(snap.epics.map((e) => e.key)).not.toContain("ACME-99");

    const onlyTasks = {
      issues: [epicsFixture.issues[2]],
    };
    const fallback = await run([
      ok(fieldList),
      ok(initiativeFixture),
      ok(onlyTasks),
      ok({ issues: [] }),
    ]).promise;
    expect(fallback.epics.map((e) => e.key)).toEqual(["ACME-99"]);
  });

  it("follows nextPageToken until the pages run out", async () => {
    const { promise, calls } = run(happyScript());
    const snap = await promise;

    expect(jqlOf(calls[4])).toBe(
      'parent in (ACME-10, ACME-11) OR "Epic Link" in (ACME-10, ACME-11)',
    );
    expect((calls[4].body as { nextPageToken?: string }).nextPageToken).toBe(
      undefined,
    );
    expect((calls[4].body as { maxResults: number }).maxResults).toBe(100);
    expect((calls[5].body as { nextPageToken?: string }).nextPageToken).toBe(
      childrenPage1.nextPageToken,
    );
    // One child from page 1 and one from page 2.
    expect(snap.epics[0].children.map((c) => c.key)).toContain("ACME-100");
    expect(snap.epics[1].children.map((c) => c.key)).toEqual(["ACME-103"]);
  });

  it("asks for children fifty epics at a time", async () => {
    const many = {
      issues: Array.from({ length: 60 }, (_, i) => ({
        key: `ACME-${200 + i}`,
        fields: {
          summary: `Epic ${i}`,
          issuetype: { name: "Epic" },
          status: { statusCategory: { key: "new" } },
          updated: NOW,
        },
      })),
    };
    const { promise, calls } = run([
      ok(fieldList),
      ok(initiativeFixture),
      ok(many),
      ok({ issues: [] }),
      ok({ issues: [] }),
    ]);
    const snap = await promise;

    expect(snap.epics).toHaveLength(60);
    expect(jqlOf(calls[3]).match(/ACME-\d+/g)).toHaveLength(100); // 50 x 2 lists
    expect(jqlOf(calls[4]).match(/ACME-\d+/g)).toHaveLength(20); // 10 x 2 lists
  });

  it("retries once after a 429, waiting out Retry-After", async () => {
    const slept: number[] = [];
    const script = happyScript();
    script.unshift({
      status: 429,
      body: { errorMessages: ["Too many requests"] },
      headers: { "retry-after": "2" },
    });
    const { promise, calls } = run(script, {
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    const snap = await promise;

    expect(slept).toEqual([2000]);
    expect(calls).toHaveLength(7);
    expect(calls[0].path).toBe("/rest/api/3/field");
    expect(calls[1].path).toBe("/rest/api/3/field");
    expect(snap.epics).toHaveLength(2);
  });

  it("waits a default beat when 429 carries no usable Retry-After", async () => {
    const slept: number[] = [];
    const script = happyScript();
    script.unshift({ status: 429, body: null });
    await run(script, {
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    }).promise;
    expect(slept).toEqual([1000]);
  });

  it("caps an absurd Retry-After", async () => {
    const slept: number[] = [];
    const { transport } = scripted([
      { status: 429, body: null, headers: { "retry-after": "86400" } },
      ...happyScript(),
    ]);
    await fetchInitiativeSnapshot(transport, {
      baseUrl: BASE_URL,
      auth: AUTH,
      key: "ACME-1",
      now: NOW,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([30_000]);
  });

  it("reports rate-limited when the retry is refused too", async () => {
    const err = await run([
      { status: 429, body: null, headers: { "retry-after": "1" } },
      { status: 429, body: null, headers: { "retry-after": "1" } },
    ]).promise.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).kind).toBe("rate-limited");
    expect((err as JiraError).status).toBe(429);
  });

  it("reports an auth failure without ever echoing the credentials", async () => {
    const err = await run([
      {
        status: 401,
        body: { errorMessages: ["Client must be authenticated."] },
      },
    ]).promise.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).kind).toBe("auth");
    expect((err as JiraError).status).toBe(401);
    const text = `${(err as JiraError).message}${(err as JiraError).stack}`;
    expect(text).not.toContain(AUTH);
    expect(text).not.toContain("super-secret-token");
  });

  it("treats 403 as an auth failure too", async () => {
    const err = await run([{ status: 403, body: null }]).promise.catch(
      (e: unknown) => e,
    );
    expect((err as JiraError).kind).toBe("auth");
    expect((err as JiraError).requestPath).toBe("/rest/api/3/field");
  });

  it("reports a missing initiative as not-found", async () => {
    const err = await run([
      ok(fieldList),
      { status: 404, body: { errorMessages: ["Issue does not exist"] } },
    ]).promise.catch((e: unknown) => e);

    expect((err as JiraError).kind).toBe("not-found");
    expect((err as JiraError).message).toContain("Issue does not exist");
  });

  it("reports a 5xx as unavailable and a throwing transport as network", async () => {
    const down = await run([{ status: 503, body: null }]).promise.catch(
      (e: unknown) => e,
    );
    expect((down as JiraError).kind).toBe("unavailable");

    const offline = await run([
      new Error(`fetch failed for ${AUTH}`),
    ]).promise.catch((e: unknown) => e);
    expect((offline as JiraError).kind).toBe("network");
    expect((offline as JiraError).message).not.toContain(AUTH);
    expect((offline as JiraError).message).toContain("[redacted]");
  });

  it("refuses a key that is not a key before making any request", async () => {
    const { transport, calls } = scripted([]);
    const err = await fetchInitiativeSnapshot(transport, {
      baseUrl: BASE_URL,
      auth: AUTH,
      key: 'ACME-1") OR project = "SECRET',
      now: NOW,
    }).catch((e: unknown) => e);

    expect((err as JiraError).kind).toBe("bad-response");
    expect(calls).toHaveLength(0);
  });

  it("rejects a search body that is not a search result", async () => {
    const err = await run([
      ok(fieldList),
      ok(initiativeFixture),
      ok("<html>login</html>"),
    ]).promise.catch((e: unknown) => e);

    expect((err as JiraError).kind).toBe("bad-response");
  });

  it("returns an empty snapshot when the initiative has no epics", async () => {
    const snap = await run([
      ok(fieldList),
      ok(initiativeFixture),
      ok(epicsEmpty),
      ok(epicsEmpty),
      ok(epicsEmpty),
    ]).promise;

    expect(snap.epics).toEqual([]);
    expect(snap.initiative.summary).toBe("Checkout modernisation");
  });

  it("surfaces the rejection when every hierarchy query is refused", async () => {
    const rejected = { status: 400, body: { errorMessages: ["nope"] } };
    const err = await run([
      ok(fieldList),
      ok(initiativeFixture),
      rejected,
      rejected,
      rejected,
    ]).promise.catch((e: unknown) => e);

    expect((err as JiraError).kind).toBe("bad-response");
  });
});
