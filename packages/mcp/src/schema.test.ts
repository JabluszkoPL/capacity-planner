import { describe, expect, it } from "vitest";
import { checkArgs, isIsoDate, type ObjectSchema } from "./schema";
import { TOOL_DEFINITIONS } from "./catalog";

const schema: ObjectSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    when: { type: "string", format: "date" },
    days: {
      type: "array",
      items: { type: "string", format: "date-or-range" },
      maxItems: 2,
    },
    speed: { type: "number", minimum: 0.1, maximum: 2 },
    n: { type: "integer" },
    mode: { type: "string", enum: ["a", "b"] },
    on: { type: "boolean" },
  },
  required: ["name"],
  additionalProperties: false,
};

describe("checkArgs", () => {
  it("accepts arguments that fit", () => {
    expect(
      checkArgs(schema, {
        name: "x",
        when: "2026-02-28",
        days: ["2026-12-24", "2026-12-28..2026-12-31"],
        speed: 1.5,
        n: 3,
        mode: "b",
        on: false,
      }),
    ).toBeNull();
  });

  it("says what is wrong, naming the argument", () => {
    expect(checkArgs(schema, {})).toBe("arguments.name is required.");
    expect(checkArgs(schema, { name: "  " })).toBe(
      "arguments.name must not be empty.",
    );
    expect(checkArgs(schema, { name: "x", when: "2026-02-30" })).toContain(
      "YYYY-MM-DD",
    );
    expect(
      checkArgs(schema, { name: "x", days: ["2026-12-31..2026-12-01"] }),
    ).toContain("arguments.days[0]");
    expect(checkArgs(schema, { name: "x", days: ["a", "b", "c"] })).toContain(
      "at most 2",
    );
    expect(checkArgs(schema, { name: "x", speed: 3 })).toContain("at most 2");
    expect(checkArgs(schema, { name: "x", n: 1.5 })).toContain("whole number");
    expect(checkArgs(schema, { name: "x", mode: "c" })).toContain(
      "one of: a, b",
    );
    expect(checkArgs(schema, { name: "x", on: "yes" })).toContain(
      "true or false",
    );
    expect(checkArgs(schema, { name: "x", extra: 1 })).toContain(
      "arguments.extra is not a known argument",
    );
  });

  it("knows real dates from look-alikes", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-1-5")).toBe(false);
  });
});

describe("the catalogue", () => {
  it("gives every tool a unique name and a closed object schema", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const req of t.inputSchema.required ?? []) {
        expect(t.inputSchema.properties).toHaveProperty(req);
      }
      expect(t.annotations.readOnlyHint).toBe(t.access === "read");
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("offers nothing that deletes", () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.name).not.toMatch(/delete|remove/);
      expect(t.annotations.destructiveHint ?? false).toBe(false);
    }
  });
});
