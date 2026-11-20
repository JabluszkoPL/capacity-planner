// @vitest-environment jsdom
/**
 * "New plan from Jira" end to end on real-shaped data: a snapshot assembled
 * by the real mapper from recorded Jira JSON, landing on the real project page
 * and the real tracker page. A blank screen anywhere along this path fails
 * here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { AppState } from "@planner/core";
import { buildSnapshot } from "@planner/jira";
import { AppStoreProvider } from "@planner/client-runtime";
import { ConfirmProvider } from "../components/ui/ConfirmDialog";
import { ToastProvider, ToastHost } from "../components/ui/Toast";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { ProjectsDashboard } from "./ProjectsDashboard";
import { ProjectDetail } from "./ProjectDetail";
import { TrackingPage } from "./TrackingPage";
import { TrackerDetail } from "./TrackerDetail";
import childrenPage1 from "../../../../packages/jira/src/__fixtures__/children-page1.json";
import childrenPage2 from "../../../../packages/jira/src/__fixtures__/children-page2.json";
import epicsFixture from "../../../../packages/jira/src/__fixtures__/epics.json";
import initiativeFixture from "../../../../packages/jira/src/__fixtures__/initiative.json";

const SITE = "https://acme.atlassian.net";

const snapshot = buildSnapshot(
  initiativeFixture,
  epicsFixture.issues,
  [...childrenPage1.issues, ...childrenPage2.issues],
  { startDate: "customfield_10015", sprint: "customfield_10020" },
  "2026-09-15T08:00:00.000Z",
);

function state(withBaseline: boolean): AppState {
  return {
    teams: [
      {
        id: "team",
        name: "Payments",
        members: [
          { id: "m1", name: "Ines Moreau", specialization: "Backend" },
          { id: "m2", name: "Tomas Reyes", specialization: "Frontend" },
        ],
        offDays: { m1: ["2026-09-18"] },
      },
    ],
    projects: withBaseline
      ? [
          {
            id: "p-old",
            name: "Sheets plan",
            startDate: "2026-07-06",
            planViewMode: "person",
            plan: null,
            buffer: 15,
            teamInclusions: [{ teamId: "team", velocity: 0.9 }],
            epicAssignments: { "e-old": ["m1"] },
            epics: [
              {
                id: "e-old",
                name: "Payments",
                tasks: [
                  {
                    id: "t-old",
                    name: "Tokenise stored cards",
                    estimateDays: 1,
                    specialization: "Backend",
                    excluded: false,
                  },
                  {
                    id: "t-dep",
                    name: "Refund flow",
                    estimateDays: 2,
                    specialization: "Frontend",
                    excluded: false,
                    dependsOn: ["t-old"],
                  },
                ],
              },
            ],
          },
        ]
      : [],
    trackers: [
      {
        id: "tr",
        name: "ACME-1",
        initiativeUrl: `${SITE}/browse/ACME-1`,
        initiativeKey: "ACME-1",
        baseUrl: SITE,
        ...(withBaseline ? { projectId: "p-old" } : {}),
        taskMap: withBaseline ? { "ACME-101": "t-dep" } : {},
        snapshot,
        sprintDraft: {
          start: "2026-09-21",
          end: "2026-10-02",
          items: [
            { issueKey: "ACME-102", estimateDays: 1, start: "2026-09-21" },
          ],
        },
      },
    ],
  };
}

function renderApp(initial: AppState, path: string) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={initial}>
          <MemoryRouter initialEntries={[path]}>
            <ErrorBoundary
              fallback={(error) => <p>CRASHED: {error.message}</p>}
            >
              <Routes>
                <Route path="/" element={<ProjectsDashboard />} />
                <Route path="/project/:id" element={<ProjectDetail />} />
                <Route path="/tracking" element={<TrackingPage />} />
                <Route path="/tracking/:id" element={<TrackerDetail />} />
              </Routes>
            </ErrorBoundary>
          </MemoryRouter>
          <ToastHost />
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

describe.each([
  ["with a baseline to copy people from", true],
  ["with no baseline at all", false],
])("New plan from Jira, %s", (_label, withBaseline) => {
  it.each(["new", "switch", "none"] as const)(
    "creates the project and lands on a working page (track: %s)",
    async (track) => {
      const user = userEvent.setup();
      renderApp(state(withBaseline), "/tracking/tr");

      await user.click(
        screen.getByRole("button", { name: "New plan from Jira" }),
      );
      const dialog = screen.getByRole("dialog");
      expect(dialog).not.toHaveTextContent("Couldn't build the plan");

      const trackSelect = within(dialog).getByLabelText("Compare with Jira in");
      if (track === "switch") {
        await user.selectOptions(
          trackSelect,
          within(trackSelect).getByRole("option", { name: /switch/ }),
        );
      } else if (track === "none") {
        await user.selectOptions(trackSelect, "none");
      }
      await user.click(
        within(dialog).getByRole("button", { name: "Create project" }),
      );

      // The real project page: its overview lists the imported epics...
      expect(screen.queryByText(/CRASHED/)).not.toBeInTheDocument();
      expect(screen.getByText("Project summary")).toBeInTheDocument();
      expect(
        screen.getAllByText("Payment provider swap").length,
      ).toBeGreaterThan(0);

      // ...the editor opens on them...
      await user.click(screen.getByRole("link", { name: "Epics & tasks" }));
      expect(screen.queryByText(/CRASHED/)).not.toBeInTheDocument();
      expect(screen.getByText("Epics & Tasks")).toBeInTheDocument();

      // ...and the plan has already been run.
      const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
      await user.click(within(crumbs).getAllByRole("link")[1]!);
      await user.click(screen.getByRole("link", { name: "Plan & timeline" }));
      expect(screen.queryByText(/CRASHED/)).not.toBeInTheDocument();
      expect(screen.getByText(/Estimated completion/)).toBeInTheDocument();

      // And the tracking side still renders afterwards.
      await user.click(screen.getByRole("link", { name: "Projects" }));
      expect(screen.queryByText(/CRASHED/)).not.toBeInTheDocument();
    },
  );
});

describe("New plan from Jira, from the Projects page", () => {
  it("renders the dashboard entry point without crashing", async () => {
    const user = userEvent.setup();
    renderApp(state(true), "/");
    await user.click(
      screen.getByRole("button", { name: "From Jira initiative" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Initiative link or key",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/CRASHED/)).not.toBeInTheDocument();
  });
});
