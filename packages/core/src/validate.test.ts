import { describe, it, expect } from "vitest";
import type { AppState } from "./types";
import { isValidAppState, migrateState } from "./validate";

function base(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P1",
        startDate: "2026-01-01",
        plan: null,
        planViewMode: "person",
        epics: [],
      },
    ],
    teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
  };
}

describe("isValidAppState", () => {
  it("accepts a well-formed state", () => {
    expect(isValidAppState(base())).toBe(true);
  });
  it("accepts absent, empty and well-formed trackers", () => {
    expect(isValidAppState({ ...base(), trackers: undefined })).toBe(true);
    expect(isValidAppState({ ...base(), trackers: [] })).toBe(true);
    expect(
      isValidAppState({
        ...base(),
        trackers: [
          {
            id: "tr1",
            name: "ACME-1",
            initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
            initiativeKey: "ACME-1",
            baseUrl: "https://acme.atlassian.net",
          },
        ],
      }),
    ).toBe(true);
  });
  it("rejects malformed trackers", () => {
    const tracker = {
      id: "tr1",
      name: "ACME-1",
      initiativeUrl: "u",
      initiativeKey: "ACME-1",
      baseUrl: "https://acme.atlassian.net",
    };
    expect(isValidAppState({ ...base(), trackers: {} })).toBe(false);
    expect(
      isValidAppState({ ...base(), trackers: [{ ...tracker, id: "" }] }),
    ).toBe(false);
    expect(
      isValidAppState({
        ...base(),
        trackers: [{ ...tracker, initiativeKey: undefined }],
      }),
    ).toBe(false);
    expect(
      isValidAppState({ ...base(), trackers: [{ ...tracker, samples: {} }] }),
    ).toBe(false);
    expect(
      isValidAppState({ ...base(), trackers: [{ ...tracker, epicMap: 3 }] }),
    ).toBe(false);
    expect(
      isValidAppState({ ...base(), trackers: [{ ...tracker, taskMap: 3 }] }),
    ).toBe(false);
  });
  it("rejects non-objects and wrong shapes", () => {
    expect(isValidAppState(null)).toBe(false);
    expect(isValidAppState("nope")).toBe(false);
    expect(isValidAppState({ projects: [] })).toBe(false);
    expect(isValidAppState({ projects: {}, teams: [] })).toBe(false);
    expect(isValidAppState({ projects: [], teams: [{ members: {} }] })).toBe(
      false,
    );
  });
});

describe("migrateState", () => {
  it("folds a legacy single team into teams[]", () => {
    const legacy = {
      projects: [],
      team: {
        members: [{ id: "m1", name: "Alice", specialization: "FE" }],
        offDays: { m1: ["2026-01-02"] },
      },
    };
    const migrated = migrateState(legacy) as AppState;
    expect(migrated).not.toHaveProperty("team");
    expect(migrated.teams).toHaveLength(1);
    expect(migrated.teams[0]).toMatchObject({
      name: "Team 1",
      members: [{ id: "m1", name: "Alice", specialization: "FE" }],
      offDays: { m1: ["2026-01-02"] },
    });
    expect(isValidAppState(migrated)).toBe(true);
  });

  it("leaves an already-current state untouched", () => {
    const current = base();
    expect(migrateState(current)).toBe(current);
  });
});
