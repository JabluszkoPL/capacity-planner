import { describe, it, expect } from "vitest";
import { parseImport, NEW_EPIC } from "./parseImport";

const existing = [{ id: "e1", name: "Onboarding" }];

describe("parseImport — 4-column rows", () => {
  it("creates a new epic and reuses an existing one by case-insensitive name", () => {
    const text = [
      "onboarding\tSet up SSO\t3\tBackend", // matches existing "Onboarding"
      "Payments\tCheckout UI\t4\tFrontend", // new epic
      "PAYMENTS\tRefunds\t2\tBackend", // same new epic, different case
    ].join("\n");

    const result = parseImport(text, existing, NEW_EPIC);
    expect(result.importedCount).toBe(3);
    expect(result.groups).toHaveLength(2);

    // First group → existing epic e1.
    expect(result.groups[0].existingEpicId).toBe("e1");
    expect(result.groups[0].newEpicName).toBeNull();
    expect(result.groups[0].tasks).toEqual([
      {
        name: "Set up SSO",
        estimateDays: 3,
        specialization: "Backend",
        dependsOn: [],
      },
    ]);

    // Second group → new "Payments" epic with both rows collapsed in.
    expect(result.groups[1].existingEpicId).toBeNull();
    expect(result.groups[1].newEpicName).toBe("Payments");
    expect(result.groups[1].tasks.map((t) => t.name)).toEqual([
      "Checkout UI",
      "Refunds",
    ]);
  });
});

describe("parseImport — 3-column rows", () => {
  it("lands in the selected target epic", () => {
    const text = "Write docs\t1\tTech Writing";
    const result = parseImport(text, existing, "e1");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].existingEpicId).toBe("e1");
    expect(result.groups[0].tasks[0]).toEqual({
      name: "Write docs",
      estimateDays: 1,
      specialization: "Tech Writing",
      dependsOn: [],
    });
  });

  it("falls back to a new 'Imported' epic when target is NEW_EPIC", () => {
    const text = "Loose task\t2\tQA";
    const result = parseImport(text, existing, NEW_EPIC);
    expect(result.groups[0].existingEpicId).toBeNull();
    expect(result.groups[0].newEpicName).toBe("Imported");
  });

  it("reuses an existing 'Imported' epic instead of creating another", () => {
    const withImported = [...existing, { id: "e9", name: "Imported" }];
    const result = parseImport("Loose task\t2\tQA", withImported, NEW_EPIC);
    expect(result.groups[0].existingEpicId).toBe("e9");
    expect(result.groups[0].newEpicName).toBeNull();
  });
});

describe("parseImport — dependencies", () => {
  it("captures task dependencies from the 5th column, split on ; or |", () => {
    const text = [
      "Payments\tCheckout UI\t4\tFrontend",
      "Payments\tRefunds\t2\tBackend\tCheckout UI",
      "Payments\tReporting\t3\tBackend\tCheckout UI; Refunds | Missing",
    ].join("\n");
    const result = parseImport(text, existing, NEW_EPIC);
    const tasks = result.groups[0].tasks;
    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[1].dependsOn).toEqual(["Checkout UI"]);
    expect(tasks[2].dependsOn).toEqual(["Checkout UI", "Refunds", "Missing"]);
  });

  it("captures and unions epic dependencies from the 6th column", () => {
    const text = [
      "Payments\tCheckout UI\t4\tFrontend\t\tOnboarding",
      "Payments\tRefunds\t2\tBackend\t\tOnboarding | Platform",
    ].join("\n");
    const result = parseImport(text, existing, NEW_EPIC);
    expect(result.groups[0].epicDependsOn).toEqual(["Onboarding", "Platform"]);
  });

  it("leaves dependency lists empty for 3-column rows", () => {
    const result = parseImport("Loose task\t2\tQA", existing, "e1");
    expect(result.groups[0].tasks[0].dependsOn).toEqual([]);
    expect(result.groups[0].epicDependsOn).toEqual([]);
  });
});

describe("parseImport — parsing robustness", () => {
  it("uses comma separation when there is no tab", () => {
    const result = parseImport(
      "Payments,Checkout,4,Frontend",
      existing,
      NEW_EPIC,
    );
    expect(result.importedCount).toBe(1);
    expect(result.groups[0].newEpicName).toBe("Payments");
    expect(result.groups[0].tasks[0]).toEqual({
      name: "Checkout",
      estimateDays: 4,
      specialization: "Frontend",
      dependsOn: [],
    });
  });

  it("skips a header row", () => {
    const text = [
      "Epic\tTask\tEstimate\tSpecialization",
      "Onboarding\tReal task\t2\tBackend",
    ].join("\n");
    const result = parseImport(text, existing, NEW_EPIC);
    expect(result.importedCount).toBe(1);
    expect(result.groups[0].tasks[0].name).toBe("Real task");
  });

  it("skips a 3-column header row", () => {
    const text = ["Task\tEstimate\tSpec", "Real task\t2\tBackend"].join("\n");
    const result = parseImport(text, existing, "e1");
    expect(result.importedCount).toBe(1);
    expect(result.groups[0].tasks[0].name).toBe("Real task");
  });

  it("ignores malformed and empty lines rather than crashing", () => {
    const text = [
      "",
      "  ",
      "just-one-column",
      "two\tcols",
      "Onboarding\tGood task\t3\tBackend",
    ].join("\n");
    const result = parseImport(text, existing, NEW_EPIC);
    expect(result.importedCount).toBe(1);
    expect(result.groups[0].tasks[0].name).toBe("Good task");
  });

  it("parses decimal estimates (comma or dot) and defaults non-numeric to 0", () => {
    const text = [
      "Onboarding\tHalf day\t0,5\tQA",
      "Onboarding\tNo estimate\tTBD\tQA",
    ].join("\n");
    const result = parseImport(text, existing, NEW_EPIC);
    expect(result.groups[0].tasks[0].estimateDays).toBe(0.5);
    expect(result.groups[0].tasks[1].estimateDays).toBe(0);
  });

  it("skips a 3-column row whose target epic no longer exists", () => {
    const result = parseImport("Orphan\t1\tQA", existing, "missing-id");
    expect(result.importedCount).toBe(0);
    expect(result.groups).toHaveLength(0);
  });
});
