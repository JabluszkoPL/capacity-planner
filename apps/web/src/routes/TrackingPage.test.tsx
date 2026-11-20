/**
 * The Tracking tab, driven the way a person drives it.
 *
 * These go through the real store and the real router, so the assertions are
 * about what ends up on screen and in state rather than about props. Only the
 * network is stubbed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { AppState } from "@planner/core";
import { AppStoreProvider } from "@planner/client-runtime";
import { ConfirmProvider } from "../components/ui/ConfirmDialog";
import { ToastProvider, ToastHost } from "../components/ui/Toast";
import { TrackingPage } from "./TrackingPage";
import { TrackerDetail } from "./TrackerDetail";
import { writeJiraSettings } from "../lib/jiraSettings";

const SITE = "https://acme.atlassian.net";

// The transport is chosen at module level by createJiraTransport(); stub the
// module so every component under test gets the same fake.
const request = vi.fn();
vi.mock("../lib/jiraTransport", async () => {
  const actual = await vi.importActual<typeof import("../lib/jiraTransport")>(
    "../lib/jiraTransport",
  );
  return {
    ...actual,
    createJiraTransport: () => ({
      kind: "proxy" as const,
      description: "via the test",
      canWrite: false,
      request,
    }),
  };
});

function state(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "Season 4",
        startDate: "2026-09-07",
        planViewMode: "person",
        plan: null,
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
  };
}

function renderTracking(initial: AppState = state()) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={initial}>
          <MemoryRouter initialEntries={["/tracking"]}>
            <Routes>
              <Route path="/tracking" element={<TrackingPage />} />
              <Route path="/tracking/:id" element={<TrackerDetail />} />
            </Routes>
          </MemoryRouter>
          <ToastHost />
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

/** Minimal Jira that answers every call the refresh makes. */
function stubJira(childFields: Record<string, unknown> = {}) {
  request.mockImplementation((req: { path: string; body?: unknown }) => {
    if (req.path.startsWith("/rest/api/3/field")) {
      return Promise.resolve({ status: 200, body: [] });
    }
    if (req.path.startsWith("/rest/api/3/issue/ACME-1")) {
      return Promise.resolve({
        status: 200,
        body: {
          key: "ACME-1",
          fields: {
            summary: "Season 4",
            issuetype: { name: "Initiative" },
            status: {
              name: "In Progress",
              statusCategory: { key: "indeterminate" },
            },
            updated: "2026-09-13T09:00:00.000Z",
          },
        },
      });
    }
    const jql = String(
      (req.body as Record<string, unknown> | undefined)?.jql ?? "",
    );
    if (jql.includes("parent = ACME-1")) {
      return Promise.resolve({
        status: 200,
        body: {
          issues: [
            {
              key: "ACME-10",
              fields: {
                summary: "Meta loop",
                issuetype: { name: "Epic" },
                status: {
                  name: "In Progress",
                  statusCategory: { key: "indeterminate" },
                },
                updated: "2026-09-13T09:00:00.000Z",
              },
            },
          ],
        },
      });
    }
    if (jql.includes("parent in (ACME-10)")) {
      return Promise.resolve({
        status: 200,
        body: {
          issues: [
            {
              key: "ACME-11",
              fields: {
                summary: "Quest board",
                issuetype: { name: "Task" },
                parent: { key: "ACME-10" },
                status: {
                  name: "Done",
                  statusCategory: { key: "done" },
                },
                updated: "2026-09-13T09:00:00.000Z",
                ...childFields,
              },
            },
          ],
        },
      });
    }
    return Promise.resolve({ status: 200, body: { issues: [] } });
  });
}

