import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom";
import type { AppState } from "@planner/core";
import { AppStoreProvider } from "@planner/client-runtime";
import { ConfirmProvider } from "../components/ui/ConfirmDialog";
import { ToastProvider, ToastHost } from "../components/ui/Toast";
import { ProjectsDashboard } from "./ProjectsDashboard";

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
  beforeEach(() => localStorage.clear());

  it("renders an empty state when there are no projects", () => {
    renderDashboard(emptyState());
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });

  it("creating a project navigates to its detail route immediately", async () => {
    const user = userEvent.setup();
    renderDashboard(emptyState());
    await user.type(screen.getByLabelText("Name"), "New Plan");
    await user.click(screen.getByRole("button", { name: "+ Create project" }));
    expect(await screen.findByText(/detail route for/)).toBeInTheDocument();
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
