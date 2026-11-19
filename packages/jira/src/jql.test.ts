import { describe, it, expect } from "vitest";
import {
  BASE_ISSUE_FIELDS,
  epicChildrenJql,
  initiativeEpicsJqlCandidates,
  issueFieldList,
} from "./jql";

describe("initiativeEpicsJqlCandidates", () => {
  it("offers the three hierarchy shapes in order", () => {
    expect(initiativeEpicsJqlCandidates("ACME-1")).toEqual([
      "parent = ACME-1",
      '"Parent Link" = ACME-1',
      'issue in linkedIssues("ACME-1", "initiates")',
    ]);
  });

  it("refuses anything that is not an issue key", () => {
    for (const bad of ['ACME-1") OR project = "SECRET', "ACME-1 OR 1=1", ""]) {
      expect(() => initiativeEpicsJqlCandidates(bad)).toThrow(RangeError);
    }
  });
});

describe("epicChildrenJql", () => {
  it("asks for both parent and Epic Link in one query", () => {
    expect(epicChildrenJql(["ACME-10", "ACME-11"])).toBe(
      'parent in (ACME-10, ACME-11) OR "Epic Link" in (ACME-10, ACME-11)',
    );
  });

  it("refuses an empty list or an injected key", () => {
    expect(() => epicChildrenJql([])).toThrow(RangeError);
    expect(() => epicChildrenJql(["ACME-10", "x) OR (1=1"])).toThrow(
      RangeError,
    );
  });
});

describe("issueFieldList", () => {
  it("appends the resolved custom ids to the fixed list", () => {
    expect(
      issueFieldList({
        startDate: "customfield_10015",
        sprint: "customfield_10020",
        storyPoints: "customfield_10041",
      }),
    ).toEqual([
      ...BASE_ISSUE_FIELDS,
      "customfield_10015",
      "customfield_10020",
      "customfield_10041",
    ]);
  });

  it("skips absent ids and never repeats one", () => {
    expect(issueFieldList({ startDate: "duedate", sprint: "duedate" })).toEqual(
      [...BASE_ISSUE_FIELDS],
    );
  });
});