describe("Tracking tab", () => {
  beforeEach(() => {
    localStorage.clear();
    request.mockReset();
  });

  it("starts with an empty state and a prompt to connect Jira", () => {
    renderTracking();
    expect(screen.getByText("No trackers yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Jira" }),
    ).toBeInTheDocument();
  });

  it("lists trackers in a portfolio table, with the add form on request", async () => {
    const user = userEvent.setup();
    const initial = state();
    initial.trackers = [
      {
        id: "tr1",
        name: "Season 4",
        initiativeUrl: `${SITE}/browse/ACME-1`,
        initiativeKey: "ACME-1",
        baseUrl: SITE,
      },
    ];
    renderTracking(initial);

    const row = screen.getByRole("row", { name: /ACME-1/ });
    expect(row).toHaveTextContent("Season 4");
    expect(row).toHaveTextContent("No baseline plan");
    expect(row).toHaveTextContent("Never refreshed");
    // Not connected, so there is nothing to refresh with.
    expect(screen.getByRole("button", { name: "Refresh all" })).toBeDisabled();

    // The add form is put away until asked for, and Escape puts it back.
    expect(screen.queryByLabelText("Initiative link or key")).toBeNull();
    const add = screen.getByRole("button", { name: "Add tracker" });
    await user.click(add);
    expect(add).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Initiative link or key")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Initiative link or key")).toBeNull();
  });

  it("creates a tracker from a pasted link and opens it", async () => {
    const user = userEvent.setup();
    renderTracking();

    await user.type(
      screen.getByLabelText("Initiative link or key"),
      `${SITE}/browse/ACME-1`,
    );
    await user.click(screen.getByRole("button", { name: "+ Add tracker" }));

    // Navigated to the detail route for the new tracker.
    await waitFor(() =>
      expect(screen.getByLabelText("Tracker name")).toHaveValue("ACME-1"),
    );
    expect(
      screen.getByRole("link", { name: /ACME-1 in Jira/ }),
    ).toHaveAttribute("href", `${SITE}/browse/ACME-1`);
  });

  it("refuses to refresh until Jira is connected", async () => {
    const user = userEvent.setup();
    renderTracking();
    await user.type(
      screen.getByLabelText("Initiative link or key"),
      `${SITE}/browse/ACME-1`,
    );
    await user.click(screen.getByRole("button", { name: "+ Add tracker" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled(),
    );
    expect(
      screen.getByText(/Connect Jira before refreshing/i),
    ).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes and auto-maps Jira tasks to planned tasks", async () => {
    writeJiraSettings({
      baseUrl: SITE,
      email: "sam@example.com",
      apiToken: "token",
      hoursPerDay: 8,
      allowWrites: false,
    });
    stubJira();
    const user = userEvent.setup();
    renderTracking();

    await user.type(
      screen.getByLabelText("Initiative link or key"),
      `${SITE}/browse/ACME-1`,
    );
    await user.click(screen.getByRole("button", { name: "+ Add tracker" }));
    await waitFor(() => screen.getByRole("button", { name: "Refresh" }));

    // No baseline yet: the panel says what is missing rather than a number.
    expect(
      screen.getByText(/No baseline project is linked/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(screen.getByText(/^Snapshot \d{4}-/)).toBeInTheDocument(),
    );

    // Epic names are irrelevant: the child task is matched by its own name.
    await user.selectOptions(screen.getByLabelText("Baseline plan"), "p1");
    await user.click(screen.getByRole("link", { name: "Issues" }));
    await user.click(await screen.findByRole("button", { name: "Meta loop" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("row", { name: /ACME-11/ })
          .querySelector(".plan-task-name"),
      ).toHaveTextContent("Quest board"),
    );
  });

  it("offers Jira's estimate for a skipped plan task, and copies it on confirm", async () => {
    writeJiraSettings({
      baseUrl: SITE,
      email: "sam@example.com",
      apiToken: "token",
      hoursPerDay: 8,
      allowWrites: false,
    });
    // Estimated in Jira after the plan was made: 5 days.
    stubJira({ timeoriginalestimate: 5 * 8 * 3600 });
    const initial = state();
    const task = initial.projects[0].epics[0].tasks[0];
    task.estimateDays = 0;
    task.excluded = true;
    // Mapped by the Jira import that created the skipped task.
    initial.trackers = [
      {
        id: "tr1",
        name: "Season 4",
        initiativeUrl: `${SITE}/browse/ACME-1`,
        initiativeKey: "ACME-1",
        baseUrl: SITE,
        projectId: "p1",
        taskMap: { "ACME-11": "t1" },
      },
    ];
    const user = userEvent.setup();
    renderTracking(initial);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    // The mapping and its estimate offer live on the Issues view.
    await user.click(screen.getByRole("link", { name: "Issues" }));

    await user.click(
      await screen.findByRole("button", { name: "Review estimates…" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Quest board");
    expect(dialog).toHaveTextContent("0 d, skipped → 5 d");
    expect(
      screen.getByLabelText("Copy the Jira estimate to Quest board"),
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Update 1 task" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText("Updated 1 estimate in Season 4"),
    ).toBeInTheDocument();
    // The baseline now agrees with Jira, so there is nothing left to offer.
    expect(
      screen.queryByRole("button", { name: "Review estimates…" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Meta loop" }));
    const row = screen.getByRole("row", { name: /ACME-11/ });
    expect(row).toHaveTextContent("5");
  });

  it("keeps the previous snapshot when a refresh fails", async () => {
    writeJiraSettings({
      baseUrl: SITE,
      email: "sam@example.com",
      apiToken: "token",
      hoursPerDay: 8,
      allowWrites: false,
    });
    stubJira();
    const user = userEvent.setup();
    renderTracking();

    await user.type(
      screen.getByLabelText("Initiative link or key"),
      `${SITE}/browse/ACME-1`,
    );
    await user.click(screen.getByRole("button", { name: "+ Add tracker" }));
    await waitFor(() => screen.getByRole("button", { name: "Refresh" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(screen.getByText(/^Snapshot \d{4}-/)).toBeInTheDocument(),
    );
    const snapshotAt = screen.getByText(/^Snapshot \d{4}-/).textContent;

    // Now Jira rejects the token.
    request.mockResolvedValue({
      status: 401,
      body: { errorMessages: ["Unauthorized"] },
    });
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(
        screen.getByText(/rejected your email and token/i),
      ).toBeInTheDocument(),
    );
    // The snapshot is still there — a stale one beats an empty panel.
    expect(screen.getByText(snapshotAt!)).toBeInTheDocument();
  });
});
