import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Project, Team } from "@planner/core";
import {
  ProjectCard,
  projectStats,
  completesOn,
  planSummary,
} from "./ProjectCard";

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Alpha",
    startDate: "2026-07-27",
    plan: null,
    planViewMode: "person",
    epics: [
      {
        id: "e1",
        name: "E1",
        tasks: [
          {
            id: "t1",
            name: "T1",
            estimateDays: 3,
            specialization: "FE",
            excluded: false,
          },
          {
            id: "t2",
            name: "T2",
            estimateDays: 2,
            specialization: "BE",
            excluded: true,
          },
        ],
      },
    ],
    ...over,
  };
}

describe("projectStats / completesOn", () => {
  it("counts epics/tasks and sums only non-excluded days", () => {
    expect(projectStats(makeProject())).toEqual({
      epics: 1,
      tasks: 2,
      activeDays: 3,
    });
  });

  it("returns null completion when unplanned, latest end when planned", () => {
    expect(completesOn(makeProject())).toBeNull();
    const planned = makeProject({
      plan: {
        generatedAt: "2026-07-23T00:00:00Z",
        assignments: [
          {
            taskId: "t1",
            taskName: "T1",
            epicId: "e1",
            epicName: "E1",
            specialization: "FE",
            estimateDays: 3,
            workDays: 1,
            memberId: "m1",
            memberName: "A",
            start: "2026-07-27",
            end: "2026-07-29",
          },
          {
            taskId: "t3",
            taskName: "T3",
            epicId: "e1",
            epicName: "E1",
            specialization: "FE",
            estimateDays: 1,
            workDays: 1,
            memberId: "m1",
            memberName: "A",
            start: "2026-07-30",
            end: "2026-08-04",
          },
        ],
        unassigned: [],
      },
    });
    expect(completesOn(planned)).toBe("2026-08-04");
  });
});

function makeTeams(): Team[] {
  return [
    {
      id: "tA",
      name: "Core",
      members: [
        { id: "m1", name: "Ann", specialization: "FE" },
        { id: "m2", name: "Bo", specialization: "BE" },
      ],
      offDays: {},
    },
    {
      id: "tB",
      name: "Strike",
      members: [{ id: "m3", name: "Cy", specialization: "BE" }],
      offDays: {},
    },
  ];
}

describe("planSummary", () => {
  it("passes the buffer through (0 when unset)", () => {
    expect(planSummary(makeProject(), []).buffer).toBe(0);
    expect(planSummary(makeProject({ buffer: 25 }), []).buffer).toBe(25);
  });

  it("lists included teams and flags a team that starts late", () => {
    const project = makeProject({
      teamInclusions: [
        { teamId: "tA" },
        { teamId: "tB", availableFrom: "2026-08-10" },
      ],
    });
    const { teams } = planSummary(project, makeTeams());
    expect(teams.map((t) => t.name)).toEqual(["Core", "Strike"]);
    // Core starts with the project (no late flag); Strike is held to Aug 10.
    expect(teams.find((t) => t.name === "Core")?.startsLate).toBeNull();
    expect(teams.find((t) => t.name === "Strike")?.startsLate).toBe(
      "2026-08-10",
    );
  });

  it("flags a team late only when every member starts after the project", () => {
    const base = { teamInclusions: [{ teamId: "tA" }] };
    // One member delayed -> the team as a whole still starts on time.
    expect(
      planSummary(
        makeProject({ ...base, memberStarts: { m1: "2026-08-05" } }),
        makeTeams(),
      ).teams[0].startsLate,
    ).toBeNull();
    // Both members delayed -> team starts at the earliest of the two.
    expect(
      planSummary(
        makeProject({
          ...base,
          memberStarts: { m1: "2026-08-05", m2: "2026-08-03" },
        }),
        makeTeams(),
      ).teams[0].startsLate,
    ).toBe("2026-08-03");
  });

  it("groups helpers by specialization with a count and average start", () => {
    const project = makeProject({
      helpers: [
        {
          id: "h1",
          name: "H1",
          specialization: "BE",
          speed: 1,
          availableFrom: "2026-08-01",
          availableTo: "2026-09-01",
        },
        {
          id: "h2",
          name: "H2",
          specialization: "be",
          speed: 1,
          availableFrom: "2026-08-11",
          availableTo: "2026-09-01",
        },
        {
          id: "h3",
          name: "H3",
          specialization: "QA",
          speed: 1,
          availableFrom: "2026-08-20",
          availableTo: "2026-09-01",
        },
      ],
    });
    const { helpers } = planSummary(project, []);
    const be = helpers.find((h) => h.specialization === "BE");
    const qa = helpers.find((h) => h.specialization === "QA");
    expect(be).toMatchObject({ count: 2, avgStart: "2026-08-06" });
    expect(qa).toMatchObject({ count: 1, avgStart: "2026-08-20" });
  });
});

