import { describe, it, expect } from "vitest";
import {
  autoTaskMap,
  runPlan,
  type AppState,
  type JiraIssue,
  type JiraSnapshot,
  type Project,
  type Tracker,
} from "@planner/core";
import {
  commitJiraImport,
  defaultJiraImportChoices,
  previewJiraImport,
  teamSpecializations,
  type JiraImportActions,
  type JiraImportSource,
} from "./jiraImport";

const SITE = "https://acme.atlassian.net";
const h = (n: number) => n * 3600;

function issue(
  key: string,
  summary: string,
  hours: number,
  done = false,
  extra: Partial<JiraIssue> = {},
): JiraIssue {
  return {
    key,
    summary,
    issueType: "Story",
    status: done ? "Done" : "To Do",
    statusCategory: done ? "done" : "new",
    originalEstimateSec: h(hours),
    updated: "2026-09-01T00:00:00.000Z",
    ...extra,
  };
}

/** Jira today: the old "Payments" epic was split into two milestones. */
const snapshot: JiraSnapshot = {
  fetchedAt: "2026-09-21T09:00:00.000Z",
  initiative: {
    ...issue("INI-1", "Checkout", 0),
    issueType: "Initiative",
  },
  fieldIds: {},
  epics: [
    {
      ...issue("E-1", "Milestone 1: card payments", 0, false, {
        issueType: "Epic",
        dueDate: "2026-09-30",
      }),
      totals: { originalSec: 0, spentSec: 0, remainingSec: 0, done: 0, all: 0 },
      children: [
        issue("A-1", "Card form UI", 16, true),
        issue("A-2", "Tokenise cards", 24),
      ],
    },
    {
      ...issue("E-2", "Milestone 2: wallets", 0, false, {
        issueType: "Epic",
        dueDate: "2026-10-31",
      }),
      totals: { originalSec: 0, spentSec: 0, remainingSec: 0, done: 0, all: 0 },
      children: [issue("B-1", "Apple Pay", 40), issue("B-2", "Research", 0)],
    },
  ],
};

const source: JiraImportSource = {
  snapshot,
  initiativeUrl: `${SITE}/browse/INI-1`,
  initiativeKey: "INI-1",
  baseUrl: SITE,
};

function oldPlan(): Project {
  const p: Project = {
    id: "p-old",
    name: "Sheets plan",
    startDate: "2026-09-07",
    planViewMode: "person",
    plan: null,
    buffer: 20,
    teamInclusions: [{ teamId: "team" }],
    epics: [
      {
        id: "e-pay",
        name: "Payments",
        tasks: [
          {
            id: "t-form",
            name: "Card form UI",
            estimateDays: 2,
            specialization: "Frontend",
            excluded: false,
          },
          {
            id: "t-token",
            name: "Card tokenisation",
            estimateDays: 3,
            specialization: "Backend",
            excluded: false,
          },
        ],
      },
    ],
  };
  return p;
}

function appState(): AppState {
  const teams = [
    {
      id: "team",
      name: "Team",
      members: [
        { id: "m1", name: "Alice", specialization: "Frontend" },
        { id: "m2", name: "Ben", specialization: "Backend" },
      ],
      offDays: {},
    },
  ];
  const p = oldPlan();
  const tracker: Tracker = {
    id: "tr-old",
    name: "INI-1",
    initiativeUrl: source.initiativeUrl,
    initiativeKey: "INI-1",
    baseUrl: SITE,
    projectId: p.id,
    snapshot,
    // A manual correction the name matcher could not make.
    taskMap: { "A-2": "t-token" },
  };
  return {
    teams,
    projects: [{ ...p, plan: runPlan(p, teams, "2026-09-07T00:00:00Z") }],
    trackers: [tracker],
  };
}

const TODAY = "2026-09-21";
const NOW = "2026-09-21T10:00:00.000Z";

function counter() {
  let n = 0;
  return () => `id-${++n}`;
}

function fakeActions() {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const actions = {
    addProject: record("addProject"),
    addTracker: record("addTracker"),
    setTrackerTaskMap: record("setTrackerTaskMap"),
    setTrackerProject: record("setTrackerProject"),
    setTrackerSnapshot: record("setTrackerSnapshot"),
  } as JiraImportActions;
  return { actions, calls };
}

