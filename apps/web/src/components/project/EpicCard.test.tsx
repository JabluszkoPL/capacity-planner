import { describe, it, expect, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AppState } from "@planner/core";
import { AppStoreProvider, useAppStore } from "@planner/client-runtime";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { EpicCard } from "./EpicCard";

function baseState(): AppState {
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
            name: "Epic One",
            tasks: [
              {
                id: "t1",
                name: "T1",
                estimateDays: 2,
                specialization: "FE",
                excluded: false,
              },
              {
                id: "t2",
                name: "T2",
                estimateDays: 5,
                specialization: "BE",
                excluded: true,
              },
            ],
          },
        ],
      },
    ],
    teams: [{ id: "t1", name: "Team 1", members: [], offDays: {} }],
  };
}

function Harness() {
  const { state } = useAppStore();
  const project = state.projects[0];
  const idx = project.epics.findIndex((e) => e.id === "e1");
  const epic = project.epics[idx];
  const [collapsed, setCollapsed] = useState(false);
  if (!epic) return <div>epic deleted</div>;
  return (
    <>
      <div data-testid="epic-name">{epic.name}</div>
      <EpicCard
        projectId="p1"
        epic={epic}
        isFirst={idx === 0}
        isLast={idx === project.epics.length - 1}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />
    </>
  );
}

function renderCard(initial = baseState()) {
  return render(
    <ConfirmProvider>
      <AppStoreProvider initial={initial}>
        <Harness />
      </AppStoreProvider>
    </ConfirmProvider>,
  );
}

describe("EpicCard", () => {
  beforeEach(() => localStorage.clear());

  it("shows active task count and day total that exclude skipped tasks", () => {
    renderCard();
    // Only T1 (2d) is active; T2 (5d) is skipped.
    expect(screen.getByText("1 task · 1 skipped")).toBeInTheDocument();
    expect(screen.getByText("2 days")).toBeInTheDocument();
  });

  it("adds a task from the epic header", () => {
    renderCard();
    expect(screen.getAllByLabelText("Task name")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Add task to Epic One" }),
    );
    expect(screen.getAllByLabelText("Task name")).toHaveLength(3);
  });

  it("adds a task from the row under the table", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    expect(screen.getAllByLabelText("Task name")).toHaveLength(3);
  });

  it("renames the epic on blur", () => {
    renderCard();
    const input = screen.getByLabelText("Epic name");
    fireEvent.change(input, { target: { value: "Renamed Epic" } });
    expect(screen.getByTestId("epic-name")).toHaveTextContent("Epic One");
    fireEvent.blur(input);
    expect(screen.getByTestId("epic-name")).toHaveTextContent("Renamed Epic");
  });

  it("asks for confirmation before deleting the epic", async () => {
    renderCard();
    // Cancel keeps the epic.
    fireEvent.click(
      screen.getByRole("button", { name: "Delete epic Epic One" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
    expect(screen.queryByText("epic deleted")).toBeNull();

    // Confirm removes it.
    fireEvent.click(
      screen.getByRole("button", { name: "Delete epic Epic One" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByText("epic deleted")).toBeInTheDocument(),
    );
  });

  it("toggles epic assignment via a member chip", () => {
    const state = baseState();
    state.teams[0].members = [
      { id: "m1", name: "Ben", specialization: "BE" },
      { id: "m2", name: "Chen", specialization: "BE" },
    ];
    renderCard(state);

    const benChip = screen.getByRole("button", {
      name: "Assign Ben to epic Epic One",
    });
    expect(benChip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(benChip);

    const assignedChip = screen.getByRole("button", {
      name: "Unassign Ben from epic Epic One",
    });
    expect(assignedChip).toHaveAttribute("aria-pressed", "true");
  });

  it("collapses and expands the task table via the caret", () => {
    renderCard();
    expect(screen.getAllByLabelText("Task name")).toHaveLength(2);
    // Collapse hides the task rows.
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse epic Epic One" }),
    );
    expect(screen.queryAllByLabelText("Task name")).toHaveLength(0);
    // Expand brings them back.
    fireEvent.click(
      screen.getByRole("button", { name: "Expand epic Epic One" }),
    );
    expect(screen.getAllByLabelText("Task name")).toHaveLength(2);
  });

  it("reorders tasks with the ▼ control", () => {
    renderCard();
    const before = screen
      .getAllByLabelText("Task name")
      .map((i) => (i as HTMLInputElement).value);
    expect(before).toEqual(["T1", "T2"]);
    // Move the first task down.
    fireEvent.click(screen.getAllByLabelText("Move task down")[0]);
    const after = screen
      .getAllByLabelText("Task name")
      .map((i) => (i as HTMLInputElement).value);
    expect(after).toEqual(["T2", "T1"]);
  });
});
