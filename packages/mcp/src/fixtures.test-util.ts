/**
 * A small, fully deterministic world for the tool tests: one team of three,
 * one project with two epics, and one Jira tracker whose snapshot has a
 * matched task, added scope, an unmapped task and another team's epic.
 */
import { reducer } from "@planner/client-runtime";
import type { AppState, JiraEpic, JiraIssue, Tracker } from "@planner/core";
import type { ToolContext } from "./context";

export const IDS = {
  team: "team-core",
  alice: "m-alice",
  ben: "m-ben",
  cara: "m-cara",
  project: "p-apollo",
  epicLogin: "e-login",
  epicBilling: "e-billing",
  taskUi: "t-ui",
  taskApi: "t-api",
  taskInvoices: "t-invoices",
  tracker: "tr-apollo",
};

const BASE = "https://acme.atlassian.net";

function issue(
  key: string,
  summary: string,
  extra: Partial<JiraIssue> = {},
): JiraIssue {
  return {
    key,
    summary,
    issueType: "Task",
    status: "To Do",
    statusCategory: "new",
    updated: "2026-01-10T09:00:00.000Z",
    originalEstimateSec: 8 * 3600,
    ...extra,
  };
}

function epic(key: string, summary: string, children: JiraIssue[]): JiraEpic {
  return {
    ...issue(key, summary, { issueType: "Epic" }),
    children,
    totals: {
      originalSec: children.reduce(
        (s, c) => s + (c.originalEstimateSec ?? 0),
        0,
      ),
      spentSec: 0,
      remainingSec: 0,
      done: children.filter((c) => c.statusCategory === "done").length,
      all: children.length,
    },
  };
}

export function fixtureState(): AppState {
  const tracker: Tracker = {
    id: IDS.tracker,
    name: "Apollo in Jira",
    initiativeUrl: `${BASE}/browse/ACME-1`,
    initiativeKey: "ACME-1",
    baseUrl: BASE,
    projectId: IDS.project,
    untrackedEpics: ["ACME-20"],
    snapshot: {
      fetchedAt: "2026-01-12T08:00:00.000Z",
      initiative: issue("ACME-1", "Apollo", { issueType: "Initiative" }),
      fieldIds: {},
      epics: [
        epic("ACME-10", "Login", [
          issue("ACME-11", "UI", {
            status: "Done",
            statusCategory: "done",
            assignee: { accountId: "a1", displayName: "Alice Kim" },
          }),
          issue("ACME-12", "API", {
            status: "In Progress",
            statusCategory: "indeterminate",
            originalEstimateSec: 4 * 8 * 3600,
          }),
          issue("ACME-13", "Password reset", { labels: ["Backend"] }),
          issue("ACME-14", "Spike on SSO"),
        ]),
        epic("ACME-20", "Other team's epic", [issue("ACME-21", "Not ours")]),
      ],
    },
    samples: [
      {
        date: "2026-01-09",
        plannedDays: 2,
        earnedDays: 2,
        varianceDays: 0,
        bufferUsedDays: 0,
        bufferDays: 2,
        jiraSpentDays: 1,
        jiraRemainingDays: 5,
      },
      {
        date: "2026-01-12",
        plannedDays: 4,
        earnedDays: 2,
        varianceDays: -1,
        bufferUsedDays: 1,
        bufferDays: 2,
        jiraSpentDays: 2,
        jiraRemainingDays: 5,
      },
    ],
  };

  return {
    teams: [
      {
        id: IDS.team,
        name: "Core",
        members: [
          { id: IDS.alice, name: "Alice Kim", specialization: "Frontend" },
          { id: IDS.ben, name: "Ben Osei", specialization: "Backend" },
          {
            id: IDS.cara,
            name: "Cara Diaz",
            specialization: "Backend",
            speed: 0.8,
          },
        ],
        offDays: { [IDS.alice]: ["2026-01-07"] },
      },
    ],
    projects: [
      {
        id: IDS.project,
        name: "Apollo",
        startDate: "2026-01-05",
        planViewMode: "person",
        buffer: 20,
        plan: null,
        epics: [
          {
            id: IDS.epicLogin,
            name: "Login",
            tasks: [
              {
                id: IDS.taskUi,
                name: "UI",
                estimateDays: 2,
                specialization: "Frontend",
                excluded: false,
              },
              {
                id: IDS.taskApi,
                name: "API",
                estimateDays: 3,
                specialization: "Backend",
                excluded: false,
                dependsOn: [IDS.taskUi],
              },
            ],
          },
          {
            id: IDS.epicBilling,
            name: "Billing",
            dependsOn: [IDS.epicLogin],
            tasks: [
              {
                id: IDS.taskInvoices,
                name: "Invoices",
                estimateDays: 2,
                specialization: "Backend",
                excluded: false,
              },
            ],
          },
        ],
      },
    ],
    trackers: [tracker],
  };
}

export function fixtureContext(
  overrides: Partial<ToolContext> = {},
): ToolContext {
  let n = 0;
  return {
    state: fixtureState(),
    today: "2026-01-12",
    now: "2026-01-12T10:00:00.000Z",
    newId: () => `new-${++n}`,
    reduce: reducer,
    view: { path: "/" },
    ...overrides,
  };
}