describe("defaultJiraImportChoices", () => {
  it("starts from the tracker's baseline: its people, start date and buffer", () => {
    const state = appState();
    const choices = defaultJiraImportChoices({
      source,
      state,
      fromTracker: state.trackers![0],
      hoursPerDay: 8,
      today: TODAY,
    });
    expect(choices.templateId).toBe("p-old");
    expect(choices.startDate).toBe("2026-09-07");
    expect(choices.buffer).toBe(20);
    expect(choices.track).toEqual({ kind: "new" });
    expect(choices.name).toContain("Checkout");
  });

  it("without any baseline, starts today with no buffer", () => {
    const state: AppState = { projects: [], teams: [] };
    const choices = defaultJiraImportChoices({
      source,
      state,
      hoursPerDay: 8,
      today: TODAY,
    });
    expect(choices.templateId).toBeNull();
    expect(choices.startDate).toBe(TODAY);
    expect(choices.buffer).toBe(0);
    expect(choices.defaultSpecialization).toBe("General");
  });
});

describe("previewJiraImport", () => {
  function preview(state = appState()) {
    const choices = defaultJiraImportChoices({
      source,
      state,
      fromTracker: state.trackers![0],
      hoursPerDay: 8,
      today: TODAY,
    });
    return {
      choices,
      state,
      preview: previewJiraImport({
        source,
        state,
        choices,
        projectId: "p-new",
        newId: counter(),
        today: TODAY,
        now: NOW,
      }),
    };
  }

  it("plans the whole Jira scope and measures it against Jira", () => {
    const { preview: p } = preview();
    const project = p.built.project;
    expect(project.epics.map((e) => e.name)).toEqual([
      "Milestone 1: card payments",
      "Milestone 2: wallets",
    ]);
    // 2 + 3 + 5 days; "Research" has no estimate and is skipped.
    expect(p.rebuilt.estimateDays).toBe(10);
    expect(p.unestimated).toBe(1);
    expect(project.plan?.assignments).toHaveLength(3);
    expect(p.rebuilt.plans.unbufferedEnd).not.toBeNull();
    // A-1 is done in Jira, and the task map is exact, so it is earned.
    expect(p.rebuilt.status.kind).not.toBe("no-baseline");
    expect(p.rebuilt.status.earnedDays).toBe(2);
  });

  it("measures the current plan through its tracker's own task map", () => {
    const { preview: p, state } = preview();
    expect(p.current?.project.id).toBe("p-old");
    expect(p.current?.estimateDays).toBe(5);
    const expected = autoTaskMap(
      state.projects[0],
      snapshot,
      state.trackers![0].taskMap,
    );
    expect(expected["A-1"]).toBe("t-form");
    expect(p.current?.status.earnedDays).toBe(2);
  });

  it("borrows specializations from the old plan, even for renamed tasks", () => {
    const { preview: p } = preview();
    const [form, token] = p.built.project.epics[0].tasks;
    expect(form.specialization).toBe("Frontend");
    expect(token.specialization).toBe("Backend");
    expect(p.specSources.plan).toBe(2);
  });

  it("flags a specialization nobody can do", () => {
    const state = appState();
    const choices = {
      ...defaultJiraImportChoices({
        source,
        state,
        fromTracker: state.trackers![0],
        hoursPerDay: 8,
        today: TODAY,
      }),
      templateId: null,
      defaultSpecialization: "Mobile",
    };
    const p = previewJiraImport({
      source,
      state,
      choices,
      projectId: "p-new",
      newId: counter(),
      today: TODAY,
      now: NOW,
    });
    expect(p.missingSpecializations).toEqual(["Mobile"]);
    expect(p.rebuilt.unassigned).toBe(3);
  });
});

