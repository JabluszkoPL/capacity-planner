import { describe, it, expect } from "vitest";
import type { Project, TeamMember } from "./types";
import { buildPlanWorkbook, planFilenameStem } from "./planExcel";

function project(): Project {
  return {
    id: "p1",
    name: "Sample Project!",
    startDate: "2026-07-27", // Monday
    planViewMode: "person",
    epics: [
      {
        id: "e1",
        name: "Build",
        tasks: [
          {
            id: "ta",
            name: "Build API",
            estimateDays: 3,
            specialization: "Frontend",
            excluded: false,
          },
        ],
      },
    ],
    plan: {
      generatedAt: "2026-07-27T00:00:00.000Z",
      assignments: [
        {
          taskId: "ta",
          taskName: "Build API",
          epicId: "e1",
          epicName: "Build",
          specialization: "Frontend",
          estimateDays: 3,
          workDays: 3,
          memberId: "m1",
          memberName: "Alice",
          start: "2026-07-27",
          end: "2026-07-29",
        },
      ],
      unassigned: [
        {
          id: "tb",
          name: "Deploy",
          estimateDays: 1,
          specialization: "DevOps",
          excluded: false,
          epicId: "e1",
          epicName: "Build",
          reason: 'No team member with specialization "DevOps"',
        },
      ],
    },
  };
}

const team: { members: TeamMember[]; offDays: Record<string, string[]> } = {
  members: [{ id: "m1", name: "Alice", specialization: "Frontend" }],
  offDays: {},
};

describe("buildPlanWorkbook", () => {
  it("creates the expected tabs, including Unassigned when present", () => {
    const wb = buildPlanWorkbook(project(), team);
    expect(wb.sheets.map((s) => s.name)).toEqual([
      "Assignments",
      "By Person",
      "By Task",
      "By Epic",
      "Unassigned",
    ]);
  });

  it("omits the Unassigned tab when everything is scheduled", () => {
    const p = project();
    p.plan!.unassigned = [];
    const wb = buildPlanWorkbook(p, team);
    expect(wb.sheets.map((s) => s.name)).not.toContain("Unassigned");
  });

  it("lists each assignment as a row on the Assignments tab", () => {
    const wb = buildPlanWorkbook(project(), team);
    const assignments = wb.sheets.find((s) => s.name === "Assignments")!;
    // header + 1 assignment
    expect(assignments.rows).toHaveLength(2);
    const values = assignments.rows[1].map((c) =>
      typeof c === "object" && c ? c.value : c,
    );
    expect(values).toContain("Build API");
    expect(values).toContain("Alice");
    expect(values).toContain(3);
  });

  it("colors the grid cells across a task's active span", () => {
    const wb = buildPlanWorkbook(project(), team);
    const byPerson = wb.sheets.find((s) => s.name === "By Person")!;
    // rows: [monthRow, dayRow, Alice]. Label col + 3 covered days (Jul 27-29).
    const aliceRow = byPerson.rows[2];
    const filled = aliceRow.filter(
      (c) => typeof c === "object" && c && c.fill && c.value === null,
    );
    // 3 spec-colored bar cells (weekends in that Mon–Wed span: none).
    const barCells = filled.filter(
      (c) => typeof c === "object" && c && c.fill !== "EEF1F5",
    );
    expect(barCells).toHaveLength(3);
  });
});

describe("planFilenameStem", () => {
  it("slugifies the project name and appends a date", () => {
    const stem = planFilenameStem(project());
    expect(stem).toMatch(/^sample-project-\d{4}-\d{2}-\d{2}$/);
  });
});
