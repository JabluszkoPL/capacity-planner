import { describe, expect, it } from "vitest";
import type { Assignment, Team } from "./types";
import { EXTERNAL_KEY, teamSpecTotals } from "./planTotals";

function assignment(over: Partial<Assignment>): Assignment {
  return {
    taskId: "t",
    taskName: "Task",
    epicId: "e",
    epicName: "Epic",
    specialization: "backend",
    estimateDays: 1,
    workDays: 1,
    memberId: "m",
    memberName: "M",
    start: "2026-01-01",
    end: "2026-01-01",
    ...over,
  };
}

const teams: Team[] = [
  {
    id: "teamA",
    name: "Team A",
    members: [
      { id: "a1", name: "Ann", specialization: "backend" },
      { id: "a2", name: "Al", specialization: "client" },
    ],
    offDays: {},
  },
  {
    id: "teamB",
    name: "Team B",
    members: [{ id: "b1", name: "Bo", specialization: "backend" }],
    offDays: {},
  },
];

describe("teamSpecTotals", () => {
  it("groups by team and specialization, summing ceil(estimateDays)", () => {
    const groups = teamSpecTotals(
      [
        assignment({
          memberId: "a1",
          specialization: "backend",
          estimateDays: 2,
        }),
        assignment({
          memberId: "a1",
          specialization: "backend",
          estimateDays: 1.4,
        }),
        assignment({
          memberId: "a2",
          specialization: "client",
          estimateDays: 3,
        }),
        assignment({
          memberId: "b1",
          specialization: "backend",
          estimateDays: 5,
        }),
      ],
      teams,
    );

    expect(groups.map((g) => g.key)).toEqual(["teamA", "teamB"]);

    const a = groups[0];
    // backend: ceil(2)+ceil(1.4)=2+2=4, client: 3 -> total 7
    expect(a.total).toBe(7);
    expect(a.specs).toEqual([
      { specialization: "backend", days: 4 },
      { specialization: "client", days: 3 },
    ]);

    const b = groups[1];
    expect(b.total).toBe(5);
    expect(b.specs).toEqual([{ specialization: "backend", days: 5 }]);
  });

  it("buckets team-less members (helpers) into a separate External group, last", () => {
    const groups = teamSpecTotals(
      [
        assignment({
          memberId: "a1",
          specialization: "backend",
          estimateDays: 2,
        }),
        assignment({
          memberId: "h1",
          specialization: "client",
          estimateDays: 4,
        }),
        assignment({
          memberId: "h2",
          specialization: "backend",
          estimateDays: 1,
        }),
      ],
      teams,
    );

    expect(groups.map((g) => g.key)).toEqual(["teamA", EXTERNAL_KEY]);
    const ext = groups[groups.length - 1];
    expect(ext.external).toBe(true);
    expect(ext.label).toBe("External");
    expect(ext.total).toBe(5);
    expect(ext.specs).toEqual([
      { specialization: "client", days: 4 },
      { specialization: "backend", days: 1 },
    ]);
  });

  it("orders specs by days desc then name, and teams in teams[] order", () => {
    const groups = teamSpecTotals(
      [
        assignment({
          memberId: "b1",
          specialization: "backend",
          estimateDays: 1,
        }),
        assignment({
          memberId: "a1",
          specialization: "backend",
          estimateDays: 1,
        }),
        assignment({
          memberId: "a2",
          specialization: "client",
          estimateDays: 1,
        }),
      ],
      teams,
    );
    expect(groups.map((g) => g.key)).toEqual(["teamA", "teamB"]);
    // Team A: backend and client both 1 day -> alphabetical.
    expect(groups[0].specs.map((s) => s.specialization)).toEqual([
      "backend",
      "client",
    ]);
  });

  it("returns an empty array when there are no assignments", () => {
    expect(teamSpecTotals([], teams)).toEqual([]);
  });

  it("labels blank specializations with an em dash", () => {
    const groups = teamSpecTotals(
      [assignment({ memberId: "a1", specialization: "  ", estimateDays: 2 })],
      teams,
    );
    expect(groups[0].specs).toEqual([{ specialization: "—", days: 2 }]);
  });
});