describe("tag mappings", () => {
  const labelled: JiraImportSource = {
    ...source,
    snapshot: {
      ...snapshot,
      epics: [
        {
          ...snapshot.epics[1],
          children: [
            issue("C-1", "Level editor", 8, false, { labels: ["tooling"] }),
            issue("C-2", "Price service", 8, false, { labels: ["java"] }),
          ],
        },
      ],
    },
  };

  function specsFor(tagAliases: { tag: string; specialization: string }[]) {
    const state = appState();
    const choices = {
      ...defaultJiraImportChoices({
        source: labelled,
        state,
        hoursPerDay: 8,
        today: TODAY,
        tagAliases,
      }),
      defaultSpecialization: "Frontend",
    };
    expect(choices.tagAliases).toEqual(tagAliases);
    const p = previewJiraImport({
      source: labelled,
      state,
      choices,
      projectId: "p-new",
      newId: counter(),
      today: TODAY,
      now: NOW,
    });
    return {
      specs: p.built.project.epics[0].tasks.map((t) => t.specialization),
      sources: p.specSources,
    };
  }

  it("reads java as Backend out of the box", () => {
    const { specs, sources } = specsFor([]);
    // "tooling" names nothing yet, so the epic's only tag decides.
    expect(specs).toEqual(["Backend", "Backend"]);
    expect(sources.tag).toBe(1);
    expect(sources.epic).toBe(1);
  });

  it("applies the mappings the user added", () => {
    const { specs, sources } = specsFor([
      { tag: "tooling", specialization: "Frontend" },
    ]);
    expect(specs).toEqual(["Frontend", "Backend"]);
    expect(sources.tag).toBe(2);
  });

  it("offers every specialization on any team, once each", () => {
    const state = appState();
    state.teams.push({
      id: "t2",
      name: "Tools",
      members: [
        { id: "m3", name: "Cy", specialization: "Tools" },
        { id: "m4", name: "Di", specialization: "Backend" },
        { id: "m5", name: "Ed", specialization: " " },
      ],
      offDays: {},
    });
    expect(teamSpecializations(state)).toEqual([
      "Backend",
      "Frontend",
      "Tools",
    ]);
  });
});

describe("commitJiraImport", () => {
  function setup(track: "new" | "switch" | "none") {
    const state = appState();
    const choices = {
      ...defaultJiraImportChoices({
        source,
        state,
        fromTracker: state.trackers![0],
        hoursPerDay: 8,
        today: TODAY,
      }),
      track:
        track === "switch"
          ? ({ kind: "switch", trackerId: "tr-old" } as const)
          : ({ kind: track } as const),
    };
    const preview = previewJiraImport({
      source,
      state,
      choices,
      projectId: "p-new",
      newId: counter(),
      today: TODAY,
      now: NOW,
    });
    const { actions, calls } = fakeActions();
    const trackerId = commitJiraImport({
      preview,
      source,
      choices,
      actions,
      newId: () => "tr-new",
      defaultHoursPerDay: 8,
    });
    return { preview, calls, trackerId };
  }

  it("creates the project and a new tracker with an exact map and a first sample", () => {
    const { preview, calls, trackerId } = setup("new");
    expect(trackerId).toBe("tr-new");
    expect(calls.map((c) => c.name)).toEqual(["addProject", "addTracker"]);
    expect(calls[0].args[0]).toBe(preview.built.project);
    const tracker = calls[1].args[0] as Tracker;
    expect(tracker.projectId).toBe("p-new");
    expect(tracker.taskMap).toEqual(preview.built.taskMap);
    expect(tracker.snapshot).toBe(snapshot);
    expect(tracker.samples).toHaveLength(1);
    expect(tracker.samples?.[0].date).toBe(TODAY);
    expect(tracker).not.toHaveProperty("hoursPerDay");
  });

  it("can switch an existing tracker's baseline instead", () => {
    const { preview, calls, trackerId } = setup("switch");
    expect(trackerId).toBe("tr-old");
    expect(calls.map((c) => c.name)).toEqual([
      "addProject",
      "setTrackerTaskMap",
      "setTrackerProject",
      "setTrackerSnapshot",
    ]);
    expect(calls[1].args).toEqual(["tr-old", preview.built.taskMap]);
    expect(calls[2].args).toEqual(["tr-old", "p-new"]);
  });

  it("can create just the project", () => {
    const { calls, trackerId } = setup("none");
    expect(trackerId).toBeNull();
    expect(calls.map((c) => c.name)).toEqual(["addProject"]);
  });
});
