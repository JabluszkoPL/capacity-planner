import { describe, it, expect } from "vitest";
import type { JiraFieldIds, SprintDraftItem } from "@planner/core";
import childrenPage1 from "./__fixtures__/children-page1.json";
import childrenPage2 from "./__fixtures__/children-page2.json";
import epicsFixture from "./__fixtures__/epics.json";
import initiativeFixture from "./__fixtures__/initiative.json";
import { buildSnapshot } from "./map";
import { JiraError } from "./refresh";
import type { JiraRequest, JiraResponse, JiraTransport } from "./transport";
import { basicAuth } from "./transport";
import {
  DEFAULT_START_DATE_FIELD_ID,
  applyDates,
  buildDatePayload,
  dateChanges,
  type DateChange,
  type WriteSpan,
} from "./writeback";

const BASE_URL = "https://acme.atlassian.net";
const AUTH = basicAuth("dana@example.com", "super-secret-token");
const NOW = "2026-09-15T08:00:00.000Z";

const FIELD_IDS: JiraFieldIds = {
  startDate: "customfield_10015",
  sprint: "customfield_10020",
  storyPoints: "customfield_10041",
};

/** The same initiative the refresh tests read, assembled once. */
const SNAPSHOT = buildSnapshot(
  initiativeFixture,
  epicsFixture.issues,
  [...childrenPage1.issues, ...childrenPage2.issues],
  FIELD_IDS,
  NOW,
);

type Scripted = JiraResponse | Error;

/** 204 No Content — what Jira actually answers a successful issue edit with. */
const noContent: JiraResponse = { status: 204, body: null };

/**
 * A transport that replays a script and records every request, so a test can
 * assert the conversation and not only the answer. `canWrite` is part of the
 * fake because refusing to write is itself behaviour under test.
 */
function scripted(script: Scripted[], canWrite = true) {
  const calls: JiraRequest[] = [];
  const queue = [...script];
  const transport: JiraTransport = {
    canWrite,
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

function item(issueKey: string): SprintDraftItem {
  return { issueKey, estimateDays: 2, start: "2026-09-22" };
}

function span(start: string, end: string): WriteSpan {
  return { start, end };
}

function change(
  issueKey: string,
  nextStart: string,
  nextDue: string,
): DateChange {
  return { issueKey, summary: issueKey, nextStart, nextDue };
}

describe("buildDatePayload", () => {
  it("writes the discovered start-date field and the system due date", () => {
    expect(
      buildDatePayload("ACME-101", span("2026-09-22", "2026-09-24"), FIELD_IDS),
    ).toEqual({
      fields: {
        customfield_10015: "2026-09-22",
        duedate: "2026-09-24",
      },
    });
  });

  it("falls back to Jira's usual start-date id when none was discovered", () => {
    const payload = buildDatePayload(
      "ACME-101",
      span("2026-09-22", "2026-09-24"),
      {},
    );
    expect(payload.fields[DEFAULT_START_DATE_FIELD_ID]).toBe("2026-09-22");
    expect(Object.keys(payload.fields).sort()).toEqual([
      "customfield_10015",
      "duedate",
    ]);
  });

  it("sets dates and nothing else", () => {
    const payload = buildDatePayload(
      "ACME-101",
      span("2026-09-22", "2026-09-24"),
      FIELD_IDS,
    );
    const body = JSON.stringify(payload);
    expect(body).not.toContain("assignee");
    expect(body).not.toContain("timeestimate");
    expect(body).not.toContain("timetracking");
    expect(body).not.toContain(FIELD_IDS.storyPoints);
  });

  it("refuses a key that is not a key, before it reaches a URL", () => {
    expect(() =>
      buildDatePayload(
        "ACME-1/../../secret",
        span("2026-09-22", "2026-09-24"),
        FIELD_IDS,
      ),
    ).toThrow(JiraError);
  });
});

describe("dateChanges", () => {
  it("lists the current and proposed dates of each moved issue", () => {
    const changes = dateChanges(
      [item("ACME-101")],
      new Map([["ACME-101", span("2026-09-22", "2026-09-24")]]),
      SNAPSHOT,
    );
    expect(changes).toEqual([
      {
        issueKey: "ACME-101",
        summary: "Refund flow against the new provider",
        currentStart: undefined,
        currentDue: undefined,
        nextStart: "2026-09-22",
        nextDue: "2026-09-24",
      },
    ]);
  });

  it("excludes issues whose Jira dates already match", () => {
    // ACME-100 is already 2026-07-13 → 2026-07-17 in the fixture.
    const changes = dateChanges(
      [item("ACME-100"), item("ACME-102")],
      new Map([
        ["ACME-100", span("2026-07-13", "2026-07-17")],
        ["ACME-102", span("2026-09-22", "2026-09-23")],
      ]),
      SNAPSHOT,
    );
    expect(changes.map((c) => c.issueKey)).toEqual(["ACME-102"]);
  });

  it("keeps an issue when only one of the two dates differs", () => {
    const changes = dateChanges(
      [item("ACME-100")],
      new Map([["ACME-100", span("2026-07-13", "2026-07-20")]]),
      SNAPSHOT,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].currentStart).toBe("2026-07-13");
    expect(changes[0].currentDue).toBe("2026-07-17");
  });

  it("skips an item the draft could not schedule", () => {
    expect(dateChanges([item("ACME-101")], new Map(), SNAPSHOT)).toEqual([]);
  });

  it("names an issue the snapshot never saw by its key", () => {
    const changes = dateChanges(
      [item("ACME-900")],
      new Map([["ACME-900", span("2026-09-22", "2026-09-24")]]),
      SNAPSHOT,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].summary).toBe("ACME-900");
    expect(changes[0].currentStart).toBeUndefined();
  });
});