/** The value shown next to a stat label on the card. */
function stat(label: string): string | null | undefined {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling
    ?.textContent;
}

describe("ProjectCard", () => {
  it("shows stats and the 'Not planned yet' state, and fires callbacks", () => {
    const onOpen = vi.fn();
    const onCopy = vi.fn();
    const onDelete = vi.fn();
    render(
      <ProjectCard
        project={makeProject()}
        onOpen={onOpen}
        onCopy={onCopy}
        onDelete={onDelete}
      />,
    );
    expect(stat("Epics")).toBe("1");
    expect(stat("Tasks")).toBe("2");
    expect(stat("Estimate")).toBe("3 days");
    expect(stat("Planned finish")).toBe("Not planned yet");
    expect(screen.getByText("Buffer 0%")).toBeInTheDocument();
    expect(screen.getByText("No teams yet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    expect(onOpen).toHaveBeenCalledWith("p1");
    expect(onCopy).toHaveBeenCalledWith("p1");
    expect(onDelete).toHaveBeenCalledWith("p1");
    // No onExport -> no per-card export button.
    expect(
      screen.queryByRole("button", { name: "Export Alpha" }),
    ).not.toBeInTheDocument();
  });

  it("opens from the title with Enter or Space", () => {
    const onOpen = vi.fn();
    render(
      <ProjectCard
        project={makeProject()}
        onOpen={onOpen}
        onCopy={() => {}}
        onDelete={() => {}}
      />,
    );
    const title = screen.getByRole("button", { name: "Alpha" });
    fireEvent.keyDown(title, { key: "Enter" });
    fireEvent.keyDown(title, { key: " " });
    fireEvent.click(title);
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("shows teams (with late starts), helpers, buffer, note and export", () => {
    const onExport = vi.fn();
    render(
      <ProjectCard
        project={makeProject({
          buffer: 20,
          note: "Waiting on design",
          titleColor: "#5b7fb8",
          teamInclusions: [
            { teamId: "tA" },
            { teamId: "tB", availableFrom: "2026-08-10" },
          ],
          helpers: [
            {
              id: "h1",
              name: "H1",
              specialization: "QA",
              speed: 1,
              availableFrom: "2026-08-20",
              availableTo: "2026-09-01",
            },
          ],
        })}
        teams={makeTeams()}
        onOpen={() => {}}
        onCopy={() => {}}
        onExport={onExport}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByTitle("Teams working this project")).toHaveTextContent(
      "Core, Strike (from Aug 10)",
    );
    expect(
      screen.getByTitle("Additional support (helpers), by specialization"),
    ).toHaveTextContent("1 QA (avg start Aug 20)");
    expect(screen.getByText("Buffer 20%")).toBeInTheDocument();
    expect(screen.getByText("Waiting on design")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export Alpha" }));
    expect(onExport).toHaveBeenCalledWith("p1");
  });

  it("shows the planned finish date when a plan exists", () => {
    const planned = makeProject({
      plan: {
        generatedAt: "2026-07-23T00:00:00Z",
        assignments: [
          {
            taskId: "t1",
            taskName: "T1",
            epicId: "e1",
            epicName: "E1",
            specialization: "FE",
            estimateDays: 3,
            workDays: 1,
            memberId: "m1",
            memberName: "A",
            start: "2026-07-27",
            end: "2026-07-29",
          },
        ],
        unassigned: [],
      },
    });
    render(
      <ProjectCard
        project={planned}
        onOpen={() => {}}
        onCopy={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(stat("Planned finish")).toBe("Jul 29, 2026");
    expect(screen.queryByText("Not planned yet")).not.toBeInTheDocument();
  });
});
