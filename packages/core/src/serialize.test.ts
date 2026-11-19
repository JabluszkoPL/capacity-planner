import { describe, it, expect } from "vitest";
import type { AppState } from "./types";
import {
  serializeState,
  parseImportedState,
  exportFilename,
  projectExport,
  projectsExport,
} from "./serialize";

function sample(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P1",
        startDate: "2026-01-01",
        plan: null,
        planViewMode: "task",
        epics: [
          {
            id: "e1",
            name: "E1",
            tasks: [
              {
                id: "t1",
                name: "T1",
                estimateDays: 0.5,
                specialization: "QA",
                excluded: true,
              },
            ],
          },
        ],
      },
    ],
    teams: [
      {
        id: "t1",
        name: "Team 1",
        members: [{ id: "m1", name: "Alice", specialization: "QA" }],
        offDays: { m1: ["2026-01-05"] },
      },
    ],
  };
}

/** A tracker exercising every optional branch of the shape. */
function tracker() {
  return {
    id: "tr1",
    name: "Season 4",
    initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
    initiativeKey: "ACME-1",
    baseUrl: "https://acme.atlassian.net",
    projectId: "p1",
    hoursPerDay: 8,
    epicMap: { "ACME-2": "e1", "ACME-3": null },
    snapshot: {
      fetchedAt: "2026-09-13T10:00:00.000Z",
      fieldIds: { startDate: "customfield_10015" },
      initiative: {
        key: "ACME-1",
        summary: "Season 4",
        issueType: "Initiative",
        status: "In Progress",
        statusCategory: "indeterminate" as const,
        updated: "2026-09-13T09:00:00.000Z",
      },
      epics: [
        {
          key: "ACME-2",
          summary: "Meta loop",
          issueType: "Epic",
          status: "In Progress",
          statusCategory: "indeterminate" as const,
          updated: "2026-09-13T09:00:00.000Z",
          children: [],
          totals: {
            originalSec: 3600,
            spentSec: 1800,
            remainingSec: 1800,
            done: 0,
            all: 1,
          },
        },
      ],
    },
    samples: [
      {
        date: "2026-09-13",
        plannedDays: 32,
        earnedDays: 27,
        varianceDays: -5,
        bufferUsedDays: 5,
        bufferDays: 20,
        jiraSpentDays: 41,
        jiraRemainingDays: 61,
      },
    ],
    sprintDraft: {
      start: "2026-09-22",
      end: "2026-10-03",
      items: [
        {
          issueKey: "ACME-7",
          memberId: "m1",
          estimateDays: 3,
          start: "2026-09-22",
        },
      ],
    },
  };
}

describe("serialize / parse round-trip", () => {
  it("re-imports an exported state unchanged", () => {
    const state = sample();
    expect(parseImportedState(serializeState(state))).toEqual(state);
  });

  it("produces human-readable (indented) JSON", () => {
    expect(serializeState(sample())).toContain("\n  ");
  });

  it("imports a pre-multi-team export (legacy single team)", () => {
    const legacy = JSON.stringify({
      projects: [],
      team: {
        members: [{ id: "m1", name: "Alice", specialization: "QA" }],
        offDays: {},
      },
    });
    const imported = parseImportedState(legacy);
    expect(imported.teams).toHaveLength(1);
    expect(imported.teams[0].members[0].name).toBe("Alice");
  });
});

describe("parseImportedState error handling", () => {
  it("throws a clear message on malformed JSON", () => {
    expect(() => parseImportedState("{ not valid")).toThrowError(/valid JSON/i);
  });

  it("throws a clear message on valid JSON with the wrong shape", () => {
    expect(() => parseImportedState('{"foo":1}')).toThrowError(
      /Planner export/i,
    );
  });
});

describe("exportFilename", () => {
  it("is a dated .json filename", () => {
    expect(exportFilename()).toMatch(
      /^planner-export-\d{4}-\d{2}-\d{2}\.json$/,
    );
  });
});

describe("trackers survive a round trip", () => {
  it("keeps snapshot, samples, epic map and sprint draft", () => {
    const state = { ...sample(), trackers: [tracker()] };
    const back = parseImportedState(serializeState(state as never));
    expect(back.trackers).toEqual(state.trackers);
  });
  it("leaves an export without trackers loadable", () => {
    const back = parseImportedState(serializeState(sample()));
    expect(back.trackers).toBeUndefined();
  });
});

describe("projectExport", () => {
  it("takes one project, only the teams it uses, and its trackers", () => {
    const base = sample();
    const state: AppState = {
      projects: [
        { ...base.projects[0], teamInclusions: [{ teamId: "t-a" }] },
        { ...base.projects[0], id: "p2", name: "Other" },
      ],
      teams: [
        { id: "t-a", name: "A", members: [], offDays: {} },
        { id: "t-b", name: "B", members: [], offDays: {} },
      ],
      trackers: [
        { ...tracker(), id: "tr1", projectId: "p1" },
        { ...tracker(), id: "tr2", projectId: "p2" },
      ] as never,
    };
    const out = projectExport(state, "p1");
    expect(out.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(out.teams.map((t) => t.id)).toEqual(["t-a"]);
    expect(out.trackers?.map((t) => t.id)).toEqual(["tr1"]);
    // It reads back like any other export.
    expect(parseImportedState(serializeState(out)).projects).toHaveLength(1);
  });

  it("is empty for a project that does not exist", () => {
    expect(projectExport(sample(), "nope").projects).toEqual([]);
  });
});

describe("projectsExport", () => {
  function three(): AppState {
    const base = sample().projects[0];
    return {
      projects: [
        { ...base, id: "p1", name: "One", teamInclusions: [{ teamId: "t-a" }] },
        { ...base, id: "p2", name: "Two", teamInclusions: [{ teamId: "t-b" }] },
        {
          ...base,
          id: "p3",
          name: "Three",
          teamInclusions: [{ teamId: "t-a" }, { teamId: "t-b" }],
        },
      ],
      teams: [
        { id: "t-a", name: "A", members: [], offDays: {} },
        { id: "t-b", name: "B", members: [], offDays: {} },
        { id: "t-c", name: "Unused", members: [], offDays: {} },
      ],
      trackers: [
        { ...tracker(), id: "tr1", projectId: "p1" },
        { ...tracker(), id: "tr3", projectId: "p3" },
        { ...tracker(), id: "tr-free", projectId: undefined },
      ] as never,
    };
  }

  it("takes the chosen projects in state order, each team once", () => {
    const out = projectsExport(three(), ["p3", "p1"]);
    expect(out.projects.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(out.teams.map((t) => t.id)).toEqual(["t-a", "t-b"]);
    expect(out.trackers?.map((t) => t.id)).toEqual(["tr1", "tr3"]);
  });

  it("leaves out unused teams and trackers with no project", () => {
    const out = projectsExport(three(), ["p1", "p2", "p3"]);
    expect(out.teams.map((t) => t.id)).not.toContain("t-c");
    expect(out.trackers?.map((t) => t.id)).not.toContain("tr-free");
  });

  it("ignores unknown ids and reads back like any export", () => {
    const out = projectsExport(three(), ["p2", "nope"]);
    expect(out.projects.map((p) => p.id)).toEqual(["p2"]);
    expect(parseImportedState(serializeState(out)).projects).toHaveLength(1);
  });
});
