// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { TAG_ALIASES_KEY, readTagAliases, writeTagAliases } from "./tagAliases";

describe("tag aliases storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips complete rows and drops blank ones", () => {
    writeTagAliases([
      { tag: " tools ", specialization: "Tools" },
      { tag: "", specialization: "Backend" },
      { tag: "java", specialization: " " },
    ]);
    expect(readTagAliases()).toEqual([
      { tag: "tools", specialization: "Tools" },
    ]);
  });

  it("reads junk as nothing", () => {
    expect(readTagAliases()).toEqual([]);
    localStorage.setItem(TAG_ALIASES_KEY, "{not json");
    expect(readTagAliases()).toEqual([]);
    localStorage.setItem(TAG_ALIASES_KEY, JSON.stringify([7, { tag: 1 }]));
    expect(readTagAliases()).toEqual([]);
  });
});