describe("applyDates", () => {
  it("PUTs one issue at a time and reports each one", async () => {
    const { transport, calls } = scripted([noContent, noContent]);
    const results = await applyDates(transport, {
      baseUrl: BASE_URL,
      auth: AUTH,
      fieldIds: FIELD_IDS,
      changes: [
        change("ACME-101", "2026-09-22", "2026-09-24"),
        change("ACME-102", "2026-09-25", "2026-09-28"),
      ],
    });

    expect(results).toEqual([
      { issueKey: "ACME-101", ok: true },
      { issueKey: "ACME-102", ok: true },
    ]);
    expect(calls.map((c) => c.path)).toEqual([
      "/rest/api/3/issue/ACME-101",
      "/rest/api/3/issue/ACME-102",
    ]);
    expect(calls.every((c) => c.method === "PUT")).toBe(true);
    expect(calls[0].body).toEqual({
      fields: { customfield_10015: "2026-09-22", duedate: "2026-09-24" },
    });
    expect(calls.every((c) => c.baseUrl === BASE_URL && c.auth === AUTH)).toBe(
      true,
    );
  });

  it("keeps going when one issue is refused", async () => {
    const { transport, calls } = scripted([
      noContent,
      {
        status: 403,
        body: { errorMessages: ["You do not have permission to edit issues."] },
      },
      noContent,
    ]);
    const results = await applyDates(transport, {
      baseUrl: BASE_URL,
      auth: AUTH,
      fieldIds: FIELD_IDS,
      changes: [
        change("ACME-101", "2026-09-22", "2026-09-24"),
        change("ACME-102", "2026-09-22", "2026-09-24"),
        change("ACME-103", "2026-09-22", "2026-09-24"),
      ],
    });

    expect(calls).toHaveLength(3);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1].error).toContain("403");
    expect(results[1].error).toContain("permission");
  });

  it("explains a rejected field by name", async () => {
    const { transport } = scripted([
      {
        status: 400,
        body: {
          errors: {
            customfield_10015: "Field 'customfield_10015' cannot be set.",
          },
        },
      },
    ]);
    const [result] = await applyDates(transport, {
      baseUrl: BASE_URL,
      auth: AUTH,
      fieldIds: FIELD_IDS,
      changes: [change("ACME-101", "2026-09-22", "2026-09-24")],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("customfield_10015");
  });

  it("reports a transport failure per issue rather than abandoning the run", async () => {
    const { transport } = scripted([new Error("socket hang up"), noContent]);
    const results = await applyDates(transport, {
      baseUrl: BASE_URL,
      auth: AUTH,
      fieldIds: FIELD_IDS,
      changes: [
        change("ACME-101", "2026-09-22", "2026-09-24"),
        change("ACME-102", "2026-09-22", "2026-09-24"),
      ],
    });
    expect(results[0]).toEqual({
      issueKey: "ACME-101",
      ok: false,
      error: "Could not reach Jira: socket hang up",
    });
    expect(results[1].ok).toBe(true);
  });

  it("refuses a read-only transport before sending anything", async () => {
    const { transport, calls } = scripted([noContent], false);
    const err = await applyDates(transport, {
      baseUrl: BASE_URL,
      auth: AUTH,
      fieldIds: FIELD_IDS,
      changes: [change("ACME-101", "2026-09-22", "2026-09-24")],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JiraError);
    expect(calls).toHaveLength(0);
  });

  it("never echoes the credentials in a result", async () => {
    const { transport } = scripted([
      { status: 401, body: { errorMessages: [`bad header ${AUTH}`] } },
      new Error(`fetch failed for ${AUTH}`),
    ]);
    const results = await applyDates(transport, {
      baseUrl: BASE_URL,
      auth: AUTH,
      fieldIds: FIELD_IDS,
      changes: [
        change("ACME-101", "2026-09-22", "2026-09-24"),
        change("ACME-102", "2026-09-22", "2026-09-24"),
      ],
    });

    const text = results.map((r) => r.error ?? "").join(" ");
    expect(text).not.toContain(AUTH);
    expect(text).not.toContain("super-secret-token");
    expect(text).toContain("[redacted]");
  });
});
