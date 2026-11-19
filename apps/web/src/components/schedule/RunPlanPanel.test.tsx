import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ToastProvider } from "../ui/Toast";
import { RunPlanPanel } from "./RunPlanPanel";

function initialState(): AppState {
  return {
    projects: [
      {
        id: "p1",
        name: "P",
        startDate: "2026-07-27",
        plan: null,
        planViewMode: "person",
        epics: [
          {
            id: "e1",
            name: "Build",
            tasks: [
              {
                id: "ta",
                name: "Build API",
                estimateDays: 2,
                specialization: "Frontend",
                excluded: false,
              },
              {
                id: "tb",
                name: "Deploy",
                estimateDays: 1,
                specialization: "DevOps",
                excluded: false,
              },
            ],
          },
          {
            id: "e2",
            name: "Launch",
            tasks: [
              {
                id: "tc",
                name: "Write docs",
                estimateDays: 1,
                specialization: "Frontend",
                excluded: false,
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
        members: [{ id: "m1", name: "Alice", specialization: "Frontend" }],
        offDays: {},
      },
    ],
  };
}

function Harness() {
  const { state } = useAppStore();
  return <RunPlanPanel project={state.projects[0]} />;
}

function renderPanel() {
  return render(
    <ToastProvider>
      <AppStoreProvider initial={initialState()}>
        <Harness />
      </AppStoreProvider>
    </ToastProvider>,
  );
}

describe("RunPlanPanel", () => {
  beforeEach(() => localStorage.clear());

  it("shows an empty state before a plan is run", () => {
    renderPanel();
    expect(screen.getByText(/No plan yet/i)).toBeInTheDocument();
  });

  it("runs the plan, showing assignments and an unassigned callout", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Run Plan/i }));

    // Assignable task appears (both as a gantt bar label and a table row).
    expect(screen.getAllByText("Build API").length).toBeGreaterThan(0);
    expect(screen.getByText("Estimated completion:")).toBeInTheDocument();
    // The DevOps task has no matching specialist → called out.
    expect(screen.getByText(/could not be scheduled/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Deploy — No team member with specialization "DevOps"/),
    ).toBeInTheDocument();
  });

  it("switches views without losing or re-running the plan", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Run Plan/i }));
    const lastRun = screen.getByText(/Last run/i).textContent;

    // Toggle to the task view.
    fireEvent.click(screen.getByRole("button", { name: /Grid by Task/i }));
    expect(
      screen.getByRole("button", { name: /Grid by Task/i }),
    ).toHaveAttribute("aria-pressed", "true");

    // Plan is still there and the run timestamp is unchanged (not re-run).
    expect(screen.getAllByText("Build API").length).toBeGreaterThan(0);
    expect(screen.getByText(/Last run/i).textContent).toBe(lastRun);
  });

  it("shows each epic's start and end in the epic grid", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Run Plan/i }));
    fireEvent.click(screen.getByRole("button", { name: /Grid by Epic/i }));

    // Alice does Build API (Mon–Tue), then Write docs (Wed).
    expect(screen.getByText("Jul 27 → Jul 28 · 1 task")).toBeInTheDocument();
    expect(screen.getByText("Jul 29 → Jul 29 · 1 task")).toBeInTheDocument();
    // Deploy couldn't be placed, so Build's real end is later than shown.
    expect(
      screen.getByText(/1 task unassigned — ends later than shown/),
    ).toBeInTheDocument();
  });

  it("filters the plan by task or epic name", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Run Plan/i }));
    const search = screen.getByLabelText("Filter plan by task or epic");

    // Epic name match keeps that epic's tasks only.
    fireEvent.change(search, { target: { value: "launch" } });
    expect(screen.getByText("Showing 1 of 2 tasks")).toBeInTheDocument();
    expect(screen.getAllByText("Write docs").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Build API")).toHaveLength(0);

    // Task name match.
    fireEvent.change(search, { target: { value: "api" } });
    expect(screen.getAllByText("Build API").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Write docs")).toHaveLength(0);

    fireEvent.change(search, { target: { value: "nothing" } });
    expect(
      screen.getByText("No tasks or epics match “nothing”."),
    ).toBeInTheDocument();
  });
});
