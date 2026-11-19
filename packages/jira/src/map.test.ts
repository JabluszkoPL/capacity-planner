import { describe, it, expect } from "vitest";
import type { JiraFieldIds } from "@planner/core";
import childrenPage1 from "./__fixtures__/children-page1.json";
import childrenPage2 from "./__fixtures__/children-page2.json";
import epicsFixture from "./__fixtures__/epics.json";
import initiativeFixture from "./__fixtures__/initiative.json";
import {
  buildSnapshot,
  daysToJiraDuration,
  mapIssue,
  secondsToDays,
} from "./map";

const FIELD_IDS: JiraFieldIds = {
  startDate: "customfield_10015",
  sprint: "customfield_10020",
  storyPoints: "customfield_10041",
};

const FETCHED_AT = "2026-09-15T08:00:00.000Z";
const CHILDREN = [...childrenPage1.issues, ...childrenPage2.issues];

function snapshot() {
  return buildSnapshot(
    initiativeFixture,
    epicsFixture.issues,
    CHILDREN,
    FIELD_IDS,
    FETCHED_AT,
  );
}

describe("mapIssue", () => {
  it("flattens the fields tracking uses", () => {
    expect(mapIssue(childrenPage1.issues[0], FIELD_IDS)).toEqual({
      key: "ACME-100",
      summary: "Tokenise stored cards",
      issueType: "Story",
      status: "Done",
      statusCategory: "done",
      assignee: {
        accountId: "5f00aa11bb22cc33dd44ee56",
        displayName: "Ines Moreau",
      },
      parentKey: "ACME-10",
      originalEstimateSec: 28800,
      remainingEstimateSec: 14400,
      timeSpentSec: 28800,
      startDate: "2026-07-13",
      dueDate: "2026-07-17",
      resolutionDate: "2026-07-16T15:41:09.000+0200",
      sprint: "Checkout Sprint 4",
      updated: "2026-07-16T15:41:09.000+0200",
    });
  });

  it("reads the issue's Jira team by name", () => {
    const withTeam = { ...FIELD_IDS, team: "customfield_10001" };
    const raw = (team: unknown) => ({
      key: "ACME-1",
      fields: {
        summary: "x",
        status: { name: "To Do" },
        customfield_10001: team,
      },
    });
    // Atlassian's Team field is an object; a text team field is a string.
    expect(
      mapIssue(raw({ id: "90e3", name: "Stars", title: "Stars" }), withTeam)
        .team,
    ).toBe("Stars");
    expect(mapIssue(raw(" Bulls "), withTeam).team).toBe("Bulls");
    expect(mapIssue(raw(null), withTeam).team).toBeUndefined();
    expect(mapIssue(raw("Stars"), FIELD_IDS).team).toBeUndefined();
  });

  it("maps the three status categories and defaults the unknown ones", () => {
    const category = (key: unknown) =>
      mapIssue({ fields: { status: { statusCategory: { key } } } }, FIELD_IDS)
        .statusCategory;
    expect(category("new")).toBe("new");
    expect(category("indeterminate")).toBe("indeterminate");
    expect(category("done")).toBe("done");
    expect(category("undefined")).toBe("new");
    expect(category("something-new-from-atlassian")).toBe("new");
    expect(category(null)).toBe("new");
    expect(mapIssue({ fields: {} }, FIELD_IDS).statusCategory).toBe("new");
  });

  it("names the active sprint, else the last one the issue was in", () => {
    expect(mapIssue(childrenPage1.issues[1], FIELD_IDS).sprint).toBe(
      "Checkout Sprint 5",
    );
    const legacy = {
      fields: {
        customfield_10020: [
          "com.atlassian.greenhopper.service.sprint.Sprint@1[id=9,state=CLOSED,name=Old Sprint]",
        ],
      },
    };
    expect(mapIssue(legacy, FIELD_IDS).sprint).toBe("Old Sprint");
  });

  it("keeps labels, dropping blanks, and omits an empty list", () => {
    const labelled = { fields: { labels: ["backend", "", 7, "QA"] } };
    expect(mapIssue(labelled, FIELD_IDS).labels).toEqual(["backend", "QA"]);
    expect(mapIssue({ fields: { labels: [] } }, FIELD_IDS).labels).toBe(
      undefined,
    );
    expect(mapIssue({ fields: { labels: "x" } }, FIELD_IDS).labels).toBe(
      undefined,
    );
  });

  it("returns a usable issue for junk input instead of throwing", () => {
    for (const junk of [null, undefined, 7, "nope", [], { fields: 3 }]) {
      const issue = mapIssue(junk, FIELD_IDS);
      expect(issue.key).toBe("");
      expect(issue.statusCategory).toBe("new");
      expect(issue.updated).toBe("");
      expect(issue.assignee).toBeUndefined();
      expect(issue.originalEstimateSec).toBeUndefined();
    }
  });

  it("omits fields Jira nulled out rather than inventing zeroes", () => {
    const issue = mapIssue(epicsFixture.issues[1], FIELD_IDS);
    expect(issue.originalEstimateSec).toBeUndefined();
    expect(issue.remainingEstimateSec).toBeUndefined();
    expect(issue.timeSpentSec).toBeUndefined();
    expect(issue.dueDate).toBeUndefined();
    expect(issue.assignee).toBeUndefined();
    expect(issue.startDate).toBeUndefined();
  });

  it("reads no custom field when the site has no id for it", () => {
    const issue = mapIssue(childrenPage1.issues[0], {});
    expect(issue.startDate).toBeUndefined();
    expect(issue.sprint).toBeUndefined();
  });
});

