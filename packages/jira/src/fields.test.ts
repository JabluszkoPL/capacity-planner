import { describe, it, expect } from "vitest";
import fieldList from "./__fixtures__/field-list.json";
import { FALLBACK_FIELD_IDS, resolveFieldIds } from "./fields";

describe("resolveFieldIds", () => {
  it("resolves ids by name from a real field list", () => {
    expect(resolveFieldIds(fieldList)).toEqual({
      startDate: "customfield_10015",
      sprint: "customfield_10020",
      storyPoints: "customfield_10041",
      // Not in this field list: Atlassian's own id.
      team: "customfield_10001",
    });
  });

  it("matches names case- and whitespace-insensitively", () => {
    expect(
      resolveFieldIds([
        { id: "customfield_20001", name: "  START   Date ", custom: true },
      ]).startDate,
    ).toBe("customfield_20001");
  });

  it("finds the Team field by name, not Tempo's", () => {
    expect(
      resolveFieldIds([
        { id: "customfield_10405", name: "Tempo Team", custom: true },
        { id: "customfield_30001", name: "Team", custom: true },
      ]).team,
    ).toBe("customfield_30001");
  });

  it("accepts either name for story points", () => {
    expect(
      resolveFieldIds([
        { id: "customfield_20002", name: "Story point estimate" },
      ]).storyPoints,
    ).toBe("customfield_20002");
  });

  it("prefers a custom field over a system field of the same name", () => {
    expect(
      resolveFieldIds([
        { id: "startdate", name: "Start date", custom: false },
        { id: "customfield_20003", name: "Start date", custom: true },
      ]).startDate,
    ).toBe("customfield_20003");
  });

  it("falls back to the known ids when nothing matches", () => {
    expect(resolveFieldIds([{ id: "summary", name: "Summary" }])).toEqual(
      FALLBACK_FIELD_IDS,
    );
  });

  it("survives junk instead of a field list", () => {
    for (const junk of [null, undefined, 7, "nope", {}, [null, 1, { id: 2 }]]) {
      expect(resolveFieldIds(junk)).toEqual(FALLBACK_FIELD_IDS);
    }
  });
});
