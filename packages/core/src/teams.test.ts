import { describe, it, expect } from "vitest";
import type { Project, Team } from "./types";
import {
  includedMembers,
  includedTeams,
  projectSpecializations,
} from "./teams";

const teamA: Team = {
  id: "A",
  name: "Team A",
  members: [{ id: "a", name: "A", specialization: "BE" }],
  offDays: {},
};
const teamB: Team = {
  id: "B",
  name: "Team B",
  members: [{ id: "b", name: "B", specialization: "FE" }],
  offDays: {},
};
const teams = [teamA, teamB];

function project(teamInclusions?: Project["teamInclusions"]): Project {
  return {
    id: "p1",
    name: "P",
    startDate: "2026-07-27",
    plan: null,
    planViewMode: "person",
    epics: [],
    teamInclusions,
  };
}

describe("includedTeams / includedMembers", () => {
  it("absent inclusions = every team (legacy default)", () => {
    expect(includedTeams(project(undefined), teams)).toEqual(teams);
    expect(includedMembers(project(undefined), teams).map((m) => m.id)).toEqual(
      ["a", "b"],
    );
  });

  it("empty inclusions = no team selected", () => {
    expect(includedTeams(project([]), teams)).toEqual([]);
    expect(includedMembers(project([]), teams)).toEqual([]);
  });

  it("only listed teams' members appear, and change with selection", () => {
    expect(
      includedMembers(project([{ teamId: "B" }]), teams).map((m) => m.id),
    ).toEqual(["b"]);
    expect(
      includedMembers(project([{ teamId: "A" }, { teamId: "B" }]), teams).map(
        (m) => m.id,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("projectSpecializations", () => {
  it("offers only the participating teams' specializations", () => {
    expect(projectSpecializations(project([{ teamId: "B" }]), teams)).toEqual([
      "FE",
    ]);
    expect(projectSpecializations(project(undefined), teams)).toEqual([
      "BE",
      "FE",
    ]);
  });

  it("falls back to every team when none is selected", () => {
    expect(projectSpecializations(project([]), teams)).toEqual(["BE", "FE"]);
  });

  it("adds helpers and dedupes case-insensitively, keeping first spelling", () => {
    const p: Project = {
      ...project([{ teamId: "A" }]),
      helpers: [
        {
          id: "h1",
          name: "H",
          specialization: " be ",
          speed: 1,
          availableFrom: "2026-07-27",
          availableTo: "2026-08-27",
        },
        {
          id: "h2",
          name: "H2",
          specialization: "QA",
          speed: 1,
          availableFrom: "2026-07-27",
          availableTo: "2026-08-27",
        },
        {
          id: "h3",
          name: "H3",
          specialization: "",
          speed: 1,
          availableFrom: "2026-07-27",
          availableTo: "2026-08-27",
        },
      ],
    };
    expect(projectSpecializations(p, teams)).toEqual(["BE", "QA"]);
  });
});
