// @vitest-environment jsdom
/**
 * "New plan from Jira", driven through the real store and router from both
 * places it can start: a tracker (which already holds a snapshot) and the
 * Projects page (which has to download one first).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import type { AppState, JiraIssue, JiraSnapshot } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { ToastProvider, ToastHost } from "../ui/Toast";
import { TrackerDetail } from "../../routes/TrackerDetail";
import { ProjectsDashboard } from "../../routes/ProjectsDashboard";
import { writeJiraSettings } from "../../lib/jiraSettings";
import { readTagAliases, writeTagAliases } from "../../lib/tagAliases";

const SITE = "https://acme.atlassian.net";

function issue(
  key: string,
  summary: string,
  hours: number,
  done = false,
): JiraIssue {
  return {
    key,
    summary,
    issueType: "Story",
    status: done ? "Done" : "To Do",
    statusCategory: done ? "done" : "new",
    originalEstimateSec: hours * 3600,
    updated: "2026-09-01T00:00:00.000Z",
  };
}

const snapshot: JiraSnapshot = {
  fetchedAt: "2026-09-21T09:00:00.000Z",
  initiative: { ...issue("INI-1", "Season 4", 0), issueType: "Initiative" },
  fieldIds: {},
  epics: [
    {
      ...issue("E-1", "Milestone 1", 0),
      issueType: "Epic",
      totals: { originalSec: 0, spentSec: 0, remainingSec: 0, done: 0, all: 0 },
      children: [
        issue("A-1", "Quest board", 48, true),
        { ...issue("A-2", "Daily rewards", 16), labels: ["tooling"] },
      ],
    },
  ],
};

function state(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "Sheets plan",
        startDate: "2026-09-07",
        planViewMode: "person",
        plan: null,
        buffer: 20,
        epics: [
          {
            id: "e-meta",
            name: "Meta loop",
            tasks: [
              {
                id: "t1",
                name: "Quest board",
                estimateDays: 6,
                specialization: "dev",
                excluded: false,
              },
            ],
          },
        ],
      },
    ],
    teams: [
      {
        id: "team1",
        name: "Core",
        members: [{ id: "m1", name: "Ada", specialization: "dev" }],
        offDays: {},
      },
    ],
    trackers: [
      {
        id: "tr1",
        name: "INI-1",
        initiativeUrl: `${SITE}/browse/INI-1`,
        initiativeKey: "INI-1",
        baseUrl: SITE,
        projectId: "p1",
        snapshot,
      },
    ],
  };
}

/** Where the flow lands; prints what the store now holds. */
function ProjectProbe() {
  const { id } = useParams();
  const { state } = useAppStore();
  const project = state.projects.find((p) => p.id === id);
  const tracker = (state.trackers ?? []).find((t) => t.projectId === id);
  return (
    <div>
      <p>Opened {project?.name}</p>
      <p>Tasks {project?.epics.flatMap((e) => e.tasks).length}</p>
      <p>Planned {project?.plan?.assignments.length ?? 0}</p>
      <p>Trackers {state.trackers?.length}</p>
      <p>
        Linked {tracker ? Object.keys(tracker.taskMap ?? {}).join(",") : ""}
      </p>
    </div>
  );
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={state()}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/" element={<ProjectsDashboard />} />
              <Route path="/tracking/:id" element={<TrackerDetail />} />
              <Route path="/project/:id" element={<ProjectProbe />} />
            </Routes>
          </MemoryRouter>
          <ToastHost />
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // The dashboard restores its scroll position, which jsdom does not implement.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

describe("New plan from Jira", () => {
  it("builds a project from a tracker's snapshot and tracks it separately", async () => {
    const user = userEvent.setup();
    renderAt("/tracking/tr1");

    await user.click(
      screen.getByRole("button", { name: "New plan from Jira" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "New plan from a Jira initiative",
    });

    // Staffing and buffer default to the tracker's baseline.
    expect(within(dialog).getByLabelText("Copy people from")).toHaveValue("p1");
    expect(within(dialog).getByLabelText("Buffer %")).toHaveValue(20);
    // Both plans are laid side by side before anything is created.
    expect(
      within(dialog).getByRole("rowheader", {
        name: "Current plan: Sheets plan",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("rowheader", { name: "Rebuilt from Jira" }),
    ).toBeInTheDocument();

    const name = within(dialog).getByLabelText("Project name");
    await user.clear(name);
    await user.type(name, "Season 4 from Jira");
    await user.click(
      within(dialog).getByRole("button", { name: "Create project" }),
    );

    expect(screen.getByText("Opened Season 4 from Jira")).toBeInTheDocument();
    expect(screen.getByText("Tasks 2")).toBeInTheDocument();
    expect(screen.getByText("Planned 2")).toBeInTheDocument();
    expect(screen.getByText("Trackers 2")).toBeInTheDocument();
    expect(screen.getByText("Linked A-1,A-2")).toBeInTheDocument();
  });

  it("lets the user map extra tags to a team specialization, and remembers them", async () => {
    const user = userEvent.setup();
    writeTagAliases([{ tag: "old", specialization: "Gone" }]);
    renderAt("/tracking/tr1");

    await user.click(
      screen.getByRole("button", { name: "New plan from Jira" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "New plan from a Jira initiative",
    });
    // Last import's mapping comes back, even for a specialization no team has.
    expect(within(dialog).getByLabelText("Tag 1")).toHaveValue("old");
    expect(
      within(dialog).getByLabelText("Specialization for tag 1"),
    ).toHaveValue("Gone");
    await user.click(
      within(dialog).getByRole("button", { name: "Remove tag 1" }),
    );
    expect(within(dialog).queryByLabelText("Tag 1")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Add tag" }));
    await user.type(within(dialog).getByLabelText("Tag 1"), "tools");
    // Only specializations somebody on a team has are offered.
    const select = within(dialog).getByLabelText("Specialization for tag 1");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["dev"]);

    // A label nothing recognises is offered, and mapping it is one click.
    const unknown = within(dialog).getByRole("button", {
      name: "Map tag tooling, on 1 issue",
    });
    await user.click(unknown);
    expect(within(dialog).getByLabelText("Tag 2")).toHaveValue("tooling");
    expect(
      within(dialog).getByLabelText("Specialization for tag 2"),
    ).toHaveFocus();
    expect(unknown).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "Create project" }),
    );
    expect(readTagAliases()).toEqual([
      { tag: "tools", specialization: "dev" },
      { tag: "tooling", specialization: "dev" },
    ]);
  });

  it("explains, rather than crashes on, a snapshot saved without child issues", async () => {
    const user = userEvent.setup();
    const s = state();
    // Older versions stored epics with no `children` at all.
    const old = s.trackers![0].snapshot!;
    s.trackers![0].snapshot = {
      ...old,
      epics: old.epics.map(({ children: _children, ...epic }) => epic),
    } as unknown as JiraSnapshot;
    render(
      <ToastProvider>
        <ConfirmProvider>
          <AppStoreProvider initial={s}>
            <MemoryRouter initialEntries={["/tracking/tr1"]}>
              <Routes>
                <Route path="/tracking/:id" element={<TrackerDetail />} />
              </Routes>
            </MemoryRouter>
          </AppStoreProvider>
        </ConfirmProvider>
      </ToastProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "New plan from Jira" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/no child issues/);
    expect(dialog).toHaveTextContent(/press Refresh/);
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("is unavailable on a tracker that was never refreshed", () => {
    const s = state();
    delete s.trackers![0].snapshot;
    render(
      <ToastProvider>
        <ConfirmProvider>
          <AppStoreProvider initial={s}>
            <MemoryRouter initialEntries={["/tracking/tr1"]}>
              <Routes>
                <Route path="/tracking/:id" element={<TrackerDetail />} />
              </Routes>
            </MemoryRouter>
          </AppStoreProvider>
        </ConfirmProvider>
      </ToastProvider>,
    );
    expect(
      screen.getByRole("button", { name: "New plan from Jira" }),
    ).toBeDisabled();
  });

  it("asks for an initiative link when started from the Projects page", async () => {
    const user = userEvent.setup();
    writeJiraSettings({
      baseUrl: SITE,
      email: "sam@example.com",
      apiToken: "token",
      hoursPerDay: 8,
      allowWrites: false,
    });
    renderAt("/");

    await user.click(
      screen.getByRole("button", { name: "From Jira initiative" }),
    );
    const dialog = screen.getByRole("dialog");
    const download = within(dialog).getByRole("button", { name: "Download" });
    expect(download).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText("Initiative link or key"),
      "not a link",
    );
    await user.click(download);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      /issue key|Jira site/,
    );
  });
});
