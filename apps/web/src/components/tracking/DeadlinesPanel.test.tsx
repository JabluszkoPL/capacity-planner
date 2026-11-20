// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { AppState, JiraIssue } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { ToastProvider } from "../ui/Toast";
import { TrackerDetail } from "../../routes/TrackerDetail";

function issue(key: string, summary: string, done = false): JiraIssue {
  return {
    key,
    summary,
    issueType: "Story",
    status: done ? "Done" : "To Do",
    statusCategory: done ? "done" : "new",
    updated: "2026-09-01T00:00:00.000Z",
  };
}

function task(id: string, specialization: string, estimateDays = 5) {
  return { id, name: id, estimateDays, specialization, excluded: false };
}

function state(): AppState {
  return {
    teams: [
      {
        id: "t",
        name: "Core",
        members: [
          { id: "m1", name: "Dev", specialization: "Backend" },
          { id: "m2", name: "Tester", specialization: "QA" },
        ],
        offDays: {},
      },
    ],
    projects: [
      {
        id: "p",
        name: "Season",
        startDate: "2026-09-07",
        planViewMode: "person",
        plan: null,
        buffer: 20,
        epics: [
          {
            id: "e",
            name: "E",
            tasks: [
              task("b1", "Backend"),
              task("b2", "Backend"),
              task("q1", "QA"),
            ],
          },
        ],
      },
    ],
    trackers: [
      {
        id: "tr",
        name: "Season tracker",
        initiativeUrl: "",
        initiativeKey: "S-1",
        baseUrl: "https://acme.atlassian.net",
        projectId: "p",
        taskMap: { "S-2": "b1", "S-3": "b2", "S-4": "q1" },
        snapshot: {
          fetchedAt: "2026-09-20T00:00:00.000Z",
          fieldIds: {},
          initiative: { ...issue("S-1", "Season"), issueType: "Initiative" },
          epics: [
            {
              ...issue("S-10", "Epic"),
              issueType: "Epic",
              totals: {
                originalSec: 0,
                spentSec: 0,
                remainingSec: 0,
                done: 0,
                all: 3,
              },
              children: [
                issue("S-2", "b1", true),
                issue("S-3", "b2"),
                issue("S-4", "q1"),
              ],
            },
          ],
        },
      },
    ],
  };
}

function StoredDeadlines() {
  const { state } = useAppStore();
  return (
    <pre data-testid="stored">
      {JSON.stringify(state.trackers?.[0].deadlines ?? null)}
    </pre>
  );
}

function renderTracker(initial: AppState = state()) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={initial}>
          <MemoryRouter initialEntries={["/tracking/tr"]}>
            <Routes>
              <Route
                path="/tracking/:id"
                element={
                  <>
                    <TrackerDetail />
                    <StoredDeadlines />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

beforeEach(() => localStorage.clear());

describe("Deadlines", () => {
  it("shows every date from the plan before anything is set", () => {
    renderTracker();
    const deadlines = screen.getByRole("region", { name: "Deadlines" });
    const start = within(deadlines).getByRole("group", { name: "Start date" });
    expect(start).toHaveTextContent("From the plan: 2026-09-07");
    expect(
      within(start).getByRole("radio", { name: /From the plan/ }),
    ).toBeChecked();
    // The date is shown, but only editable once Custom is picked.
    expect(within(start).getByLabelText("Start date, custom")).toBeDisabled();
    expect(
      within(deadlines).getByRole("group", { name: "End date" }),
    ).toHaveTextContent(/From the plan: \d{4}-\d{2}-\d{2}/);
    // Every specialization counts as development until you say otherwise.
    for (const spec of ["Backend", "QA"]) {
      expect(
        within(deadlines).getByRole("checkbox", { name: spec }),
      ).toBeChecked();
    }
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
  });

  it("lists what the tracker measures when the plan has no tasks of its own", () => {
    // A baseline whose work all arrives from Jira as added scope: its own
    // epics are empty, yet Backend and QA are still read and still need
    // sorting into development and end-of-project work.
    const initial = state();
    initial.projects[0]!.epics = [];
    initial.trackers![0] = {
      ...initial.trackers![0]!,
      taskMap: { "S-2": null, "S-3": null, "S-4": null },
      addedScope: { "S-2": "Backend", "S-3": "Backend", "S-4": "QA" },
      deadlines: { endPhase: ["QA"] },
    };
    renderTracker(initial);
    const deadlines = screen.getByRole("region", { name: "Deadlines" });
    expect(
      within(deadlines).getByRole("checkbox", { name: "Backend" }),
    ).toBeChecked();
    expect(
      within(deadlines).getByRole("checkbox", { name: "QA" }),
    ).not.toBeChecked();
  });

  it("offers to treat QA as end-of-project work, in one click", async () => {
    const user = userEvent.setup();
    renderTracker();
    const deadlines = screen.getByRole("region", { name: "Deadlines" });
    await user.click(
      within(deadlines).getByRole("button", {
        name: "Treat QA as end-of-project work",
      }),
    );

    expect(screen.getByTestId("stored")).toHaveTextContent(
      '{"endPhase":["QA"]}',
    );
    expect(
      within(deadlines).getByRole("checkbox", { name: "QA" }),
    ).not.toBeChecked();
    // The end of development now comes from when Backend finishes.
    expect(
      within(deadlines).getByRole("group", { name: "End of development" }),
    ).toHaveTextContent("when Backend finishes");
    expect(
      screen.getByText(/^Development ends \d{4}-\d{2}-\d{2}/),
    ).toBeInTheDocument();
  });

  it("sets a custom date, and goes back to the plan's", async () => {
    const user = userEvent.setup();
    renderTracker();
    const group = screen.getByRole("group", { name: "End of development" });
    await user.click(within(group).getByRole("radio", { name: "Custom" }));
    const input = within(group).getByLabelText("End of development, custom");
    expect(input).toBeEnabled();

    fireEvent.change(input, { target: { value: "2026-10-09" } });
    expect(screen.getByTestId("stored")).toHaveTextContent(
      '{"devEndDate":"2026-10-09"}',
    );
    expect(
      screen.getByText(/^Development ends 2026-10-09/),
    ).toBeInTheDocument();

    await user.click(
      within(group).getByRole("radio", { name: /From the plan/ }),
    );
    expect(screen.getByTestId("stored")).toHaveTextContent("null");
  });

  it("re-measures from a custom start date", async () => {
    const user = userEvent.setup();
    renderTracker();
    const group = screen.getByRole("group", { name: "Start date" });
    await user.click(within(group).getByRole("radio", { name: "Custom" }));
    fireEvent.change(within(group).getByLabelText("Start date, custom"), {
      target: { value: "2026-09-14" },
    });
    expect(screen.getByTestId("stored")).toHaveTextContent(
      '{"startDate":"2026-09-14"}',
    );
  });
});
