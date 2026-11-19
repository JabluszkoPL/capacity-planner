import { describe, it, expect } from "vitest";
import type { AppState, Project, Team, Tracker } from "./types";
import { mergeImportedState } from "./merge";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    startDate: "2026-01-01",
    epics: [],
    plan: null,
    planViewMode: "person",
  };
}

function team(id: string, name: string, memberId: string): Team {
  return {
    id,
    name,
    members: [{ id: memberId, name: "Ann", specialization: "QA" }],
    offDays: {},
  };
}

function state(projects: Project[], teams: Team[]): AppState {
  return { projects, teams };
}

function tracker(id: string, projectId?: string): Tracker {
  return {
    id,
    name: `Tracker ${id}`,
    initiativeUrl: "https://acme.atlassian.net/browse/ACME-1",
    initiativeKey: "ACME-1",
    baseUrl: "https://acme.atlassian.net",
    ...(projectId ? { projectId } : {}),
  } as Tracker;
}

/** Deterministic id supply, so assertions can name the ids. */
function ids() {
  let n = 0;
  return () => `new${++n}`;
}

describe("mergeImportedState", () => {
  it("appends incoming projects after the existing ones", () => {
    const current = state([project("p1", "Local draft")], []);
    const incoming = state([project("p2", "Old draft")], []);
    const { state: merged } = mergeImportedState(current, incoming, ids());
    expect(merged.projects.map((p) => p.name)).toEqual([
      "Local draft",
      "Old draft",
    ]);
  });

  it("never drops or edits a project that was already here", () => {
    const current = state([project("p1", "Local draft")], []);
    const incoming = state([project("p2", "Old draft")], []);
    const { state: merged } = mergeImportedState(current, incoming, ids());
    expect(merged.projects[0]).toEqual(current.projects[0]);
  });

  it("re-ids an incoming project whose id already exists", () => {
    const current = state([project("p1", "Local draft")], []);
    const incoming = state([project("p1", "Old draft")], []);
    const { state: merged } = mergeImportedState(current, incoming, ids());
    expect(merged.projects).toHaveLength(2);
    expect(merged.projects[0].id).toBe("p1");
    expect(merged.projects[1].id).toBe("new1");
  });

  it("importing the same file twice yields two copies, not an overwrite", () => {
    const incoming = state([project("p1", "Old draft")], []);
    const once = mergeImportedState(state([], []), incoming, ids()).state;
    const twice = mergeImportedState(once, incoming, ids()).state;
    expect(twice.projects).toHaveLength(2);
    expect(twice.projects.map((p) => p.name)).toEqual([
      "Old draft",
      "Old draft (imported)",
    ]);
  });

  it("suffixes a colliding project name and reports it", () => {
    const current = state([project("p1", "Q3 Draft")], []);
    const incoming = state([project("p2", "Q3 Draft")], []);
    const report = mergeImportedState(current, incoming, ids());
    expect(report.state.projects[1].name).toBe("Q3 Draft (imported)");
    expect(report.renamedProjects).toEqual(["Q3 Draft (imported)"]);
  });

  it("counts up when the suffixed name is also taken", () => {
    const current = state(
      [project("p1", "Q3 Draft"), project("p2", "Q3 Draft (imported)")],
      [],
    );
    const incoming = state([project("p3", "Q3 Draft")], []);
    const { state: merged } = mergeImportedState(current, incoming, ids());
    expect(merged.projects[2].name).toBe("Q3 Draft (imported 2)");
  });

  it("keeps the local team and drops the incoming copy on an id match", () => {
    const current = state([], [team("tA", "Core Team", "m1")]);
    const incoming = state([], [team("tA", "Core Team (stale)", "m9")]);
    const report = mergeImportedState(current, incoming, ids());
    expect(report.state.teams).toHaveLength(1);
    expect(report.state.teams[0].name).toBe("Core Team");
    expect(report.reusedTeams).toBe(1);
    expect(report.addedTeams).toBe(0);
  });

  it("appends a team whose id is genuinely new", () => {
    const current = state([], [team("tA", "Core Team", "m1")]);
    const incoming = state([], [team("tB", "Old Team", "m2")]);
    const report = mergeImportedState(current, incoming, ids());
    expect(report.state.teams.map((t) => t.id)).toEqual(["tA", "tB"]);
    expect(report.addedTeams).toBe(1);
  });

  it("leaves an imported project pointing at the surviving team", () => {
    const current = state([], [team("tA", "Core Team", "m1")]);
    const imported = {
      ...project("p1", "Old draft"),
      teamInclusions: [{ teamId: "tA" }],
    };
    const { state: merged } = mergeImportedState(
      current,
      state([imported], [team("tA", "Core Team (stale)", "m9")]),
      ids(),
    );
    expect(merged.projects[0].teamInclusions).toEqual([{ teamId: "tA" }]);
    expect(merged.teams.map((t) => t.id)).toEqual(["tA"]);
  });

  it("preserves trackers already on the current state", () => {
    const current: AppState = {
      ...state([], []),
      trackers: [{ id: "tr1", name: "Grom", initiativeUrl: "u" } as never],
    };
    const { state: merged } = mergeImportedState(
      current,
      state([project("p1", "Old draft")], []),
      ids(),
    );
    expect(merged.trackers).toHaveLength(1);
  });

  it("is a no-op for an empty import", () => {
    const current = state([project("p1", "Local")], [team("tA", "T", "m1")]);
    const report = mergeImportedState(current, state([], []), ids());
    expect(report.state.projects).toEqual(current.projects);
    expect(report.state.teams).toEqual(current.teams);
    expect(report.addedProjects).toBe(0);
  });

  it("reports the counts it applied", () => {
    const current = state([project("p1", "Local")], [team("tA", "T", "m1")]);
    const incoming = state(
      [project("p2", "A"), project("p3", "B")],
      [team("tA", "T", "m1"), team("tZ", "Z", "m9")],
    );
    const report = mergeImportedState(current, incoming, ids());
    expect(report.addedProjects).toBe(2);
    expect(report.addedTeams).toBe(1);
    expect(report.reusedTeams).toBe(1);
  });

  it("does not mutate either input", () => {
    const current = state([project("p1", "Local")], [team("tA", "T", "m1")]);
    const incoming = state([project("p1", "Old")], []);
    const before = JSON.stringify([current, incoming]);
    mergeImportedState(current, incoming, ids());
    expect(JSON.stringify([current, incoming])).toBe(before);
  });

  describe("trackers", () => {
    it("brings an incoming tracker across with its baseline project", () => {
      const incoming: AppState = {
        ...state([project("p1", "Plan")], []),
        trackers: [tracker("tr1", "p1")],
      };
      const report = mergeImportedState(state([], []), incoming, ids());
      expect(report.state.trackers).toEqual([tracker("tr1", "p1")]);
      expect(report.addedTrackers).toBe(1);
    });

    it("re-points a tracker at its project when the project was re-ided", () => {
      const current = state([project("p1", "Plan")], []);
      const incoming: AppState = {
        ...state([project("p1", "Plan")], []),
        trackers: [tracker("tr1", "p1")],
      };
      const { state: merged } = mergeImportedState(current, incoming, ids());
      expect(merged.projects.map((p) => p.id)).toEqual(["p1", "new1"]);
      expect(merged.trackers?.[0].projectId).toBe("new1");
    });

    it("keeps the local tracker and drops the incoming copy on an id match", () => {
      const local = { ...tracker("tr1"), name: "Local name" };
      const current: AppState = { ...state([], []), trackers: [local] };
      const incoming: AppState = {
        ...state([], []),
        trackers: [tracker("tr1")],
      };
      const report = mergeImportedState(current, incoming, ids());
      expect(report.state.trackers).toEqual([local]);
      expect(report.addedTrackers).toBe(0);
      expect(report.reusedTrackers).toBe(1);
    });

    it("keeps a baseline that already exists here", () => {
      const current = state([project("p9", "Here")], []);
      const incoming: AppState = {
        ...state([], []),
        trackers: [tracker("tr1", "p9")],
      };
      const { state: merged } = mergeImportedState(current, incoming, ids());
      expect(merged.trackers?.[0].projectId).toBe("p9");
    });

    it("clears a baseline that exists in neither state", () => {
      const incoming: AppState = {
        ...state([], []),
        trackers: [tracker("tr1", "gone")],
      };
      const { state: merged } = mergeImportedState(
        state([], []),
        incoming,
        ids(),
      );
      expect(merged.trackers?.[0]).not.toHaveProperty("projectId");
    });

    it("leaves `trackers` absent when there were none on either side", () => {
      const { state: merged } = mergeImportedState(
        state([], []),
        state([project("p1", "Plan")], []),
        ids(),
      );
      expect(merged).not.toHaveProperty("trackers");
    });
  });
});