describe("buildSnapshot", () => {
  it("keeps the initiative, the epics and the fetch stamp", () => {
    const snap = snapshot();
    expect(snap.fetchedAt).toBe(FETCHED_AT);
    expect(snap.fieldIds).toEqual(FIELD_IDS);
    expect(snap.initiative.key).toBe("ACME-1");
    expect(snap.initiative.startDate).toBe("2026-06-01");
    expect(snap.epics.map((e) => e.key)).toEqual([
      "ACME-10",
      "ACME-11",
      "ACME-99",
    ]);
  });

  it("groups children by parent, and by Epic Link when parent is absent", () => {
    const snap = snapshot();
    expect(snap.epics[0].children.map((c) => c.key)).toEqual([
      "ACME-100",
      "ACME-101",
      "ACME-102",
    ]);
    expect(snap.epics[1].children.map((c) => c.key)).toEqual(["ACME-103"]);
    expect(snap.epics[2].children).toEqual([]);
  });

  it("drops a child whose epic is not part of this initiative", () => {
    const keys = snapshot().epics.flatMap((e) => e.children.map((c) => c.key));
    expect(keys).not.toContain("ACME-104");
  });

  it("totals the children and ignores a done child's remaining estimate", () => {
    // ACME-100 is done with a stale 4h remaining; it contributes 0.
    expect(snapshot().epics[0].totals).toEqual({
      originalSec: 100800,
      spentSec: 57600,
      remainingSec: 43200,
      done: 1,
      all: 3,
    });
  });

  it("falls back to the original estimate when remaining is absent", () => {
    expect(snapshot().epics[1].totals).toEqual({
      originalSec: 86400,
      spentSec: 0,
      remainingSec: 86400,
      done: 0,
      all: 1,
    });
  });

  it("never reads Jira's own aggregate numbers off the epic", () => {
    // ACME-10 carries a 288000s estimate of its own; the totals ignore it.
    expect(snapshot().epics[0].totals.originalSec).toBe(100800);
  });

  it("zeroes the totals of an epic with no children", () => {
    expect(snapshot().epics[2].totals).toEqual({
      originalSec: 0,
      spentSec: 0,
      remainingSec: 0,
      done: 0,
      all: 0,
    });
  });

  it("ignores a child repeated across overlapping pages", () => {
    const snap = buildSnapshot(
      initiativeFixture,
      epicsFixture.issues,
      [...CHILDREN, childrenPage1.issues[0]],
      FIELD_IDS,
      FETCHED_AT,
    );
    expect(snap.epics[0].totals.all).toBe(3);
  });

  it("builds an empty but valid snapshot from nothing", () => {
    const snap = buildSnapshot(null, [], [], {}, FETCHED_AT);
    expect(snap.epics).toEqual([]);
    expect(snap.initiative.key).toBe("");
  });
});

describe("unit conversion", () => {
  it("converts seconds to days at the configured day length", () => {
    expect(secondsToDays(28800, 8)).toBe(1);
    expect(secondsToDays(43200, 8)).toBe(1.5);
    expect(secondsToDays(27000, 7.5)).toBe(1);
    expect(secondsToDays(0, 8)).toBe(0);
  });

  it("defaults to an eight-hour day and survives junk", () => {
    expect(secondsToDays(28800)).toBe(1);
    expect(secondsToDays(28800, 0)).toBe(1);
    expect(secondsToDays(28800, Number.NaN)).toBe(1);
    expect(secondsToDays(Number.NaN, 8)).toBe(0);
  });

  it("writes days back as a Jira duration", () => {
    expect(daysToJiraDuration(2.5, 8)).toBe("2d 4h");
    expect(daysToJiraDuration(0.75, 8)).toBe("6h");
    expect(daysToJiraDuration(3, 8)).toBe("3d");
    expect(daysToJiraDuration(1, 7.5)).toBe("1d");
    expect(daysToJiraDuration(0.1, 8)).toBe("48m");
    expect(daysToJiraDuration(1.0625, 8)).toBe("1d 30m");
  });

  it("never emits a negative or empty duration", () => {
    expect(daysToJiraDuration(0, 8)).toBe("0h");
    expect(daysToJiraDuration(-3, 8)).toBe("0h");
    expect(daysToJiraDuration(Number.NaN, 8)).toBe("0h");
  });

  it("round-trips a whole day at the same day length", () => {
    expect(daysToJiraDuration(secondsToDays(43200, 8), 8)).toBe("1d 4h");
  });
});
