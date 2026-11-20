import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import type { AppState } from "@planner/core";
import { AppStoreProvider } from "@planner/client-runtime";
import { ConfirmProvider } from "../components/ui/ConfirmDialog";
import { ToastProvider, ToastHost } from "../components/ui/Toast";
import { ProjectsDashboard } from "./ProjectsDashboard";

const download = vi.hoisted(() => vi.fn());
vi.mock("../lib/download", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/download")>()),
  downloadStateJson: download,
}));

function DetailStub() {
  const { id } = useParams();
  return <div>detail route for {id}</div>;
}

function emptyState(): AppState {
  return {
    projects: [],
    teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
  };
}

function oneProject(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "Alpha",
        startDate: "2026-07-27",
        plan: null,
        planViewMode: "person",
        epics: [],
      },
    ],
    teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
  };
}

function threeProjects(): AppState {
  const base = oneProject().projects[0];
  return {
    projects: [
      { ...base, id: "p1", name: "Alpha", teamInclusions: [{ teamId: "t1" }] },
      { ...base, id: "p2", name: "Beta", teamInclusions: [{ teamId: "t2" }] },
      {
        ...base,
        id: "p3",
        name: "Alphabet",
        teamInclusions: [{ teamId: "t2" }],
      },
    ],
    teams: [
      { id: "t1", name: "Team 1", members: [], offDays: {} },
      { id: "t2", name: "Team 2", members: [], offDays: {} },
    ],
  };
}

function renderDashboard(initial: AppState) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <AppStoreProvider initial={initial}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route path="/" element={<ProjectsDashboard />} />
              <Route path="/project/:id" element={<DetailStub />} />
            </Routes>
          </MemoryRouter>
          <ToastHost />
        </AppStoreProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe("ProjectsDashboard", () => {
  beforeEach(() => {
    localStorage.clear();
    download.mockReset();
  });

  it("renders an empty state when there are no projects", () => {
    renderDashboard(emptyState());
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });

  it("creating a project navigates to its detail route immediately", async () => {
    const user = userEvent.setup();
    renderDashboard(emptyState());
    // The form lives in a modal opened from the header.
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const dialog = screen.getByRole("dialog", { name: "New project" });
    // Focus moves into the form, so typing goes straight into the name.
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    await user.keyboard("New Plan");
    await user.click(
      within(dialog).getByRole("button", { name: "Create project" }),
    );
    expect(await screen.findByText(/detail route for/)).toBeInTheDocument();
  });

  it("the new-project modal cancels without creating anything", async () => {
    const user = userEvent.setup();
    renderDashboard(emptyState());
    await user.click(screen.getByRole("button", { name: "Create a project" }));
    await user.type(screen.getByLabelText("Name"), "Draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });

  it("filters cards by name and by team", async () => {
    const user = userEvent.setup();
    renderDashboard(threeProjects());
    // Card titles are role="button" (Enter opens), so find them by class.
    const titles = () =>
      [...document.querySelectorAll(".project-card-title")].map(
        (h) => h.textContent,
      );
    expect(titles()).toEqual(["Alpha", "Beta", "Alphabet"]);

    await user.type(
      screen.getByRole("searchbox", { name: "Search projects" }),
      "alp",
    );
    expect(titles()).toEqual(["Alpha", "Alphabet"]);
    expect(screen.getByText("2 of 3 projects")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by team" }),
      "Team 2",
    );
    expect(titles()).toEqual(["Alphabet"]);

    await user.type(
      screen.getByRole("searchbox", { name: "Search projects" }),
      "zzz",
    );
    expect(screen.getByText("No matching projects")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titles()).toEqual(["Alpha", "Beta", "Alphabet"]);
  });

  it("exports a single project from its card", async () => {
    const user = userEvent.setup();
    renderDashboard(threeProjects());
    await user.click(screen.getByRole("button", { name: "Export Beta" }));
    expect(download).toHaveBeenCalledTimes(1);
    const [exported, filename] = download.mock.calls[0] as [AppState, string];
    expect(exported.projects.map((p) => p.name)).toEqual(["Beta"]);
    expect(filename).toMatch(/\.json$/);
    expect(screen.getByText('Exported "Beta"')).toBeInTheDocument();
  });

  it("copy adds a '(Copy)' card and leaves the original intact", async () => {
    const user = userEvent.setup();
    renderDashboard(oneProject());
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(
      await screen.findByRole("button", { name: "Delete Alpha (Copy)" }),
    ).toBeInTheDocument();
    // Original still present and unchanged.
    expect(
      screen.getByRole("button", { name: "Delete Alpha" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Project copied")).toBeInTheDocument();
  });

  it("delete asks for confirmation and only removes on confirm", async () => {
    const user = userEvent.setup();
    renderDashboard(oneProject());

    // Cancel path: card stays.
    await user.click(screen.getByRole("button", { name: "Delete Alpha" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Delete Alpha" }),
    ).toBeInTheDocument();

    // Confirm path: card removed.
    await user.click(screen.getByRole("button", { name: "Delete Alpha" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete Alpha" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });
});
